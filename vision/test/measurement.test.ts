import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clamp, computeMeasurement, computeUnknownMeasurement } from '../src/measurement.js';

const identity = { measurementId: 'meas_x_1', eventId: 'cap_x', attemptId: 'att_x' };

test('§7 hand-check: 14880 remaining over 48000 baseline', () => {
  // Hand calculation per AGENTS.md §7 (contracts/samples.json foodMeasurement):
  //   raw_waste_fraction   = 14880 / 48000 = 0.31
  //   display_waste_percent = 100 * clamp(0.31, 0, 1) = 31
  const m = computeMeasurement(identity, 'item_scrambled-eggs', 14880, {
    baselineId: 'base_scrambled-eggs_v1',
    areaPx: 48000,
    geminiEstimated: false,
  });
  assert.equal(m.rawWasteFraction, 0.31);
  assert.equal(m.displayWastePercent, 31);
  assert.equal(m.baselineAreaPx, 48000);
  assert.equal(m.baselineId, 'base_scrambled-eggs_v1');
  assert.equal(m.method, 'gemini_area_estimate');
  assert.deepEqual(m.qualityFlags, ['ai_estimate']);
  assert.equal(m.unavailableReason, undefined);
});

test('missing baseline => no percentage, reason, missing_baseline flag — never zero', () => {
  const m = computeMeasurement(identity, 'item_fruit-cup', 5000, undefined);
  assert.equal(m.remainingAreaPx, 5000); // raw area preserved
  assert.equal(m.rawWasteFraction, undefined);
  assert.equal(m.displayWastePercent, undefined);
  assert.equal(m.unavailableReason, 'missing_baseline');
  assert.ok(m.qualityFlags.includes('missing_baseline'));
  assert.ok(m.qualityFlags.includes('ai_estimate'));
});

test('invalid (zero / non-finite) baseline is treated as missing, with its own reason', () => {
  for (const areaPx of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    const m = computeMeasurement(identity, 'item_x', 100, { areaPx, geminiEstimated: false });
    assert.equal(m.displayWastePercent, undefined, `baseline ${areaPx}`);
    assert.equal(m.unavailableReason, 'invalid_baseline');
    assert.ok(m.qualityFlags.includes('missing_baseline'));
  }
});

test('above baseline: raw fraction preserved unclamped, display capped at 100, flagged', () => {
  // 60000 / 48000 = 1.25 -> display 100, flag above_baseline (§7.2)
  const m = computeMeasurement(identity, 'item_scrambled-eggs', 60000, {
    baselineId: 'base_scrambled-eggs_v1',
    areaPx: 48000,
    geminiEstimated: false,
  });
  assert.equal(m.rawWasteFraction, 1.25);
  assert.equal(m.displayWastePercent, 100);
  assert.ok(m.qualityFlags.includes('above_baseline'));
});

test('gemini-estimated baseline carries gemini_estimated_baseline flag', () => {
  const m = computeMeasurement(identity, 'item_fruit-cup', 5000, { areaPx: 20000, geminiEstimated: true });
  assert.equal(m.rawWasteFraction, 0.25);
  assert.equal(m.displayWastePercent, 25);
  assert.equal(m.baselineId, undefined); // no stored reference record
  assert.ok(m.qualityFlags.includes('gemini_estimated_baseline'));
  assert.ok(m.qualityFlags.includes('ai_estimate'));
});

test('unknown food keeps its area but no menu percentage', () => {
  const m = computeUnknownMeasurement(identity, 6200);
  assert.equal(m.itemId, null);
  assert.equal(m.remainingAreaPx, 6200);
  assert.equal(m.displayWastePercent, undefined);
  assert.equal(m.unavailableReason, 'unknown_item');
});

test('clamp bounds', () => {
  assert.equal(clamp(-0.2, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(clamp(3.7, 0, 1), 1);
});
