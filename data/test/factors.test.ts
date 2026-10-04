import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  NUTRITION_FACTORS,
  WASTE_FACTORS,
  WASTE_FACTORS_VERSION,
  factorKeyFor,
  findFactorMenuText,
  findNutritionFactor,
  findWasteFactor,
  readCsvRecords,
} from '../src/index.js';

// dist/data/test -> repo root
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');

function csvObjects(file: string): Array<Record<string, string>> {
  const rows = readCsvRecords(readFileSync(join(repoRoot, file), 'utf8'));
  const header = rows.shift()!.fields.map((f) => f.trim());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r.fields[i] ?? '').trim()])));
}

test('factors: factorKeyFor slugs display names', () => {
  assert.equal(factorKeyFor('Ancho Flank Steak'), 'ancho-flank-steak');
  assert.equal(factorKeyFor('  Michigan Farmers 4 Bean Stew '), 'michigan-farmers-4-bean-stew');
  assert.equal(factorKeyFor('Crème Brûlée & Co.'), 'creme-brulee-co');
  assert.equal(factorKeyFor('---'), '');
});

test('factors: generated waste table matches menu_waste_factors.csv', () => {
  const rows = csvObjects('menu_waste_factors.csv');
  assert.equal(rows.length, 23);
  assert.equal(WASTE_FACTORS.length, rows.length);
  rows.forEach((r, i) => {
    const f = WASTE_FACTORS[i]!;
    assert.deepEqual(f, {
      factorKey: factorKeyFor(r.food!),
      food: r.food,
      station: r.station,
      weightGPerCm2: Number(r.weight_g_per_cm2),
      kgCo2ePerKg: Number(r.C_kg_co2e_per_kg),
      waterM3PerKg: Number(r.W_water_m3_per_kg),
      impactUsdPerKg: Number(r.impact_score_usd_per_kg),
      largestFactor: r.largest_factor,
    });
  });
  assert.equal(new Set(WASTE_FACTORS.map((f) => f.factorKey)).size, 23);
});

test('factors: score is 0.19*C + 1.50*W with no nutrition term', () => {
  const rows = csvObjects('menu_waste_factors.csv');
  for (const f of WASTE_FACTORS) {
    const expected = 0.19 * f.kgCo2ePerKg + 1.5 * f.waterM3PerKg;
    assert.ok(Math.abs(f.impactUsdPerKg - expected) <= 0.005 + 1e-9, `${f.food}: ${f.impactUsdPerKg} vs ${expected}`);
    assert.equal(f.largestFactor, 0.19 * f.kgCo2ePerKg >= 1.5 * f.waterM3PerKg ? 'carbon' : 'water');
  }
  // No nutrition columns feed the waste file.
  for (const col of Object.keys(rows[0]!)) {
    assert.doesNotMatch(col, /nutri|^O_|kcal|quality/i, `nutrition column ${col} in the waste file`);
  }
  assert.equal(WASTE_FACTORS_VERSION, 'waste-factors-v2');
});

test('factors: generated nutrition table matches menu_nutrition_factors.csv', () => {
  const rows = csvObjects('menu_nutrition_factors.csv');
  assert.equal(NUTRITION_FACTORS.length, rows.length);
  rows.forEach((r, i) => {
    assert.deepEqual(NUTRITION_FACTORS[i], {
      factorKey: factorKeyFor(r.food!),
      nutrientDaysPerKg: Number(r.O_nutrient_days_per_kg),
      kcalPerKg: Number(r.kcal_per_kg),
    });
  });
  const wasteKeys = new Set(WASTE_FACTORS.map((f) => f.factorKey));
  for (const n of NUTRITION_FACTORS) assert.ok(wasteKeys.has(n.factorKey));
});

test('factors: committed factors.generated.ts is up to date with the CSVs', async () => {
  const scriptUrl = pathToFileURL(join(repoRoot, 'data', 'scripts', 'generate-factors.mjs')).href;
  const gen = (await import(scriptUrl)) as {
    buildTables(w: string, n: string): unknown;
    renderModule(t: unknown): string;
  };
  const expected = gen.renderModule(
    gen.buildTables(
      readFileSync(join(repoRoot, 'menu_waste_factors.csv'), 'utf8'),
      readFileSync(join(repoRoot, 'menu_nutrition_factors.csv'), 'utf8'),
    ),
  );
  const actual = readFileSync(join(repoRoot, 'data', 'src', 'factors.generated.ts'), 'utf8');
  assert.equal(actual, expected, 'run `npm run factors` in data/ to regenerate');
});

test('factors: lookups by display name', () => {
  const steak = findWasteFactor('Ancho Flank Steak');
  assert.ok(steak);
  assert.equal(steak.impactUsdPerKg, 27.91);
  assert.equal(steak.largestFactor, 'carbon');
  assert.equal(findWasteFactor('ancho flank steak')?.factorKey, 'ancho-flank-steak');
  assert.equal(findWasteFactor('Teriyaki Salmon'), null);
  assert.equal(findNutritionFactor('Pepperoni Pizza')?.nutrientDaysPerKg, 0.69);
  assert.equal(findNutritionFactor('Mystery Stew'), null);
  assert.match(findFactorMenuText('Farro')?.visibleComponents ?? '', /grain kernels/);
  assert.equal(findFactorMenuText('Baked Sweet Potatoes')?.visibleComponents, null);
});

/** Round half up to cents, as the CSV does (1.605 → 1.61). */
const cents = (x: number): number => Math.floor(x * 100 + 0.5 + 1e-9) / 100;

test('factors: CSV carbon/water dollars and score are 0.19·C and 1.50·W rounded half up; largest factor is carbon or water', () => {
  for (const r of csvObjects('menu_waste_factors.csv')) {
    const C = Number(r.C_kg_co2e_per_kg);
    const W = Number(r.W_water_m3_per_kg);
    assert.equal(Number(r.carbon_usd_per_kg), cents(0.19 * C), `${r.food} carbon`);
    assert.equal(Number(r.water_usd_per_kg), cents(1.5 * W), `${r.food} water`);
    // The score is rounded from the unrounded sum, never from the rounded parts.
    assert.equal(Number(r.impact_score_usd_per_kg), cents(0.19 * C + 1.5 * W), `${r.food} score`);
    assert.ok(['carbon', 'water'].includes(r.largest_factor!), `${r.food} largest_factor`);
  }
});

test('factors: menu_waste_factors_README "Results at a glance" matches the CSV', () => {
  const readme = readFileSync(join(repoRoot, 'menu_waste_factors_README.md'), 'utf8');
  const glance = readme.slice(readme.indexOf('## Results at a glance'), readme.indexOf('## Caveats'));
  const sorted = [...WASTE_FACTORS].sort((a, b) => b.impactUsdPerKg - a.impactUsdPerKg);
  const top = sorted[0]!;
  assert.ok(glance.includes(`${top.food}, ${top.impactUsdPerKg.toFixed(2)}`), 'highest score');
  for (const f of sorted.slice(1, 4)) assert.ok(glance.includes(`${f.food} (${f.impactUsdPerKg.toFixed(2)})`), `next: ${f.food}`);
  const lowest = sorted.at(-1)!;
  assert.ok(glance.includes(`${lowest.food}, ${lowest.impactUsdPerKg.toFixed(2)}`), 'lowest score');
  const water = WASTE_FACTORS.filter((f) => f.largestFactor === 'water').length;
  assert.ok(glance.includes(`water for ${water} foods, carbon for ${WASTE_FACTORS.length - water}`), 'largest-factor counts');
  // Nutrition is reported separately and never as part of the score.
  assert.match(readme, /## Nutrition lost \(not part of the score\)/);
  assert.doesNotMatch(readme, /claude_/);
});
