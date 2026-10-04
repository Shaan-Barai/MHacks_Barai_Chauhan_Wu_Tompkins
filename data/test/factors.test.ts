import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  COMMON_WASTE_FACTORS,
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
  const rows = csvObjects('menu_waste_factors_EastQuad.csv');
  assert.equal(rows.length, 26);
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
      table: 'east-quad',
    });
  });
  assert.equal(new Set(WASTE_FACTORS.map((f) => f.factorKey)).size, 26);
});

test('factors: score is 0.19*C + 1.50*W with no nutrition term', () => {
  const rows = csvObjects('menu_waste_factors_EastQuad.csv');
  for (const f of WASTE_FACTORS) {
    const expected = 0.19 * f.kgCo2ePerKg + 1.5 * f.waterM3PerKg;
    assert.ok(Math.abs(f.impactUsdPerKg - expected) <= 0.005 + 1e-9, `${f.food}: ${f.impactUsdPerKg} vs ${expected}`);
    assert.equal(f.largestFactor, 0.19 * f.kgCo2ePerKg >= 1.5 * f.waterM3PerKg ? 'carbon' : 'water');
  }
  // No nutrition columns feed the waste file.
  for (const col of Object.keys(rows[0]!)) {
    assert.doesNotMatch(col, /nutri|^O_|kcal|quality/i, `nutrition column ${col} in the waste file`);
  }
  assert.equal(WASTE_FACTORS_VERSION, 'waste-factors-v5');
});

test('factors: generated nutrition table matches menu_nutrition_factors.csv', () => {
  const rows = csvObjects('menu_nutrition_factors_EastQuad.csv');
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
    buildTables(w: string, n: string, c?: string): unknown;
    renderModule(t: unknown): string;
  };
  const expected = gen.renderModule(
    gen.buildTables(
      readFileSync(join(repoRoot, 'menu_waste_factors_EastQuad.csv'), 'utf8'),
      readFileSync(join(repoRoot, 'menu_nutrition_factors_EastQuad.csv'), 'utf8'),
      readFileSync(join(repoRoot, 'menu_waste_factors_500.csv'), 'utf8'),
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
  assert.equal(steak.table, 'east-quad');
  assert.equal(findWasteFactor('Definitely Not A Food'), null);
  assert.equal(findNutritionFactor('Pepperoni Pizza')?.nutrientDaysPerKg, 0.69);
  assert.equal(findNutritionFactor('Mystery Stew'), null);
  assert.match(findFactorMenuText('Farro')?.visibleComponents ?? '', /grain kernels/);
  assert.equal(findFactorMenuText('Baked Sweet Potatoes')?.visibleComponents, null);
});

test('factors: common-foods fallback (menu_waste_factors_500.csv) only for items the hall table lacks', () => {
  // On both tables: the hall row wins.
  const pizza = findWasteFactor('Pepperoni Pizza');
  assert.equal(pizza?.table, 'east-quad');
  // Only in the 500-food table: the fallback supplies it, labeled.
  const eggs = findWasteFactor('Scrambled Eggs');
  assert.ok(eggs, 'Scrambled Eggs comes from the common-foods table');
  assert.equal(eggs.table, 'common-500');
  assert.equal(eggs.weightGPerCm2, 1.0);
  assert.equal(eggs.kgCo2ePerKg, 5.14);
  assert.equal(eggs.waterM3PerKg, 0.715);
  // No nutrition rows in the fallback.
  assert.equal(findNutritionFactor('Scrambled Eggs'), null);
  // The fallback never duplicates a hall key.
  const hallKeys = new Set(WASTE_FACTORS.map((f) => f.factorKey));
  assert.ok(COMMON_WASTE_FACTORS.every((f) => !hallKeys.has(f.factorKey) && f.table === 'common-500'));
  assert.ok(COMMON_WASTE_FACTORS.length >= 490);
});
