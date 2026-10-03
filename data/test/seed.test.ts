import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildDemoSeed, DEMO_GEOMETRY, type DemoSeed } from '../src/seed/generate.js';
import {
  buildVocabulary,
  checkGeometryCompatibility,
  findVocabulary,
  planMenuRevision,
  resolveReferencePortion,
  validateReferencePortion,
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
