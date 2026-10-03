import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizePortionBenchmarks, portionDataVersion, generatePortionInsight } from '../src/index.js';
import type { CaptureEvent, FoodMeasurement, MealService, PortionsServed } from '../src/contracts.js';

const service: MealService = { serviceId: 'svc', hallId: 'hall', hallTimezone: 'America/Detroit', serviceDate: '2026-10-03', mealLabel: 'lunch', menuId: 'menu', menuVersion: 1 };
const menuItems = ['a', 'b', 'c'].map(itemId => ({ itemId, menuId: 'menu', displayName: `Food ${itemId}` }));
const geometry = { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' as const };
const capture: CaptureEvent = { eventId: 'event', hallId: 'hall', serviceId: 'svc', capturedAt: '2026-10-03T16:00:00Z', imageObjectId: 'image', geometry, source: 'replay', qualityFlags: [], state: 'succeeded' };
function measurement(itemId: string | null, pixelsWasted: number): FoodMeasurement {
  return { measurementId: `m-${itemId}`, itemId, eventId: 'event', attemptId: 'attempt', remainingAreaPx: pixelsWasted,
    method: 'mask_pixel_count', qualityFlags: ['missing_baseline'],
    maskCount: { pixelsWasted, maskObjectId: 'external-mask', geometry, menuId: 'menu', menuVersion: 1,
      classificationVersion: 'fixture-classification-v1', segmentationVersion: 'fixture-mask-v1', processingVersion: 'exclusive-binary-count-v1', assignment: 'exclusive', validated: true } };
}
function portion(itemId: string, count: number): PortionsServed {
  return { recordId: `p-${itemId}`, hallId: 'hall', serviceId: 'svc', serviceDate: '2026-10-03', menuId: 'menu', menuVersion: 1,
    itemId, count, source: 'manual', updatedAt: '2026-10-03T20:00:00Z' };
}
function summary(measurements = [measurement('a', 200000), measurement('b', 100000)], portions = [portion('a', 1000), portion('b', 100)]) {
  return summarizePortionBenchmarks({ service, menuItems, captures: [capture], measurements, portions });
}

test('portion normalization reverses the raw waste ranking: 200 vs 1000 pixels/portion', async () => {
  const result = summary();
  assert.equal(result.items[0]!.itemId, 'b');
  assert.equal(result.items[0]!.pixelsWastedPerPortion, 1000);
  assert.equal(result.items[1]!.pixelsWastedPerPortion, 200);
  assert.equal(result.items[0]!.pixelsWasted, 100000);
  const insight = await generatePortionInsight(result);
  assert.equal(insight.metrics.topItemId, 'b');
  assert.equal(insight.metrics.portionsServed, 100);
  assert.match(insight.recommendation, /1000 pixels\/portion/);
  assert.match(insight.recommendation, /does not prove dislike/);
  assert.equal(insight.source, 'fallback_rules');
});

test('missing, zero, wrong-service/version/date counts are unavailable, never infinity or zero', () => {
  for (const portions of [[], [portion('a', 0)], [{ ...portion('a', 10), serviceId: 'other' }],
    [{ ...portion('a', 10), menuVersion: 2 }], [{ ...portion('a', 10), serviceDate: '2026-10-04' }]]) {
    assert.equal(summary([measurement('a', 100)], portions).items.find(i => i.itemId === 'a')!.pixelsWastedPerPortion, null);
  }
});

test('legacy estimates, absent foods, malformed counts, and failed captures never produce benchmarks', () => {
  const guessed = { ...measurement('a', 100), method: 'gemini_area_estimate' as const };
  assert.equal(summary([guessed]).items.find(i => i.itemId === 'a')!.pixelsWasted, null);
  assert.equal(summary().items.find(i => i.itemId === 'c')!.pixelsWasted, null);
  for (const count of [-1, NaN, Infinity, 3.5, 1024 * 1024 + 1]) {
    assert.equal(summary([measurement('a', count)]).items.find(i => i.itemId === 'a')!.pixelsWasted, null);
  }
  const result = summarizePortionBenchmarks({ service, menuItems, captures: [{ ...capture, state: 'failed' }], measurements: [measurement('a', 100)], portions: [portion('a', 10)] });
  assert.equal(result.measuredDishes, 0);
  assert.equal(result.items.find(i => i.itemId === 'a')!.pixelsWastedPerPortion, null);
});

test('validated item zero is zero with a positive denominator; missing/exceeded baselines do not gate masks', () => {
  const zero = summary([measurement('a', 0)], [portion('a', 10)]).items.find(i => i.itemId === 'a')!;
  assert.equal(zero.pixelsWastedPerPortion, 0);
  const above = { ...measurement('a', 100), baselineAreaPx: 1, qualityFlags: ['above_baseline' as const] };
  assert.equal(summary([above], [portion('a', 10)]).items.find(i => i.itemId === 'a')!.pixelsWastedPerPortion, 10);
});

test('duplicate measurement IDs count once; multiple attempts and mismatched geometry do not count', () => {
  const m = measurement('a', 100);
  assert.equal(summary([m, m], [portion('a', 10)]).items.find(i => i.itemId === 'a')!.pixelsWasted, 100);
  assert.equal(summary([m, { ...measurement('b', 100), attemptId: 'retry' }]).measuredDishes, 0);
  assert.equal(summary([{ ...m, maskCount: { ...m.maskCount!, geometry: { ...geometry, widthPx: 10 } } }]).measuredDishes, 0);
  const larger = { ...capture, eventId: 'larger', geometry: { ...geometry, widthPx: 2048 } };
  const second = { ...measurement('b', 100), eventId: 'larger', maskCount: { ...m.maskCount!, pixelsWasted: 100, geometry: larger.geometry } };
  const mixed = summarizePortionBenchmarks({ service, menuItems, captures: [capture, larger], measurements: [m, second], portions: [portion('a', 10)] });
  assert.ok(mixed.items.every(i => i.pixelsWastedPerPortion === null));
  assert.match(mixed.items[0]!.unavailableReason!, /geometries differ/);
});

test('unknown food has no portion denominator and changed counts invalidate the insight cache', async () => {
  const original = summary();
  assert.notEqual(portionDataVersion(original), portionDataVersion(summary(undefined, [portion('a', 1000), portion('b', 200)])));
  const unknown = summary([measurement(null, 100)]);
  assert.ok(unknown.items.every(i => i.pixelsWasted === null));
  const insight = await generatePortionInsight(unknown, { generateText: async () => { throw new Error('must not guess'); } });
  assert.equal(insight.source, 'fallback_rules');
});
