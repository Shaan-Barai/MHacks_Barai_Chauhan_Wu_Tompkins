import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  checkGeometryCompatibility,
  createReferencePortion,
  DataValidationError,
  resolveReferencePortion,
  validateReferencePortion,
  type ImageGeometry,
  type ReferencePortion,
} from '../src/index.js';

const GEOMETRY: ImageGeometry = {
  widthPx: 1024,
  heightPx: 1024,
  coordinateSpace: 'topdown-normalized-v1',
  plateShape: 'round',
  plateDiameterPx: 900,
};

const VALID: ReferencePortion = {
  baselineId: 'base_hall-main_2026-10-03_lunch_tomato-soup_v1',
  baselineVersion: 1,
  itemId: 'item_hall-main_2026-10-03_lunch_tomato-soup',
  expectedAreaPx: 44000,
  geometry: GEOMETRY,
  source: 'manual_area',
};

function rejects(record: unknown, expectedCode = 'INVALID_REFERENCE'): void {
  assert.throws(
    () => validateReferencePortion(record),
    (err: unknown) => err instanceof DataValidationError && err.apiError.code === expectedCode,
  );
}

test('reference: contract-exact record validates; the three sources stay distinguishable', () => {
  assert.equal(validateReferencePortion(VALID), VALID);
  assert.equal(
    validateReferencePortion({ ...VALID, source: 'gemini_estimate' }).source,
    'gemini_estimate',
  );
  assert.equal(
    validateReferencePortion({ ...VALID, source: 'reference_photo', referenceImageObjectId: 'img_1' })
      .source,
    'reference_photo',
  );
  // a photo-derived baseline without its photo reference is invalid
  rejects({ ...VALID, source: 'reference_photo' });
  // sources outside the enum never pass (nothing collapses them together)
  rejects({ ...VALID, source: 'estimate' });
  rejects({ ...VALID, source: 'manual' });
});

test('reference: baseline denominator must be finite and > 0 (never a guessed zero)', () => {
  rejects({ ...VALID, expectedAreaPx: 0 });
  rejects({ ...VALID, expectedAreaPx: -5 });
  rejects({ ...VALID, expectedAreaPx: Number.NaN });
  rejects({ ...VALID, expectedAreaPx: Number.POSITIVE_INFINITY });
  rejects({ ...VALID, expectedAreaPx: '44000' });
  // cannot exceed the normalized image area
  rejects({ ...VALID, expectedAreaPx: 1024 * 1024 + 1 });
});

test('reference: geometry is validated with the shared coordinate space', () => {
  rejects({ ...VALID, geometry: undefined }, 'INVALID_GEOMETRY');
  rejects(
    { ...VALID, geometry: { ...GEOMETRY, coordinateSpace: 'raw-camera' } },
    'INVALID_GEOMETRY',
  );
  rejects({ ...VALID, geometry: { ...GEOMETRY, widthPx: 0 } }, 'INVALID_GEOMETRY');
  rejects({ ...VALID, geometry: { ...GEOMETRY, plateDiameterPx: 5000 } }, 'INVALID_GEOMETRY');
  rejects({ ...VALID, baselineVersion: 0 });
  rejects({ ...VALID, baselineVersion: 1.5 });
});

test('reference: creating a revision mints a new baselineId/version, never a rewrite', () => {
  const v1 = createReferencePortion([], {
    itemId: VALID.itemId,
    expectedAreaPx: 44000,
    geometry: GEOMETRY,
    source: 'manual_area',
  });
  assert.equal(v1.baselineVersion, 1);
  assert.equal(v1.baselineId, 'base_hall-main_2026-10-03_lunch_tomato-soup_v1');

  const v2 = createReferencePortion([v1], {
    itemId: VALID.itemId,
    expectedAreaPx: 41000,
    geometry: GEOMETRY,
    source: 'gemini_estimate',
  });
  assert.equal(v2.baselineVersion, 2);
  assert.equal(v2.baselineId, 'base_hall-main_2026-10-03_lunch_tomato-soup_v2');
  assert.notEqual(v2.baselineId, v1.baselineId);
  // v1 still exists untouched; analyses that froze version 1 keep resolving it
  assert.equal(v1.expectedAreaPx, 44000);

  assert.throws(() =>
    createReferencePortion([v1], {
      itemId: 'item_other',
      expectedAreaPx: 100,
      geometry: GEOMETRY,
      source: 'manual_area',
    }),
  );
});

test('reference: resolution returns the latest version; absence is explicit, never zero', () => {
  const v1 = { ...VALID };
  const v2 = { ...VALID, baselineId: 'base_x_v2', baselineVersion: 2, expectedAreaPx: 40000 };
  const hit = resolveReferencePortion([v1, v2], VALID.itemId);
  assert.ok(hit.found);
  assert.equal(hit.reference.baselineVersion, 2);

  const miss = resolveReferencePortion([v1, v2], 'item_hall-main_2026-10-03_lunch_bread');
  assert.equal(miss.found, false);
  assert.ok(!miss.found && miss.qualityFlag === 'missing_baseline');
  assert.ok(!miss.found && /unavailable/.test(miss.reason));
  // nothing in the result resembles a zero-area baseline
  assert.ok(!('reference' in miss));
});

test('geometry compatibility: identical normalized geometry is compatible (§7.3)', () => {
  const result = checkGeometryCompatibility(GEOMETRY, { ...GEOMETRY });
  assert.deepEqual(result, { compatible: true, reasons: [] });
  // small plate-diameter drift within tolerance is still compatible
  assert.equal(
    checkGeometryCompatibility(GEOMETRY, { ...GEOMETRY, plateDiameterPx: 910 }).compatible,
    true,
  );
});

test('geometry compatibility: mismatches are reported, not thrown', () => {
  const differentSize = checkGeometryCompatibility(GEOMETRY, { ...GEOMETRY, widthPx: 512, heightPx: 512 });
  assert.equal(differentSize.compatible, false);
  assert.ok(differentSize.reasons.some((reason) => /differently scaled/.test(reason)));

  const foreignSpace = checkGeometryCompatibility(
    GEOMETRY,
    { ...GEOMETRY, coordinateSpace: 'raw-camera' } as unknown as ImageGeometry,
  );
  assert.equal(foreignSpace.compatible, false);
  assert.ok(foreignSpace.reasons.some((reason) => /coordinate space/i.test(reason)));

  const plateMismatch = checkGeometryCompatibility(GEOMETRY, {
    ...GEOMETRY,
    plateShape: 'tray',
    plateDiameterPx: 700,
  });
  assert.equal(plateMismatch.compatible, false);
  assert.equal(plateMismatch.reasons.length, 2); // shape + diameter

  // absent optional plate fields on one side are not a mismatch
  const partial = checkGeometryCompatibility(GEOMETRY, {
    widthPx: 1024,
    heightPx: 1024,
    coordinateSpace: 'topdown-normalized-v1',
  });
  assert.equal(partial.compatible, true);
});
