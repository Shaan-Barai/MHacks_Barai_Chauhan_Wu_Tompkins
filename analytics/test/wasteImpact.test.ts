import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImpactDashboard,
  computeWasteImpact,
  fallbackRecommendation,
  generateRecommendation,
  buildRecommendationPrompt,
  recommendationFacts,
  selectImpactMeasurements,
  sumImpacts,
  impactCoverage,
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
  PlateCalibration,
  PortionsServed,
  WasteFactor,
} from '../src/contracts.js';

// Rows copied from menu_waste_factors.csv / menu_nutrition_factors.csv (waste-factors-v2).
const PIZZA: WasteFactor = {
  factorKey: 'pepperoni-pizza', food: 'Pepperoni Pizza', station: 'Pizziti',
  weightGPerCm2: 1.0, kgCo2ePerKg: 16.06, waterM3PerKg: 1.94, impactUsdPerKg: 5.96, largestFactor: 'carbon',
};
const STEAK: WasteFactor = {
  factorKey: 'ancho-flank-steak', food: 'Ancho Flank Steak', station: 'Halal',
  weightGPerCm2: 1.2, kgCo2ePerKg: 131.69, waterM3PerKg: 1.925, impactUsdPerKg: 27.91, largestFactor: 'carbon',
};
const PIZZA_N: NutritionFactor = { factorKey: 'pepperoni-pizza', nutrientDaysPerKg: 0.69, kcalPerKg: 2700 };
const STEAK_N: NutritionFactor = { factorKey: 'ancho-flank-steak', nutrientDaysPerKg: 1.05, kcalPerKg: 1600 };

function cal(cm2PerPx: number, method: PlateCalibration['method'] = 'plate-fit-v1'): PlateCalibration {
  return {
    method, plateDiameterCm: 26.7, plateDiameterPx: 26.7 / Math.sqrt(cm2PerPx), cm2PerPx,
    flags: method === 'configured-default' ? ['calibration_default'] : [],
  };
}
/** README calibration: a 26.7 cm plate spanning 600 px. */
const CAL_600: PlateCalibration = { ...cal((26.7 / 600) ** 2), plateDiameterPx: 600 };

const close = (actual: number | null, expected: number, eps = 1e-9) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= eps, `${actual} !== ${expected}`);

test('README pepperoni pizza example: 10,000 px on a 600 px plate', () => {
  const i = computeWasteImpact(10_000, CAL_600, PIZZA, PIZZA_N);
  close(i.cm2, 19.8025); // 10,000 × 0.0445²
  close(i.grams, 19.8025); // × 1.0 g/cm²
  close(i.kgCo2e, 0.31802815); // 0.0198025 kg × 16.06
  close(i.waterM3, 0.03841685); // × 1.94 (38.4 L)
  close(i.impactUsd, 0.1180229); // × $5.96
  close(i.nutrientDaysLost, 0.013663725); // × 0.69, separate
  assert.equal(i.pixels, 10_000);
  assert.equal(i.wasteFactorsVersion, WASTE_FACTORS_VERSION);
  assert.equal(i.unavailableReason, undefined);
});

test('nutrition never changes impactUsd', () => {
  const withN = computeWasteImpact(10_000, CAL_600, PIZZA, PIZZA_N);
  const without = computeWasteImpact(10_000, CAL_600, PIZZA, null);
  assert.equal(withN.impactUsd, without.impactUsd);
  assert.equal(without.nutrientDaysLost, null);
  // impact $ = kg × (0.19 C + 1.50 W) within the CSV's cent rounding
  close(withN.impactUsd, 0.0198025 * (0.19 * 16.06 + 1.5 * 1.94), 0.0198025 * 0.005);
});

test('no calibration, no factor, unknown item: unavailable with reasons, never zero', () => {
  const noCal = computeWasteImpact(5000, null, PIZZA, PIZZA_N);
  assert.deepEqual(
    [noCal.pixels, noCal.cm2, noCal.grams, noCal.impactUsd, noCal.nutrientDaysLost, noCal.unavailableReason],
    [5000, null, null, null, null, 'no_calibration'],
  );
  const badCal = computeWasteImpact(5000, { ...CAL_600, cm2PerPx: 0 }, PIZZA, null);
  assert.equal(badCal.unavailableReason, 'no_calibration');

  const noFactor = computeWasteImpact(5000, cal(0.002), null, null);
  close(noFactor.cm2, 10);
  assert.equal(noFactor.grams, null);
  assert.equal(noFactor.unavailableReason, 'no_factor');

  const unknown = computeWasteImpact(5000, cal(0.002), PIZZA, PIZZA_N, { unknownItem: true });
  close(unknown.cm2, 10);
  assert.equal(unknown.grams, null);
  assert.equal(unknown.kgCo2e, null);
  assert.equal(unknown.unavailableReason, 'unknown_item');

  const zero = computeWasteImpact(0, cal(0.002), PIZZA, PIZZA_N);
  assert.equal(zero.grams, 0);
  assert.equal(zero.impactUsd, 0);

  for (const bad of [-1, NaN, Infinity]) assert.throws(() => computeWasteImpact(bad, CAL_600, PIZZA, null), RangeError);
});

test('sumImpacts sums available values and keeps unavailable ones out (not zero)', () => {
  const a = computeWasteImpact(5000, cal(0.002), STEAK, STEAK_N); // 10 cm², 12 g
  const b = computeWasteImpact(2000, null, PIZZA, null); // no calibration
  const c = computeWasteImpact(1000, cal(0.002), null, null); // 2 cm², no factor
  const s = sumImpacts([a, b, c]);
  assert.equal(s.pixels, 8000);
  close(s.cm2, 12);
  close(s.grams, 12);
  close(s.impactUsd, 0.012 * 27.91);
  close(s.nutrientDaysLost, 0.012 * 1.05);
  assert.equal(s.unavailableReason, 'no_calibration'); // tie → order unknown_item, no_calibration, no_factor
  assert.deepEqual(impactCoverage([a, b, c]), { withGrams: 1, unavailable: { unknown_item: 0, no_calibration: 1, no_factor: 1 } });

  const none = sumImpacts([b]);
  assert.equal(none.grams, null);
  assert.equal(none.pixels, 2000);
  const empty = sumImpacts([]);
  assert.deepEqual([empty.pixels, empty.grams, empty.impactUsd], [0, 0, 0]);
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
  m('e1', A, id(A, 'ancho-flank-steak'), 'Ancho Flank Steak', 5000), // 10 cm² → 12 g
  m('e1', A, id(A, 'pepperoni-pizza'), 'Pepperoni Pizza', 10000), // 20 cm² → 20 g
  m('e1', A, null, UNKNOWN_FOOD_LABEL, 2000), // 4 cm², no grams
  m('e2', A, id(A, 'ancho-flank-steak'), 'Ancho Flank Steak', 3000), // 6 cm² → 7.2 g
  m('e2', A, id(A, 'mystery-tofu'), 'Mystery Tofu', 1000), // 2 cm², no factor
  m('e3', B, id(B, 'ancho-flank-steak'), 'Ancho Flank Steak', 2500), // default cal 0.004: 10 cm² → 12 g
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
    calibrations: { e1: cal(0.002), e2: cal(0.002), e3: cal(0.004, 'configured-default') },
    captures: { captures: 4, analyzed: 3, excluded: 1 },
    menuItems: [],
    portions: PORTIONS,
    factors: lookups,
    ...over,
  };
}

test('dashboard: totals, sum-then-divide per portion, ranking, coverage, labels', () => {
  const d = buildImpactDashboard(dashInput());
  // totals: every pixel counted; grams only where calibrated + factor
  assert.equal(d.totals.pixels, 23500);
  close(d.totals.cm2, 52);
  close(d.totals.grams, 51.2); // steak 31.2 + pizza 20
  close(d.totals.impactUsd, 0.0312 * 27.91 + 0.02 * 5.96);
  close(d.totals.kgCo2e, 0.0312 * 131.69 + 0.02 * 16.06);
  close(d.totals.nutrientDaysLost, 0.0312 * 1.05 + 0.02 * 0.69);
  assert.equal(d.totals.unavailableReason, 'unknown_item');
  assert.deepEqual([d.totals.captures, d.totals.analyzedCaptures, d.totals.excludedCaptures], [4, 3, 1]);

  // steak spans two services: (12 + 7.2 + 12) g ÷ (4 + 2) portions = 5.2 g, not mean of rates (5.4)
  const steak = d.targets[0]!;
  assert.equal(steak.displayName, 'Ancho Flank Steak');
  assert.equal(steak.itemId, id(B, 'ancho-flank-steak'));
  assert.equal(steak.factorKey, 'ancho-flank-steak');
  assert.equal(steak.portionsServed, 6);
  assert.equal(steak.portionsSource, 'demo');
  close(steak.impact.grams, 31.2);
  close(steak.perPortion!.grams, 5.2);
  close(steak.perPortion!.pixels, 10500 / 6);
  close(steak.perPortion!.impactUsd, (0.0312 * 27.91) / 6);

  assert.deepEqual(d.targets.map((r) => r.displayName), ['Ancho Flank Steak', 'Pepperoni Pizza', 'Mystery Tofu']);
  close(d.targets[1]!.perPortion!.grams, 2); // 20 g ÷ 10
  assert.equal(d.targets[1]!.portionsSource, 'manual');
  const tofu = d.targets[2]!;
  assert.equal(tofu.factorKey, null);
  assert.equal(tofu.impact.unavailableReason, 'no_factor');
  assert.equal(tofu.perPortion!.grams, null);
  assert.equal(tofu.perPortion!.pixels, 200);

  assert.deepEqual(d.mostWasted.map((r) => r.displayName), ['Ancho Flank Steak', 'Pepperoni Pizza', UNKNOWN_FOOD_LABEL, 'Mystery Tofu']);
  const unknown = d.mostWasted[2]!;
  assert.equal(unknown.itemId, null);
  assert.equal(unknown.perPortion, null);
  assert.equal(unknown.portionsServed, null);
  assert.equal(unknown.impact.unavailableReason, 'unknown_item');

  assert.deepEqual(d.coverage, { itemsWithFactor: 2, itemsWithoutFactor: 1, itemsWithPortions: 3, capturesWithDefaultCalibration: 1 });
  assert.deepEqual(d.labels, { estimate: true, demoPortions: true });
  assert.deepEqual(d.window, { start: '2026-10-01', end: '2026-10-02', hallId: 'h' });
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

test('dashboard: a capture without calibration keeps pixels but blocks the gram rate', () => {
  const d = buildImpactDashboard(dashInput({ calibrations: new Map([['e2', cal(0.002)], ['e3', cal(0.004)]]) }));
  const steak = d.mostWasted.find((r) => r.factorKey === 'ancho-flank-steak')!;
  close(steak.impact.grams, 19.2); // e1 steak has no calibration: 7.2 + 12
  assert.equal(steak.impact.pixels, 10500);
  assert.equal(steak.perPortion!.grams, null);
  assert.equal(steak.perPortion!.impactUsd, null);
  close(steak.perPortion!.pixels, 1750);
  const pizza = d.mostWasted.find((r) => r.factorKey === 'pepperoni-pizza')!;
  assert.equal(pizza.impact.grams, null);
  assert.equal(pizza.impact.unavailableReason, 'no_calibration');
  assert.equal(d.coverage.capturesWithDefaultCalibration, 0);
});

test('dashboard: empty window', () => {
  const d = buildImpactDashboard(dashInput({ measurements: [], calibrations: {}, captures: { captures: 0, analyzed: 0, excluded: 0 } }));
  assert.deepEqual([d.targets.length, d.mostWasted.length, d.totals.pixels, d.totals.grams], [0, 0, 0, 0]);
  assert.equal(d.labels.demoPortions, false);
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

test('recommendation facts cite metric strings shown on the dashboard', () => {
  const facts = recommendationFacts(buildImpactDashboard(dashInput()));
  assert.ok(facts.allowedMetrics.includes('Ancho Flank Steak: 5.2 g wasted per portion'));
  assert.ok(facts.allowedMetrics.includes('Pepperoni Pizza: 2 g wasted per portion'));
  assert.ok(facts.allowedMetrics.includes('Ancho Flank Steak: 31 g wasted in total'));
  assert.ok(facts.allowedMetrics.includes('3 of 4 plates analyzed'));
  assert.ok(facts.allowedMetrics.includes('Total: 51 g of food wasted (estimate)'));
  assert.equal(facts.targets.length, 2); // tofu has no gram rate
  assert.equal(facts.unknownFoodPixels, 2000);
  const prompt = buildRecommendationPrompt(facts);
  assert.match(prompt, /allowedMetrics/);
  assert.match(prompt, /Do not claim a cause/);
});

test('fallback recommendation is labeled, grounded, and causal-claim free', () => {
  const d = buildImpactDashboard(dashInput());
  const rec = fallbackRecommendation(d, NOW);
  const facts = recommendationFacts(d);
  assert.equal(rec.source, 'fallback');
  assert.equal(rec.generatedAt, NOW.toISOString());
  assert.match(rec.text, /^Ancho Flank Steak had the most estimated food left per portion/);
  assert.match(rec.text, /estimates/);
  assert.match(rec.text, /demo/);
  assert.match(rec.text, /not the reason/);
  assert.ok(rec.bullets.length >= 2 && rec.bullets.length <= 4);
  for (const b of rec.bullets) assert.ok(facts.allowedMetrics.includes(b.metric), b.metric);
  assert.equal(rec.bullets[0]!.metric, 'Ancho Flank Steak: 5.2 g wasted per portion');
  assert.match(rec.inputVersion, /^impact-rec-v1\|waste-factors-v2\|[0-9a-f]{8}$/);
  assert.equal(fallbackRecommendation(d, NOW).inputVersion, rec.inputVersion);

  const empty = fallbackRecommendation(buildImpactDashboard(dashInput({ measurements: [], captures: { captures: 0, analyzed: 0, excluded: 0 } })), NOW);
  assert.match(empty.text, /Not enough analyzed plates/);
  assert.equal(empty.bullets[0]!.metric, '0 of 0 plates analyzed');
});

test('generateRecommendation accepts valid Gemini JSON', async () => {
  const d = buildImpactDashboard(dashInput());
  const gw = gatewayReturning(
    '```json\n' +
      JSON.stringify({
        text: 'Ancho Flank Steak has the most estimated food left per portion. These are photo estimates from a small sample.',
        bullets: [
          { text: 'Try a smaller steak portion and compare next week.', metric: 'Ancho Flank Steak: 5.2 g wasted per portion' },
          { text: 'Keep scanning plates.', metric: '3 of 4 plates analyzed' },
        ],
      }) +
      '\n```',
  );
  const rec = await generateRecommendation(gw, d, NOW);
  assert.equal(rec.source, 'gemini');
  assert.equal(rec.bullets.length, 2);
  assert.equal(rec.inputVersion, fallbackRecommendation(d, NOW).inputVersion);
  assert.equal(gw.prompts.length, 1);
});

test('generateRecommendation falls back on invalid or unsafe Gemini output', async () => {
  const d = buildImpactDashboard(dashInput());
  const ok = { text: 'Steak leads per portion. Estimates only.', bullets: [{ text: 'Watch steak.', metric: 'Ancho Flank Steak: 5.2 g wasted per portion' }, { text: 'Scan more.', metric: '3 of 4 plates analyzed' }] };
  const bad: Array<string | Error> = [
    'Serve less steak.', // not JSON
    '{"text": "x"}', // no bullets
    JSON.stringify({ ...ok, bullets: [ok.bullets[0]] }), // too few bullets
    JSON.stringify({ ...ok, bullets: [ok.bullets[0], { text: 'Made up.', metric: 'Steak: 99 g wasted per portion' }] }), // invented metric
    JSON.stringify({ ...ok, text: 'Students dislike the steak.' }), // causal claim
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
