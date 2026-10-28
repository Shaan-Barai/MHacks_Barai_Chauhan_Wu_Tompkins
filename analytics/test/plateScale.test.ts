/**
 * Run 3 plate-scale-v1: estimated pounds from Pixels wasted. Every expected
 * value is hand-calculated in the comment next to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cm2PerPixel, plateScaleEstimate, sumPlateScaleLb, PLATE_SCALE_METHOD } from '../src/index.js';

const close = (a: number | null, b: number, eps = 1e-9) => assert.ok(a !== null && Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('cm² per pixel = (D_cm / d_px)²', () => {
  // 26.7 cm plate spanning 890 px: (26.7 / 890)² = 0.03² = 0.0009 cm²/px
  close(cm2PerPixel({ plateDiameterCm: 26.7, plateDiameterPx: 890 }), 0.0009);
  // equals π(D/2)² / π(d/2)²: 559.9 cm² / 622,114 px² ... same ratio
  close(cm2PerPixel({ plateDiameterCm: 26.7, plateDiameterPx: 890 }), (Math.PI * 13.35 ** 2) / (Math.PI * 445 ** 2), 1e-15);
  assert.equal(cm2PerPixel({ plateDiameterCm: 26.7, plateDiameterPx: 0 }), null);
  assert.equal(cm2PerPixel(null), null);
});

test('hand-computed pounds', () => {
  // 100,000 px × 0.0009 = 90 cm²; × 0.8 g/cm² = 72 g; / 453.59237 = 0.158733... lb
  const e = plateScaleEstimate({ pixels: 100_000, scale: { plateDiameterCm: 26.7, plateDiameterPx: 890 }, weightGPerCm2: 0.8 });
  close(e.areaCm2, 90, 1e-9);
  close(e.grams, 72, 1e-9);
  close(e.lb, 72 / 453.59237, 1e-12);
  assert.equal(e.lb!.toFixed(4), '0.1587');
  assert.equal(e.isEstimate, true);
  assert.equal(e.method, PLATE_SCALE_METHOD);
  assert.deepEqual(
    { d: e.assumptions.plateDiameterCm, px: e.assumptions.plateDiameterPx, w: e.assumptions.weightGPerCm2 },
    { d: 26.7, px: 890, w: 0.8 },
  );
  assert.match(e.assumptions.note, /Estimate/);
  // 1024-px frame, plate 800 px: (26.7/800)² = 0.00111389 cm²/px; 50,000 px → 55.6945 cm²; × 1.2 = 66.8334 g = 0.14734 lb
  const f = plateScaleEstimate({ pixels: 50_000, scale: { plateDiameterCm: 26.7, plateDiameterPx: 800 }, weightGPerCm2: 1.2 });
  close(f.grams, 50_000 * (26.7 / 800) ** 2 * 1.2, 1e-9);
  assert.equal(f.grams!.toFixed(4), '66.8334');
});

test('a smaller real plate scales the estimate by (true D / assumed D)²', () => {
  const assumed = plateScaleEstimate({ pixels: 10_000, scale: { plateDiameterCm: 26.7, plateDiameterPx: 900 }, weightGPerCm2: 1 });
  const actual = plateScaleEstimate({ pixels: 10_000, scale: { plateDiameterCm: 22.9, plateDiameterPx: 900 }, weightGPerCm2: 1 });
  close(actual.grams! / assumed.grams!, (22.9 / 26.7) ** 2, 1e-12); // a 9" plate: 0.7356× the 10.5" estimate
});

test('unavailable is null with a reason, never 0', () => {
  const s = { plateDiameterCm: 26.7, plateDiameterPx: 890 };
  const noScale = plateScaleEstimate({ pixels: 1000, scale: null, weightGPerCm2: 1 });
  assert.deepEqual([noScale.grams, noScale.lb, noScale.unavailableReason], [null, null, 'no_plate_scale']);
  const noFactor = plateScaleEstimate({ pixels: 1000, scale: s, weightGPerCm2: null });
  assert.deepEqual([noFactor.lb, noFactor.unavailableReason], [null, 'no_factor']);
  close(noFactor.areaCm2, 0.9); // area is still known: 1000 × 0.0009
  const unknown = plateScaleEstimate({ pixels: 1000, scale: s, weightGPerCm2: 1, unknownItem: true });
  assert.deepEqual([unknown.lb, unknown.unavailableReason], [null, 'unknown_item']);
  assert.equal(plateScaleEstimate({ pixels: Number.NaN, scale: s, weightGPerCm2: 1 }).unavailableReason, 'invalid_input');
  // zero pixels with a scale and a factor is a real zero
  assert.equal(plateScaleEstimate({ pixels: 0, scale: s, weightGPerCm2: 1 }).lb, 0);
});

test('totals count only estimates that have pounds', () => {
  const s = { plateDiameterCm: 26.7, plateDiameterPx: 890 };
  const t = sumPlateScaleLb([
    plateScaleEstimate({ pixels: 100_000, scale: s, weightGPerCm2: 0.8 }), // 0.158733 lb
    plateScaleEstimate({ pixels: 100_000, scale: null, weightGPerCm2: 0.8 }),
  ]);
  close(t.lb, 72 / 453.59237, 1e-12);
  assert.deepEqual([t.covered, t.total], [1, 2]);
  assert.equal(sumPlateScaleLb([]).lb, null);
});

test('per-food pounds beside unchanged pixels; captures without a scale add pixels but no pounds', async () => {
  const { plateScaleWeights } = await import('../src/index.js');
  const s = { plateDiameterCm: 26.7, plateDiameterPx: 890 }; // 0.0009 cm²/px
  const w = plateScaleWeights(
    [
      { eventId: 'a', itemId: 'rice', displayName: 'Rice', pixels: 100_000 }, // 90 cm² × 0.5 = 45 g
      { eventId: 'b', itemId: 'rice', displayName: 'Rice', pixels: 50_000 },  // no scale
      { eventId: 'a', itemId: null, displayName: 'Unclassified', pixels: 10_000 },
      { eventId: 'a', itemId: 'mystery', displayName: 'Mystery', pixels: 20_000 }, // no factor
    ],
    new Map([['a', s], ['b', null]]),
    (name) => (name === 'Rice' ? 0.5 : null),
  );
  const rice = w.items.find((i) => i.itemId === 'rice')!;
  assert.equal(rice.pixels, 150_000);
  assert.equal(rice.pixelsWithScale, 100_000);
  close(rice.estimatedGrams, 45, 1e-9);
  close(rice.estimatedLb, 45 / 453.59237, 1e-12);
  assert.deepEqual([rice.captures, rice.capturesWithScale], [2, 1]);
  const unknown = w.items.find((i) => i.itemId === null)!;
  assert.deepEqual([unknown.estimatedLb, unknown.unavailableReason], [null, 'unknown_item']);
  assert.equal(w.items.find((i) => i.itemId === 'mystery')!.unavailableReason, 'no_factor');
  assert.equal(w.totals.pixels, 180_000); // every pixel still counted
  close(w.totals.estimatedLb, 45 / 453.59237, 1e-12);
  assert.deepEqual([w.totals.captures, w.totals.capturesWithScale], [2, 1]);
  assert.equal(w.isEstimate, true);
});
