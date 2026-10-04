#!/usr/bin/env node
/**
 * Generates data/src/factors.generated.ts from the factor CSVs in factors/
 * (menu_waste_factors_EastQuad.csv, menu_nutrition_factors_EastQuad.csv,
 * menu_waste_factors_halal_bros.csv, menu_waste_factors_500.csv), which stay
 * the source of truth. Run from data/:  npm run factors
 *
 * The output is deterministic, and data/test/factors.test.ts fails when the
 * committed module no longer matches the CSVs.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const factorsDir = join(here, '..', '..', 'factors');
const outPath = join(here, '..', 'src', 'factors.generated.ts');

/** Minimal RFC-4180 parser: quoted fields, "" escapes, LF/CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); if (row.some((f) => f !== '')) rows.push(row); }
  const [header, ...body] = rows;
  return body.map((fields) => Object.fromEntries(header.map((h, i) => [h.trim(), (fields[i] ?? '').trim()])));
}

/** Same rule as data/src/ids.ts slugifyName (factorKeyFor). */
export function slug(name) {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function num(row, col, file) {
  const n = Number(row[col]);
  if (row[col] === '' || !Number.isFinite(n) || n < 0) {
    throw new Error(`${file}: "${row.food}" has an invalid ${col} (${JSON.stringify(row[col])})`);
  }
  return n;
}

const optNum = (v) => (v === '' ? null : Number(v));
const optStr = (v) => (v === '' ? null : v);

/** One CSV row → WasteFactor (shared by the hall table and the common-foods fallback). */
function wasteFactorRow(r, file, table) {
  const largest = r.largest_factor;
  if (largest !== 'carbon' && largest !== 'water') {
    throw new Error(`${file}: "${r.food}" largest_factor must be carbon or water`);
  }
  return {
    factorKey: slug(r.food),
    food: r.food,
    station: r.station,
    weightGPerCm2: num(r, 'weight_g_per_cm2', file),
    kgCo2ePerKg: num(r, 'C_kg_co2e_per_kg', file),
    waterM3PerKg: num(r, 'W_water_m3_per_kg', file),
    impactUsdPerKg: num(r, 'impact_score_usd_per_kg', file),
    largestFactor: largest,
    table,
  };
}

export function buildTables(wasteCsv, nutritionCsv, commonCsv = '', halalBrosCsv = '') {
  const waste = parseCsv(wasteCsv).map((r) => {
    return {
      factor: wasteFactorRow(r, 'menu_waste_factors_EastQuad.csv', 'east-quad'),
      text: {
        factorKey: slug(r.food),
        food: r.food,
        station: r.station,
        visibleComponents: optStr(r.gemini_visible_components),
        ingredients: optStr(r.gemini_ingredients),
        allergens: optStr(r.allergens_listed),
        labelServingG: optNum(r.label_serving_g),
        menuCo2Label: optStr(r.menu_co2_label),
      },
    };
  });
  const keys = new Set();
  for (const { factor } of waste) {
    if (keys.has(factor.factorKey)) throw new Error(`duplicate factorKey ${factor.factorKey}`);
    keys.add(factor.factorKey);
  }
  const nutrition = parseCsv(nutritionCsv).map((r) => ({
    factorKey: slug(r.food),
    nutrientDaysPerKg: num(r, 'O_nutrient_days_per_kg', 'menu_nutrition_factors_EastQuad.csv'),
    kcalPerKg: num(r, 'kcal_per_kg', 'menu_nutrition_factors_EastQuad.csv'),
  }));
  for (const n of nutrition) {
    if (!keys.has(n.factorKey)) throw new Error(`menu_nutrition_factors_EastQuad.csv: ${n.factorKey} has no waste-factor row`);
  }
  // Halal Bros: a second restaurant table (waste + nutrition columns in one file), checked after East Quad.
  const halalRows = halalBrosCsv ? parseCsv(halalBrosCsv) : [];
  const halalFactors = halalRows.map((r) => wasteFactorRow(r, 'menu_waste_factors_halal_bros.csv', 'halal-bros'));
  for (const f of halalFactors) {
    if (keys.has(f.factorKey)) throw new Error(`menu_waste_factors_halal_bros.csv: factorKey ${f.factorKey} is already in another table`);
    keys.add(f.factorKey);
  }
  const halalNutrition = halalRows.map((r) => ({
    factorKey: slug(r.food),
    nutrientDaysPerKg: num(r, 'O_nutrient_days_per_kg', 'menu_waste_factors_halal_bros.csv'),
    kcalPerKg: num(r, 'kcal_per_kg', 'menu_waste_factors_halal_bros.csv'),
  }));
  // Fallback: 500 common foods, used only for menu items the hall table doesn't cover.
  const commonKeys = new Set();
  const commonFactors = [];
  for (const r of commonCsv ? parseCsv(commonCsv) : []) {
    const f = wasteFactorRow(r, 'menu_waste_factors_500.csv', 'common-500');
    if (commonKeys.has(f.factorKey)) throw new Error(`menu_waste_factors_500.csv: duplicate factorKey ${f.factorKey}`);
    commonKeys.add(f.factorKey);
    if (!keys.has(f.factorKey)) commonFactors.push(f);
  }
  return {
    wasteFactors: waste.map((w) => w.factor),
    halalBrosWasteFactors: halalFactors,
    halalBrosNutritionFactors: halalNutrition,
    commonWasteFactors: commonFactors,
    menuText: waste.map((w) => w.text),
    nutritionFactors: nutrition,
  };
}

export function renderModule(tables) {
  const j = (v) => JSON.stringify(v, null, 2);
  return `// GENERATED by data/scripts/generate-factors.mjs. Do not edit by hand.
// Source of truth: menu_waste_factors_EastQuad.csv, menu_nutrition_factors_EastQuad.csv,
// menu_waste_factors_halal_bros.csv and menu_waste_factors_500.csv (common-foods fallback) in factors/.
// Regenerate with \`npm run factors\` in data/.

import type { NutritionFactor, WasteFactor } from '../../contracts/types.js';

/** Plate-photo text and label metadata per factor row (not part of the score). */
export interface WasteFactorMenuText {
  factorKey: string;
  food: string;
  station: string;
  /** Gemini's visible-components description; null when Gemini had no source for the food. */
  visibleComponents: string | null;
  ingredients: string | null;
  allergens: string | null;
  labelServingG: number | null;
  menuCo2Label: string | null;
}

/** menu_waste_factors_EastQuad.csv rows (the hall's own table; wins). Score = 0.19*C + 1.50*W (no nutrition). */
export const WASTE_FACTORS: WasteFactor[] = ${j(tables.wasteFactors)};

/**
 * menu_waste_factors_halal_bros.csv rows (Halal Bros 2 Go, Ann Arbor), checked after East Quad.
 * Its nutrition labels are made-up test data (see the CSV's notes).
 */
export const HALAL_BROS_WASTE_FACTORS: WasteFactor[] = ${j(tables.halalBrosWasteFactors ?? [])};

/** Nutrition columns of menu_waste_factors_halal_bros.csv. Reported separately; never part of the score. */
export const HALAL_BROS_NUTRITION_FACTORS: NutritionFactor[] = ${j(tables.halalBrosNutritionFactors ?? [])};

/**
 * menu_waste_factors_500.csv rows not already in the hall table: fallback for menu items the hall
 * table doesn't cover (exact factorKey match). No nutrition rows.
 */
export const COMMON_WASTE_FACTORS: WasteFactor[] = ${j(tables.commonWasteFactors ?? [])};

/** menu_nutrition_factors_EastQuad.csv rows. Reported separately; never part of the score. */
export const NUTRITION_FACTORS: NutritionFactor[] = ${j(tables.nutritionFactors)};

export const WASTE_FACTOR_MENU_TEXT: WasteFactorMenuText[] = ${j(tables.menuText)};
`;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const tables = buildTables(
    readFileSync(join(factorsDir, 'menu_waste_factors_EastQuad.csv'), 'utf8'),
    readFileSync(join(factorsDir, 'menu_nutrition_factors_EastQuad.csv'), 'utf8'),
    readFileSync(join(factorsDir, 'menu_waste_factors_500.csv'), 'utf8'),
    readFileSync(join(factorsDir, 'menu_waste_factors_halal_bros.csv'), 'utf8'),
  );
  writeFileSync(outPath, renderModule(tables), 'utf8');
  console.log(`Wrote ${outPath}: ${tables.wasteFactors.length} waste factors (+${tables.halalBrosWasteFactors.length} Halal Bros, +${tables.commonWasteFactors.length} common-food fallbacks), ${tables.nutritionFactors.length} nutrition factors.`);
}
