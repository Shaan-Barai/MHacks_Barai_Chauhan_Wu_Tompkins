import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildDemoPortions,
  buildDemoSeed,
  DEMO_GEOMETRY,
  DEMO_PORTION_RANGES,
  portionRole,
  type DemoSeed,
} from '../src/seed/generate.js';
import {
  buildVocabulary,
  checkGeometryCompatibility,
  findVocabulary,
  planMenuRevision,
  resolveReferencePortion,
  validateReferencePortion,
  WASTE_FACTORS,
  factorKeyFor,
  findFactorMenuText,
  findWasteFactor,
} from '../src/index.js';

function loadCheckedInSeed(): DemoSeed {
  // dist/data/test -> data/seed/demo-seed.json
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, '..', '..', '..', '..', 'data', 'seed', 'demo-seed.json');
  return JSON.parse(readFileSync(path, 'utf8')) as DemoSeed;
}

test('seed: 3 days x 3 meals, labeled as demo data, deterministic', () => {
  const seed = buildDemoSeed();
  assert.equal(seed.demo, true);
  assert.match(seed.label, /DEMO DATA/);
  assert.equal(seed.menus.length, 9);
  assert.equal(new Set(seed.menus.map((menu) => menu.service.serviceDate)).size, 3);
  assert.equal(new Set(seed.menus.map((menu) => menu.service.serviceId)).size, 9);
  // regenerating produces identical output
  assert.deepEqual(buildDemoSeed(), seed);
});

test('seed: every reference portion validates and shares the agreed geometry', () => {
  const seed = buildDemoSeed();
  const itemCount = seed.menus.reduce((sum, menu) => sum + menu.items.length, 0);
  assert.equal(seed.referencePortions.length, itemCount);

  for (const ref of seed.referencePortions) {
    validateReferencePortion(ref);
    assert.equal(ref.source, 'manual_area');
    assert.deepEqual(ref.geometry, DEMO_GEOMETRY);
    assert.deepEqual(checkGeometryCompatibility(DEMO_GEOMETRY, ref.geometry), {
      compatible: true,
      reasons: [],
    });
  }

  // every menu item has exactly one resolvable baseline, every baseline an item
  const itemIds = new Set(seed.menus.flatMap((menu) => menu.items.map((item) => item.itemId)));
  for (const itemId of itemIds) {
    const lookup = resolveReferencePortion(seed.referencePortions, itemId);
    assert.ok(lookup.found, `missing baseline for ${itemId}`);
  }
  for (const ref of seed.referencePortions) {
    assert.ok(itemIds.has(ref.itemId), `baseline for unknown item ${ref.itemId}`);
  }
});

test('seed: bundles resolve by hall/date/service and survive the revision planner', () => {
  const seed = buildDemoSeed();
  const lookup = findVocabulary(seed.menus, seed.hallId, '2026-10-02', 'dinner');
  assert.ok(lookup.found);
  assert.ok(lookup.vocabulary.items.length >= 4);

  for (const bundle of seed.menus) {
    buildVocabulary(bundle); // never throws
    assert.equal(planMenuRevision(bundle, bundle).action, 'unchanged');
    assert.equal(bundle.service.hallTimezone, 'America/Detroit');
    assert.equal(bundle.service.menuVersion, 1);
  }
});

test('seed: the checked-in JSON file matches the generator output', () => {
  assert.deepEqual(loadCheckedInSeed(), JSON.parse(JSON.stringify(buildDemoSeed())));
});

test('seed: every dinner is the 26-food factor menu with Gemini descriptions', () => {
  const seed = buildDemoSeed();
  const dinners = seed.menus.filter((m) => m.service.mealLabel === 'dinner');
  assert.deepEqual(
    dinners.map((m) => m.service.serviceDate),
    ['2026-10-01', '2026-10-02', '2026-10-03'],
  );
  for (const bundle of dinners) {
    const { serviceDate } = bundle.service;
    assert.equal(bundle.items.length, WASTE_FACTORS.length);
    bundle.items.forEach((item, i) => {
      const factor = WASTE_FACTORS[i]!;
      assert.equal(item.displayName, factor.food);
      assert.equal(item.category, factor.station);
      assert.equal(item.itemId, `item_hall-main_${serviceDate}_dinner_${factor.factorKey}`);
      assert.equal(factorKeyFor(item.displayName), factor.factorKey);
      assert.ok(findWasteFactor(item.displayName));
      const text = findFactorMenuText(item.displayName)!;
      if (text.visibleComponents !== null) assert.equal(item.description, text.visibleComponents);
      else assert.ok(item.description && item.description.length > 0, `${item.displayName} needs a description`);
    });
  }
});

test('seed: demo portions served, one per dinner item, labeled demo and plausible', () => {
  const seed = buildDemoSeed();
  assert.match(seed.portionsLabel, /DEMO/);
  assert.match(seed.provenance, /demo/i);
  const dinners = seed.menus.filter((m) => m.service.mealLabel === 'dinner');
  assert.equal(seed.portionsServed.length, dinners.length * WASTE_FACTORS.length);
  assert.equal(new Set(seed.portionsServed.map((p) => p.recordId)).size, seed.portionsServed.length);
  const byRole: Record<string, number[]> = {};
  for (const p of seed.portionsServed) {
    const bundle = dinners.find((m) => m.service.serviceId === p.serviceId)!;
    const item = bundle.items.find((i) => i.itemId === p.itemId)!;
    assert.ok(item, `portion for unknown item ${p.itemId}`);
    assert.equal(p.source, 'demo');
    assert.equal(p.menuId, bundle.service.menuId);
    assert.equal(p.menuVersion, bundle.service.menuVersion);
    assert.equal(p.serviceDate, bundle.service.serviceDate);
    assert.ok(Number.isSafeInteger(p.count) && p.count >= 40 && p.count <= 260, `${p.itemId}: ${p.count}`);
    const role = portionRole(factorKeyFor(item.displayName), item.category ?? '');
    const [min, max] = DEMO_PORTION_RANGES[role];
    assert.ok(p.count >= min && p.count <= max);
    (byRole[role] ??= []).push(p.count);
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(byRole.dessert!) < mean(byRole.entree!));
  assert.ok(mean(byRole.side!) < mean(byRole.entree!));
  // Re-validating through the package's own parser accepts the 'demo' source unchanged.
  for (const bundle of dinners) {
    const rows = seed.portionsServed.filter((p) => p.serviceId === bundle.service.serviceId);
    assert.deepEqual(buildDemoPortions(bundle), rows);
  }
});
