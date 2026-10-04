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
      densityGPerCm3: r.density_g_per_cm3 === '' ? null : Number(r.density_g_per_cm3),
    });
  });
  assert.equal(new Set(WASTE_FACTORS.map((f) => f.factorKey)).size, 26);
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
  assert.equal(WASTE_FACTORS_VERSION, 'waste-factors-v3');
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

test('factors: density (IT_4 I7) is positive or null, and every row cites a source', () => {
  const rows = csvObjects('menu_waste_factors.csv');
  for (const r of rows) {
    assert.ok(r.density_source && r.density_source.length > 10, `${r.food}: density_source missing`);
    if (r.density_g_per_cm3 === '') assert.match(r.density_source, /^none: /, `${r.food}: blank density must say why`);
    else assert.match(r.density_source, /FAO\/INFOODS|USDA/, `${r.food}: density must cite FAO/INFOODS or USDA`);
  }
  for (const f of WASTE_FACTORS) {
    if (f.densityGPerCm3 !== null) assert.ok(f.densityGPerCm3 > 0.05 && f.densityGPerCm3 < 1.5, `${f.food}: ${f.densityGPerCm3}`);
  }
  assert.equal(findWasteFactor('Sticky Rice')?.densityGPerCm3, 0.73);
  assert.equal(findWasteFactor('Pepperoni Pizza')?.densityGPerCm3, null);
  assert.equal(WASTE_FACTORS.filter((f) => f.densityGPerCm3 === null).length, 4);
  assert.match(findFactorMenuText('Lettuce')?.densitySource ?? '', /USDA SR Legacy 11252/);
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
