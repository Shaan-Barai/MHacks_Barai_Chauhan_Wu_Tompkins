import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareForecasts, summarizeForecastOutcomes, type ForecastOutcomeInput } from '../src/index.js';

const row = (over: Partial<ForecastOutcomeInput>): ForecastOutcomeInput => ({
  dishId: 'rice', serviceDate: '2026-10-20', mealLabel: 'lunch', demandLb: 100, recommendedPrepLb: 110, fssForecastLb: 130,
  consumedLb: 100, ranOut: false, panLeftoverLb: 30, leftoverCostUsd: 150, trayWasteLb: null, trayWasteCostUsd: null,
  trayWasteSource: null, isSimulated: false, ...over,
});

test('WAPE uses only meals that did not run out; ours on its demand forecast, FSS on its forecast (hand-checked)', () => {
  const r = compareForecasts([
    row({ demandLb: 90, consumedLb: 100, fssForecastLb: 130 }), // ours |90-100| = 10, FSS 30
    row({ demandLb: 110, consumedLb: 100, fssForecastLb: 100 }), // ours 10, FSS 0
    row({ demandLb: 10, consumedLb: 80, fssForecastLb: 80, ranOut: true }), // ran out: excluded from WAPE
  ]);
  assert.equal(r.ourWape, 20 / 200);
  assert.equal(r.fssWape, 30 / 200);
  assert.equal(r.meals, 3);
  assert.equal(r.ranOutMeals, 1);
});

test('stockouts: below consumed, or at/below consumed on a ran-out meal; would-leave only on open meals', () => {
  const r = compareForecasts([
    row({ recommendedPrepLb: 95, consumedLb: 100, fssForecastLb: 120 }), // ours short
    row({ recommendedPrepLb: 120, consumedLb: 100, fssForecastLb: 100 }), // ours leaves 20; FSS exactly enough
    row({ recommendedPrepLb: 80, consumedLb: 80, fssForecastLb: 80, ranOut: true }), // both certain stockouts
  ]);
  assert.equal(r.ourStockouts, 2);
  assert.equal(r.fssStockouts, 1);
  assert.equal(r.ourWouldLeaveLb, 20);
});

test('unknown pounds and dollars stay null (never zero); known ones are summed; labels survive', () => {
  const none = compareForecasts([row({ panLeftoverLb: null, leftoverCostUsd: null })]);
  assert.equal(none.panLeftoverLb, null);
  assert.equal(none.trayWasteLb, null);
  assert.equal(none.fssWape, 0.3);
  const some = compareForecasts([
    row({ trayWasteLb: 4, trayWasteCostUsd: 20, trayWasteSource: 'simulated', isSimulated: true }),
    row({ trayWasteLb: null }),
  ]);
  assert.equal(some.trayWasteLb, 4);
  assert.equal(some.trayWasteUsd, 20);
  assert.deepEqual(some.trayWasteSources, ['simulated']);
  assert.equal(some.simulated, true);
  const noFss = compareForecasts([row({ fssForecastLb: null })]);
  assert.equal(noFss.fssWape, null);
  assert.equal(noFss.fssStockouts, null);
});

test('per-dish rows: averages, names, biggest pan leftover first', () => {
  const s = summarizeForecastOutcomes(
    [
      row({ dishId: 'rice', panLeftoverLb: 5, recommendedPrepLb: 100 }),
      row({ dishId: 'rice', panLeftoverLb: 7, recommendedPrepLb: 120, fssForecastLb: null }),
      row({ dishId: 'ham', panLeftoverLb: 40 }),
    ],
    [
      { dishId: 'rice', displayName: 'Sticky Rice', serviceStyle: 'side', isSimulated: false },
      { dishId: 'ham', displayName: 'Ham', serviceStyle: 'entree', isSimulated: true },
    ],
  );
  assert.deepEqual(s.dishes.map((d) => d.displayName), ['Ham', 'Sticky Rice']);
  const rice = s.dishes[1]!;
  assert.equal(rice.avgRecommendedPrepLb, 110);
  assert.equal(rice.avgFssLb, 130, 'average over meals that have an FSS forecast');
  assert.equal(rice.panLeftoverLb, 12);
  assert.equal(s.dishes[0]!.simulated, true, 'a simulated dish is labeled');
  assert.equal(s.totals.meals, 3);
});
