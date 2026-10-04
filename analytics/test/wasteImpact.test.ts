import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImpactDashboard,
  computeWasteImpact,
  countNeighborFoodExcluded,
  fallbackRecommendation,
  generateRecommendation,
  buildRecommendationPrompt,
  recommendationFacts,
  parseRecommendationOutput,
  selectImpactMeasurements,
  sumImpacts,
  impactCoverage,
  formatPoints,
  formatPixelRate,
  NEIGHBOR_FOOD_EXCLUDED_FLAG,
  UNKNOWN_FOOD_LABEL,
  WASTE_FACTORS_VERSION,
  type ImpactDashboardInput,
  type ImpactMeasurementInput,
  type TextGateway,
} from '../src/index.js';
import type {
  CaptureEvent,
  FoodMeasurement,
  MealService,
  MenuItem,
  NutritionFactor,
  PortionsServed,
  WasteFactor,
} from '../src/contracts.js';

// Rows copied from menu_waste_factors.csv / menu_nutrition_factors.csv (waste-factors-v3).
const PIZZA: WasteFactor = {
  factorKey: 'pepperoni-pizza', food: 'Pepperoni Pizza', station: 'Pizziti',
  weightGPerCm2: 1.0, kgCo2ePerKg: 16.06, waterM3PerKg: 1.94, impactUsdPerKg: 5.96, largestFactor: 'carbon', densityGPerCm3: null,
};
const STEAK: WasteFactor = {
  factorKey: 'ancho-flank-steak', food: 'Ancho Flank Steak', station: 'Halal',
  weightGPerCm2: 1.2, kgCo2ePerKg: 131.69, waterM3PerKg: 1.925, impactUsdPerKg: 27.91, largestFactor: 'carbon', densityGPerCm3: 0.7,
};
const PIZZA_N: NutritionFactor = { factorKey: 'pepperoni-pizza', nutrientDaysPerKg: 0.69, kcalPerKg: 2700 };
const STEAK_N: NutritionFactor = { factorKey: 'ancho-flank-steak', nutrientDaysPerKg: 1.05, kcalPerKg: 1600 };

const close = (actual: number | null | undefined, expected: number, eps = 1e-9) =>
  assert.ok(actual != null && Math.abs(actual - expected) <= eps, `${actual} !== ${expected}`);

test('README pepperoni pizza example: 10,000 px → relative impact points', () => {
  // base = 10,000 / 1000 × 1.0 = 10
  const i = computeWasteImpact(10_000, PIZZA, PIZZA_N);
  assert.equal(i.pixels, 10_000);
  close(i.co2Points, 160.6); // 10 × 16.06
  close(i.waterPoints, 19.4); // 10 × 1.94
  close(i.impactPoints, 59.6); // 10 × 5.96 (= 0.19·C + 1.50·W within the CSV's cent rounding)
  close(i.nutritionPoints, 6.9); // 10 × 0.69, separate
  assert.equal(i.wasteFactorsVersion, WASTE_FACTORS_VERSION);
  assert.equal(i.unavailableReason, undefined);
  assert.deepEqual(Object.keys(i).sort(), [
    'co2Points', 'grams', 'impactPoints', 'kgCo2e', 'nutritionPoints', 'physicalMethod', 'physicalUnavailableReason',
    'pixels', 'wasteFactorsVersion', 'waterLitres', 'waterPoints',
  ]);
  // Uncalibrated (no PhysicalEstimate): physical amounts null with a reason, never 0.
  assert.deepEqual([i.grams, i.kgCo2e, i.waterLitres, i.physicalMethod, i.physicalUnavailableReason], [null, null, null, null, 'no_calibration']);
});

test('beef outweighs pizza for the same pixels; nutrition never changes impactPoints', () => {
  // steak base = 5,000 / 1000 × 1.2 = 6
  const steak = computeWasteImpact(5000, STEAK, STEAK_N);
  close(steak.impactPoints, 167.46); // 6 × 27.91
  close(steak.co2Points, 790.14); // 6 × 131.69
  close(steak.waterPoints, 11.55); // 6 × 1.925
  close(steak.nutritionPoints, 6.3); // 6 × 1.05
  const pizza = computeWasteImpact(5000, PIZZA, PIZZA_N);
  assert.ok(steak.impactPoints! > pizza.impactPoints!, 'same pixels, steak scores higher');

  const without = computeWasteImpact(10_000, PIZZA, null);
  assert.equal(without.impactPoints, computeWasteImpact(10_000, PIZZA, PIZZA_N).impactPoints);
  assert.equal(without.nutritionPoints, null);
  close(without.impactPoints, 10 * (0.19 * 16.06 + 1.5 * 1.94), 10 * 0.005);
});

test('no factor, unknown item, zero pixels: points null with a reason, never zero for missing', () => {
  const noFactor = computeWasteImpact(5000, null, PIZZA_N);
  assert.deepEqual(
    [noFactor.pixels, noFactor.co2Points, noFactor.waterPoints, noFactor.impactPoints, noFactor.nutritionPoints, noFactor.unavailableReason],
    [5000, null, null, null, null, 'no_factor'],
  );
  const unknown = computeWasteImpact(4000, PIZZA, PIZZA_N, { unknownItem: true });
  assert.deepEqual([unknown.pixels, unknown.impactPoints, unknown.unavailableReason], [4000, null, 'unknown_item']);
  const badFactor = computeWasteImpact(100, { ...PIZZA, weightGPerCm2: NaN }, null);
  assert.equal(badFactor.unavailableReason, 'no_factor');
  // A measured clean mask: a real zero.
  const zero = computeWasteImpact(0, PIZZA, PIZZA_N);
  assert.deepEqual([zero.impactPoints, zero.co2Points, zero.nutritionPoints], [0, 0, 0]);
  for (const bad of [-1, NaN, Infinity]) assert.throws(() => computeWasteImpact(bad, PIZZA, null), RangeError);
});

test('sumImpacts: pixels sum all; points sum available inputs, null when none', () => {
  const a = computeWasteImpact(5000, STEAK, STEAK_N); // 167.46 points
  const b = computeWasteImpact(2000, null, null); // no factor
  const c = computeWasteImpact(1000, PIZZA, null); // base 1 → 5.96 points, no nutrition
  const u = computeWasteImpact(3000, null, null, { unknownItem: true });
  const s = sumImpacts([a, b, c, u]);
  assert.equal(s.pixels, 11_000);
  close(s.impactPoints, 167.46 + 5.96);
  close(s.co2Points, 790.14 + 16.06);
  close(s.waterPoints, 11.55 + 1.94);
  close(s.nutritionPoints, 6.3); // only the steak has a nutrition row
  assert.equal(s.unavailableReason, 'unknown_item'); // tie 1:1 → unknown_item first
  assert.deepEqual(impactCoverage([a, b, c, u]), { withPoints: 2, unavailable: { unknown_item: 1, no_factor: 1 } });
  assert.equal(sumImpacts([a, b, b]).unavailableReason, 'no_factor');

  const none = sumImpacts([b]);
  assert.deepEqual([none.pixels, none.impactPoints, none.co2Points], [2000, null, null]);
  const empty = sumImpacts([]);
  assert.deepEqual(
    [empty.pixels, empty.co2Points, empty.waterPoints, empty.impactPoints, empty.nutritionPoints],
    [0, null, null, null, null],
  );
});

// ---- dashboard fixture --------------------------------------------------

const A = 'svc_h_2026-10-01_dinner';
const B = 'svc_h_2026-10-02_dinner';
const id = (svc: string, slug: string) => svc.replace('svc_', 'item_') + `_${slug}`;
const factors = new Map([['ancho flank steak', [STEAK, STEAK_N] as const], ['pepperoni pizza', [PIZZA, PIZZA_N] as const]]);
const lookups = {
  findWasteFactor: (n: string) => factors.get(n.trim().toLowerCase())?.[0] ?? null,
  findNutritionFactor: (n: string) => factors.get(n.trim().toLowerCase())?.[1] ?? null,
};
const m = (eventId: string, serviceId: string, itemId: string | null, displayName: string, pixels: number): ImpactMeasurementInput =>
  ({ eventId, serviceId, menuVersion: 1, itemId, displayName, pixels });

const MEASUREMENTS: ImpactMeasurementInput[] = [
  m('e1', A, id(A, 'ancho-flank-steak'), 'Ancho Flank Steak', 5000), // base 6 → 167.46 points
  m('e1', A, id(A, 'pepperoni-pizza'), 'Pepperoni Pizza', 10000), // base 10 → 59.6 points
  m('e1', A, null, UNKNOWN_FOOD_LABEL, 2000), // pixels only
  m('e2', A, id(A, 'ancho-flank-steak'), 'Ancho Flank Steak', 3000), // base 3.6 → 100.476 points
  m('e2', A, id(A, 'mystery-tofu'), 'Mystery Tofu', 1000), // no factor
  m('e3', B, id(B, 'ancho-flank-steak'), 'Ancho Flank Steak', 2500), // base 3 → 83.73 points
];

function portion(serviceId: string, slug: string, count: number, source: PortionsServed['source'] = 'demo'): PortionsServed {
  return {
    recordId: JSON.stringify([serviceId, 1, id(serviceId, slug)]), hallId: 'h', serviceId,
    serviceDate: serviceId.split('_')[2]!, menuId: serviceId.replace('svc_', 'menu_'), menuVersion: 1,
    itemId: id(serviceId, slug), count, source, updatedAt: '2026-10-02T23:30:00.000Z',
  };
}
const PORTIONS = [
  portion(A, 'ancho-flank-steak', 4),
  portion(B, 'ancho-flank-steak', 2),
  portion(A, 'pepperoni-pizza', 10, 'manual'),
  portion(A, 'mystery-tofu', 5),
];

function dashInput(over: Partial<ImpactDashboardInput> = {}): ImpactDashboardInput {
  return {
    window: { start: '2026-10-01', end: '2026-10-02', hallId: 'h' },
    measurements: MEASUREMENTS,
    captures: { captures: 4, analyzed: 3, excluded: 1 },
    menuItems: [],
    portions: PORTIONS,
    factors: lookups,
    attemptQualityFlags: { e1: [NEIGHBOR_FOOD_EXCLUDED_FLAG, 'overlapping_masks'], e2: ['overlapping_masks'], e3: [] },
    ...over,
  };
}

// Hand-calculated: steak base 6 + 3.6 + 3 = 12.6; pizza base 10.
const STEAK_POINTS = 12.6 * 27.91; // 351.666
const PIZZA_POINTS = 10 * 5.96; // 59.6

test('dashboard: totals, sum-then-divide per portion, pixel ranking, coverage, labels', () => {
  const d = buildImpactDashboard(dashInput());
  // totals: every pixel counted; points only for foods with a factor
  assert.equal(d.totals.pixels, 23_500);
  close(d.totals.impactPoints, STEAK_POINTS + PIZZA_POINTS); // 411.266
  close(d.totals.co2Points, 12.6 * 131.69 + 10 * 16.06); // 1819.894
  close(d.totals.waterPoints, 12.6 * 1.925 + 10 * 1.94); // 43.655
  close(d.totals.nutritionPoints, 12.6 * 1.05 + 10 * 0.69); // 20.13
  assert.equal(d.totals.unavailableReason, 'unknown_item');
  assert.deepEqual([d.totals.captures, d.totals.analyzedCaptures, d.totals.excludedCaptures], [4, 3, 1]);

  // steak spans two services: (5000 + 3000 + 2500) px ÷ (4 + 2) portions = 1750 px,
  // not the mean of the service rates ((8000/4 + 2500/2) / 2 = 1625)
  const steak = d.targets[0]!;
  assert.equal(steak.displayName, 'Ancho Flank Steak');
  assert.equal(steak.itemId, id(B, 'ancho-flank-steak'));
  assert.equal(steak.factorKey, 'ancho-flank-steak');
  assert.equal(steak.portionsServed, 6);
  assert.equal(steak.portionsSource, 'demo');
  assert.equal(steak.impact.pixels, 10_500);
  close(steak.impact.impactPoints, STEAK_POINTS);
  assert.equal(steak.perPortion!.pixels, 1750);
  close(steak.perPortion!.impactPoints, STEAK_POINTS / 6); // 58.611
  assert.deepEqual(Object.keys(steak.perPortion!).sort(), ['grams', 'impactPoints', 'pixels']);
  assert.equal(steak.perPortion!.grams, null, 'uncalibrated: no grams per portion');

  assert.deepEqual(d.targets.map((r) => r.displayName), ['Ancho Flank Steak', 'Pepperoni Pizza', 'Mystery Tofu']);
  assert.equal(d.targets[1]!.perPortion!.pixels, 1000); // 10,000 px ÷ 10
  close(d.targets[1]!.perPortion!.impactPoints, 5.96);
  assert.equal(d.targets[1]!.portionsSource, 'manual');
  const tofu = d.targets[2]!;
  assert.equal(tofu.factorKey, null);
  assert.equal(tofu.impact.unavailableReason, 'no_factor');
  assert.equal(tofu.perPortion!.pixels, 200); // 1000 ÷ 5
  assert.equal(tofu.perPortion!.impactPoints, null);

  assert.deepEqual(d.mostWasted.map((r) => r.displayName), ['Ancho Flank Steak', 'Pepperoni Pizza', UNKNOWN_FOOD_LABEL, 'Mystery Tofu']);
  const unknown = d.mostWasted[2]!;
  assert.equal(unknown.itemId, null);
  assert.equal(unknown.impact.pixels, 2000);
  assert.equal(unknown.impact.impactPoints, null);
  assert.equal(unknown.perPortion, null);
  assert.equal(unknown.portionsServed, null);
  assert.equal(unknown.impact.unavailableReason, 'unknown_item');

  assert.deepEqual(d.coverage, { itemsWithFactor: 2, itemsWithoutFactor: 1, itemsWithPortions: 3, capturesWithNeighborFoodExcluded: 1 });
  assert.deepEqual(d.labels, { relativeImpact: true, demoPortions: true });
  assert.deepEqual(d.window, { start: '2026-10-01', end: '2026-10-02', hallId: 'h' });
});

test('dashboard: targets rank by pixels per portion even when points per portion disagree', () => {
  // pizza with 4 portions: 2500 px/portion (14.9 points) beats steak 1750 px/portion (58.6 points)
  const fewPizza = PORTIONS.map((p) => (p.itemId === id(A, 'pepperoni-pizza') ? { ...p, count: 4 } : p));
  const d = buildImpactDashboard(dashInput({ portions: fewPizza }));
  assert.deepEqual(d.targets.map((r) => r.perPortion?.pixels), [2500, 1750, 200]);
  close(d.targets[0]!.perPortion!.impactPoints, 14.9);
  assert.ok(d.targets[1]!.perPortion!.impactPoints! > d.targets[0]!.perPortion!.impactPoints!);
  // most wasted: by total pixels, unchanged by portions
  assert.deepEqual(d.mostWasted.map((r) => r.impact.pixels), [10_500, 10_000, 2000, 1000]);
});

test('dashboard: zero or missing portions make the rate unavailable', () => {
  const zeroPizza = PORTIONS.map((p) => (p.itemId === id(A, 'pepperoni-pizza') ? { ...p, count: 0 } : p));
  const d0 = buildImpactDashboard(dashInput({ portions: zeroPizza }));
  const pizza0 = d0.targets.find((r) => r.factorKey === 'pepperoni-pizza')!;
  assert.equal(pizza0.portionsServed, 0);
  assert.equal(pizza0.perPortion, null);
  assert.equal(d0.coverage.itemsWithPortions, 2);

  // steak missing day B's snapshot → whole steak rate unavailable (no partial pairing)
  const d1 = buildImpactDashboard(dashInput({ portions: PORTIONS.filter((p) => p.serviceId !== B) }));
  const steak1 = d1.targets.find((r) => r.factorKey === 'ancho-flank-steak')!;
  assert.equal(steak1.portionsServed, null);
  assert.equal(steak1.perPortion, null);
  // unavailable rates rank last
  assert.equal(d1.targets.at(-1)!.factorKey, 'ancho-flank-steak');

  // duplicate snapshots are ambiguous → missing; wrong hall filtered out
  const dup = buildImpactDashboard(dashInput({ portions: [...PORTIONS, portion(A, 'pepperoni-pizza', 99)] }));
  assert.equal(dup.targets.find((r) => r.factorKey === 'pepperoni-pizza')!.portionsServed, null);
  const otherHall = buildImpactDashboard(dashInput({ portions: PORTIONS.map((p) => ({ ...p, hallId: 'other' })) }));
  assert.ok(otherHall.targets.every((r) => r.perPortion === null));
  assert.equal(otherHall.labels.demoPortions, false);
});

test('dashboard: neighbor-food coverage counts flagged counted attempts (Map or record, absent ⇒ 0)', () => {
  assert.equal(countNeighborFoodExcluded(undefined), 0);
  assert.equal(countNeighborFoodExcluded(new Map([['a', [NEIGHBOR_FOOD_EXCLUDED_FLAG]], ['b', [NEIGHBOR_FOOD_EXCLUDED_FLAG]], ['c', []]])), 2);
  const { attemptQualityFlags: _drop, ...noFlags } = dashInput();
  assert.equal(buildImpactDashboard(noFlags).coverage.capturesWithNeighborFoodExcluded, 0);
  assert.equal(NEIGHBOR_FOOD_EXCLUDED_FLAG, 'neighbor_food_excluded');
});

test('dashboard: empty window', () => {
  const d = buildImpactDashboard(dashInput({ measurements: [], attemptQualityFlags: {}, captures: { captures: 0, analyzed: 0, excluded: 0 } }));
  assert.deepEqual([d.targets.length, d.mostWasted.length, d.totals.pixels], [0, 0, 0]);
  assert.deepEqual([d.totals.co2Points, d.totals.waterPoints, d.totals.impactPoints, d.totals.nutritionPoints], [null, null, null, null]);
  assert.equal(d.labels.demoPortions, false);
  assert.equal(d.coverage.capturesWithNeighborFoodExcluded, 0);
});

test('dashboard: only analyzed clean plates is a measured zero', () => {
  const d = buildImpactDashboard(dashInput({ measurements: [], attemptQualityFlags: {}, captures: { captures: 2, analyzed: 2, excluded: 0 } }));
  assert.deepEqual([d.totals.pixels, d.totals.impactPoints, d.totals.co2Points, d.totals.nutritionPoints], [0, 0, 0, 0]);
  const failedOnly = buildImpactDashboard(dashInput({ measurements: [], attemptQualityFlags: {}, captures: { captures: 1, analyzed: 0, excluded: 1 } }));
  assert.equal(failedOnly.totals.impactPoints, null, 'excluded captures never become zero waste');
});

// ---- eligibility helper -------------------------------------------------

test('selectImpactMeasurements reuses validMaskCount and counts exclusions', () => {
  const service: MealService = { serviceId: A, hallId: 'h', hallTimezone: 'America/Detroit', serviceDate: '2026-10-01', mealLabel: 'dinner', menuId: 'menu_A', menuVersion: 1 };
  const menuItems: MenuItem[] = [{ itemId: id(A, 'pepperoni-pizza'), menuId: 'menu_A', displayName: 'Pepperoni Pizza' }];
  const geometry = { widthPx: 100, heightPx: 100, coordinateSpace: 'topdown-normalized-v1' as const };
  const capture = (eventId: string, state: CaptureEvent['state'] = 'succeeded'): CaptureEvent => ({
    eventId, hallId: 'h', serviceId: A, capturedAt: '2026-10-01T23:00:00Z', imageObjectId: `img-${eventId}`, geometry, source: 'replay', qualityFlags: [], state,
  });
  const fm = (eventId: string, itemId: string | null, px: number, extra: Partial<FoodMeasurement> = {}): FoodMeasurement => ({
    measurementId: `${eventId}-${itemId}`, eventId, attemptId: `att-${eventId}`, itemId, remainingAreaPx: px, method: 'mask_pixel_count', qualityFlags: [],
    maskCount: { pixelsWasted: px, maskObjectId: 'mask', geometry, menuId: 'menu_A', menuVersion: 1, classificationVersion: 'c', segmentationVersion: 's', processingVersion: 'p', assignment: 'exclusive', validated: true },
    ...extra,
  });
  const r = selectImpactMeasurements({
    services: [service],
    captures: [capture('ok'), capture('clean'), capture('failed', 'failed'), capture('legacy')],
    measurements: [
      fm('ok', id(A, 'pepperoni-pizza'), 400), fm('ok', null, 50),
      fm('failed', id(A, 'pepperoni-pizza'), 300),
      { ...fm('legacy', id(A, 'pepperoni-pizza'), 200), method: 'gemini_area_estimate' },
    ],
    menuItems,
  });
  assert.deepEqual(r.captures, { captures: 4, analyzed: 2, excluded: 2 });
  assert.equal(r.excludedMeasurements, 2);
  assert.deepEqual(r.measurements, [
    { eventId: 'ok', serviceId: A, menuVersion: 1, itemId: id(A, 'pepperoni-pizza'), displayName: 'Pepperoni Pizza', pixels: 400 },
    { eventId: 'ok', serviceId: A, menuVersion: 1, itemId: null, displayName: UNKNOWN_FOOD_LABEL, pixels: 50 },
  ]);
});


// ---- recommendation -----------------------------------------------------

const NOW = new Date('2026-10-03T12:00:00.000Z');
const gatewayReturning = (raw: string | Error): TextGateway & { prompts: string[] } => {
  const prompts: string[] = [];
  return {
    prompts,
    async generateText(prompt: string) {
      prompts.push(prompt);
      if (raw instanceof Error) throw raw;
      return raw;
    },
  };
};

const STEAK_RATE = 'Ancho Flank Steak: 1,750 pixels wasted per portion';
const PLATES = '3 of 4 plates analyzed';

test('point and rate formatting', () => {
  assert.equal(formatPoints(351.666), '352 relative impact points');
  assert.equal(formatPoints(5.96), '6 relative impact points'); // < 10 → one decimal, trailing zero dropped
  assert.equal(formatPoints(4.25), '4.3 relative impact points');
  assert.equal(formatPoints(0.123), '0.12 relative impact points');
  assert.equal(formatPixelRate(1750), '1,750 pixels');
  assert.equal(formatPixelRate(8.46), '8.5 pixels');
});

test('recommendation facts cite pixel and relative-impact metric strings shown on the dashboard', () => {
  const facts = recommendationFacts(buildImpactDashboard(dashInput()));
  assert.deepEqual(facts.allowedMetrics, [
    PLATES,
    'Total: 23,500 pixels wasted',
    'Total: 411 relative impact points',
    STEAK_RATE,
    'Pepperoni Pizza: 1,000 pixels wasted per portion',
    'Mystery Tofu: 200 pixels wasted per portion',
    'Ancho Flank Steak: 10,500 pixels wasted in total',
    'Pepperoni Pizza: 10,000 pixels wasted in total',
    'Mystery Tofu: 1,000 pixels wasted in total',
    'Ancho Flank Steak: 352 relative impact points',
    'Pepperoni Pizza: 60 relative impact points',
  ]);
  assert.equal(facts.targets.length, 3);
  assert.deepEqual(facts.targets[0], {
    food: 'Ancho Flank Steak', pixelsPerPortion: 1750, impactPointsPerPortion: 58.61, portionsServed: 6, portionsAreDemo: true, metric: STEAK_RATE,
  });
  assert.deepEqual(facts.highestImpact.map((h) => [h.food, h.impactPoints]), [['Ancho Flank Steak', 351.67], ['Pepperoni Pizza', 59.6]]);
  assert.equal(facts.unknownFoodPixels, 2000);
  assert.equal(facts.plates.withNeighborFoodExcluded, 1);
  assert.deepEqual(facts.labels, { relativeImpact: true, demoPortions: true });
  for (const metric of facts.allowedMetrics) assert.doesNotMatch(metric, /\b(g|kg|L|grams?|litres?|liters?)\b|\$/);
  const prompt = buildRecommendationPrompt(facts);
  assert.match(prompt, /allowedMetrics/);
  assert.match(prompt, /Do not claim a cause/);
  assert.match(prompt, /relative impact points/);
  assert.doesNotMatch(JSON.stringify(facts), /grams|kgCo2e|impactUsd|waterM3|calibration/);
});

test('fallback recommendation is labeled, grounded in pixels, and causal-claim free', () => {
  const d = buildImpactDashboard(dashInput());
  const rec = fallbackRecommendation(d, NOW);
  const facts = recommendationFacts(d);
  assert.equal(rec.source, 'fallback');
  assert.equal(rec.generatedAt, NOW.toISOString());
  assert.match(rec.text, /^Ancho Flank Steak had the most food left per portion/);
  assert.match(rec.text, /not a weight/);
  assert.match(rec.text, /demo/);
  assert.match(rec.text, /not the reason/);
  assert.equal(parseRecommendationOutput(JSON.stringify({ text: rec.text, bullets: rec.bullets }), facts) !== null, true, 'fallback passes the Gemini validator too');
  assert.deepEqual(rec.bullets.map((b) => b.metric), [STEAK_RATE, 'Pepperoni Pizza: 1,000 pixels wasted per portion', PLATES]);
  for (const b of rec.bullets) assert.ok(facts.allowedMetrics.includes(b.metric), b.metric);
  assert.match(rec.inputVersion, /^impact-rec-v2\|waste-factors-v3\|[0-9a-f]{8}$/);
  assert.equal(fallbackRecommendation(d, NOW).inputVersion, rec.inputVersion);

  // Only pizza has a portion rate: the steak shows up through its relative impact points.
  const pizzaOnly = buildImpactDashboard(dashInput({ portions: PORTIONS.filter((p) => p.itemId === id(A, 'pepperoni-pizza')) }));
  const rec2 = fallbackRecommendation(pizzaOnly, NOW);
  assert.match(rec2.text, /^Pepperoni Pizza had the most food left per portion/);
  const heavy = rec2.bullets.find((b) => b.metric === 'Ancho Flank Steak: 352 relative impact points');
  assert.ok(heavy, JSON.stringify(rec2.bullets));
  assert.match(heavy.text, /highest relative impact points/);
  assert.doesNotMatch(rec2.text, /portion counts are demo/);

  // No portions at all: total pixels lead.
  const noPortions = fallbackRecommendation(buildImpactDashboard(dashInput({ portions: [] })), NOW);
  assert.match(noPortions.text, /^Ancho Flank Steak had the most food left in total\. Enter portions served/);
  assert.equal(noPortions.bullets[0]!.metric, 'Ancho Flank Steak: 10,500 pixels wasted in total');

  const empty = fallbackRecommendation(buildImpactDashboard(dashInput({ measurements: [], captures: { captures: 0, analyzed: 0, excluded: 0 } })), NOW);
  assert.match(empty.text, /Not enough analyzed plates/);
  assert.equal(empty.bullets[0]!.metric, '0 of 0 plates analyzed');
});

test('generateRecommendation accepts valid Gemini JSON', async () => {
  const d = buildImpactDashboard(dashInput());
  const gw = gatewayReturning(
    '```json\n' +
      JSON.stringify({
        text: 'Ancho Flank Steak has the most food left per portion and the highest relative impact points. The sample is small.',
        bullets: [
          { text: 'Try a smaller steak portion and compare next week.', metric: STEAK_RATE },
          { text: 'Steak leftovers weigh most on the relative impact points score.', metric: 'Ancho Flank Steak: 352 relative impact points' },
          { text: 'Keep scanning plates.', metric: PLATES },
        ],
      }) +
      '\n```',
  );
  const rec = await generateRecommendation(gw, d, NOW);
  assert.equal(rec.source, 'gemini');
  assert.equal(rec.bullets.length, 3);
  assert.equal(rec.inputVersion, fallbackRecommendation(d, NOW).inputVersion);
  assert.equal(gw.prompts.length, 1);
});

test('generateRecommendation falls back on invalid or unsafe Gemini output', async () => {
  const d = buildImpactDashboard(dashInput());
  const ok = { text: 'Steak leads per portion. Small sample.', bullets: [{ text: 'Watch steak.', metric: STEAK_RATE }, { text: 'Scan more.', metric: PLATES }] };
  const bad: Array<string | Error> = [
    'Serve less steak.', // not JSON
    '{"text": "x"}', // no bullets
    JSON.stringify({ ...ok, bullets: [ok.bullets[0]] }), // too few bullets
    JSON.stringify({ ...ok, bullets: [ok.bullets[0], { text: 'Made up.', metric: 'Steak: 99 pixels wasted per portion' }] }), // invented metric
    JSON.stringify({ ...ok, bullets: [ok.bullets[0], { text: 'Old unit.', metric: 'Ancho Flank Steak: 5.2 g wasted per portion' }] }), // v1 gram metric
    JSON.stringify({ ...ok, text: 'Students dislike the steak.' }), // causal claim
    JSON.stringify({ ...ok, text: 'Steak wasted about 3 kg of food.' }), // physical unit
    JSON.stringify({ ...ok, text: 'Steak leftovers cost $12 this week.' }), // dollars
    JSON.stringify({ ...ok, text: 'Steak wasted 40 liters of water.' }), // litres
    JSON.stringify({ ...ok, text: 'Steak scored 352 points.' }), // bare "points"
    JSON.stringify({ ...ok, text: '' }),
    new Error('provider timeout'),
  ];
  for (const raw of bad) {
    const rec = await generateRecommendation(gatewayReturning(raw), d, NOW);
    assert.equal(rec.source, 'fallback', String(raw));
    assert.deepEqual(rec, fallbackRecommendation(d, NOW));
  }
  assert.equal((await generateRecommendation(null, d, NOW)).source, 'fallback');
  // no data: the gateway is not called
  const gw = gatewayReturning(JSON.stringify(ok));
  const empty = buildImpactDashboard(dashInput({ measurements: [], captures: { captures: 0, analyzed: 0, excluded: 0 } }));
  assert.equal((await generateRecommendation(gw, empty, NOW)).source, 'fallback');
  assert.equal(gw.prompts.length, 0);
});

test('selectImpactMeasurements validates a capture against the menu version its attempt froze', () => {
  // The service was revised to v2; this capture was analyzed against v1 and its item left the menu.
  const service: MealService = { serviceId: A, hallId: 'h', hallTimezone: 'America/Detroit', serviceDate: '2026-10-01', mealLabel: 'dinner', menuId: 'menu_A', menuVersion: 2 };
  const rice = id(A, 'jasmine-rice');
  const geometry = { widthPx: 100, heightPx: 100, coordinateSpace: 'topdown-normalized-v1' as const };
  const capture: CaptureEvent = { eventId: 'old', hallId: 'h', serviceId: A, capturedAt: '2026-10-01T23:00:00Z', imageObjectId: 'img-old', geometry, source: 'camera', qualityFlags: [], state: 'succeeded' };
  const fm: FoodMeasurement = {
    measurementId: 'old-rice', eventId: 'old', attemptId: 'att-old', itemId: rice, remainingAreaPx: 300, method: 'mask_pixel_count', qualityFlags: [],
    maskCount: { pixelsWasted: 300, maskObjectId: 'mask', geometry, menuId: 'menu_A', menuVersion: 1, classificationVersion: 'c', segmentationVersion: 's', processingVersion: 'p', assignment: 'exclusive', validated: true },
  };
  const menuItems: MenuItem[] = [{ itemId: rice, menuId: 'menu_A', displayName: 'Jasmine Rice' }];
  const base = { services: [service], captures: [capture], measurements: [fm], menuItems };
  assert.deepEqual(selectImpactMeasurements(base).captures, { captures: 1, analyzed: 0, excluded: 1 }, 'v1 mask vs current v2: excluded');
  const r = selectImpactMeasurements({ ...base, attemptMenuVersions: new Map([['old', 1]]) });
  assert.deepEqual(r.captures, { captures: 1, analyzed: 1, excluded: 0 });
  assert.deepEqual(r.measurements, [{ eventId: 'old', serviceId: A, menuVersion: 1, itemId: rice, displayName: 'Jasmine Rice', pixels: 300 }]);
  // An item from another menu is still rejected.
  const foreign = selectImpactMeasurements({ ...base, menuItems: [{ ...menuItems[0]!, menuId: 'menu_B' }], attemptMenuVersions: new Map([['old', 1]]) });
  assert.equal(foreign.captures.analyzed, 0);
});
