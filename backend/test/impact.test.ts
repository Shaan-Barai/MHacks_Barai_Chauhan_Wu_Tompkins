/**
 * Waste-impact endpoints (BIG-PLAN v2: pixels + relative impact points, no
 * plate calibration, no grams) over hand-calculated fixtures:
 * GET /api/dashboard/impact, GET /api/captures, GET /api/recommendation,
 * GET /api/dashboard/daily. Offline: mock analyzer, local-dev storage,
 * in-memory repo, no live Gemini.
 *
 * Factor rows (menu_waste_factors.csv via scrap-data):
 *   Baked Boneless Ham            0.9 g/cm², C 12.39, W 1.808, score 5.07
 *   Oven Roasted Garlic Potatoes  1.6 g/cm², C 0.62,  W 0.117, score 0.29
 *   Mystery Stew                  no factor row
 *
 * points = pixels / 1000 × weight × factor
 * cap_a: ham 10,000 px -> base 9 -> 45.63 points; potatoes 5,000 px -> base 8 -> 2.32 points.
 *        Its attempt carries 'neighbor_food_excluded' (food on another dish was dropped).
 * cap_b: ham 4,000 px -> base 3.6 -> 18.252 points; unknown food 1,000 px (no points)
 * cap_c: analysis failed (excluded, never zero)
 * Portions (manual): ham 30, potatoes 100.
 *   ham 14,000 px / 30 = 466.67 px/portion (63.882 / 30 = 2.1294 points/portion)
 *   potatoes 5,000 px / 100 = 50 px/portion (0.0232 points/portion)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { WASTE_FACTORS, findWasteFactor } from 'scrap-data';
import { startTestServer, type TestServer } from './helpers.js';
import { NEIGHBOR_FOOD_EXCLUDED, type GeminiGateway } from '@scrap/vision';
import { NEIGHBOR_FOOD_EXCLUDED_FLAG, recommendationFacts, recommendationInputVersion } from '@scrap/analytics';
import type { MenuBundle, QualityFlag } from '../src/types.js';

const HALL = 'hall-impact';
const DATE = '2026-10-02';
const SERVICE = `svc_${HALL}_${DATE}_dinner`;
const MENU_ID = `menu_${HALL}_${DATE}_dinner`;
const HAM = `item_${HALL}_ham`;
const POTATOES = `item_${HALL}_potatoes`;
const STEW = `item_${HALL}_stew`;

const MENU: MenuBundle = {
  service: { serviceId: SERVICE, hallId: HALL, hallTimezone: 'America/Detroit', serviceDate: DATE, mealLabel: 'dinner', menuId: MENU_ID, menuVersion: 1 },
  items: [
    { itemId: HAM, menuId: MENU_ID, displayName: 'Baked Boneless Ham' },
    { itemId: POTATOES, menuId: MENU_ID, displayName: 'Oven Roasted Garlic Potatoes' },
    { itemId: STEW, menuId: MENU_ID, displayName: 'Mystery Stew' },
  ],
};

const GEOMETRY = { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' as const };
/** Vision's target-dish flag; matched as a string until it joins contracts QualityFlag. */
const NEIGHBOR = NEIGHBOR_FOOD_EXCLUDED_FLAG as QualityFlag;
const close = (actual: number | null | undefined, expected: number, msg?: string) =>
  assert.ok(actual !== null && actual !== undefined && Math.abs(actual - expected) < 1e-6, `${msg ?? ''} expected ${expected}, got ${actual}`);
// Legacy v1 keys never return; IT_4 grams/kgCo2e/waterLitres are null (never 0) without a calibration.
const GRAM_KEYS = /"(cm2|waterM3|impactUsd|nutrientDaysLost|calibration|capturesWithDefaultCalibration|estimate)"/;

async function capture(s: TestServer, eventId: string, capturedAt: string) {
  const imageObjectId = await s.uploadImage(eventId);
  const res = await s.api('POST', '/api/captures', { eventId, hallId: HALL, serviceId: SERVICE, capturedAt, imageObjectId, geometry: GEOMETRY, source: 'replay' });
  assert.ok(res.status === 201, JSON.stringify(res.json));
  return res.json;
}

async function seeded(opts: Parameters<typeof startTestServer>[1] = {}): Promise<TestServer> {
  const s = await startTestServer(undefined, opts);
  assert.equal((await s.api('POST', '/api/menus', MENU)).status, 201);
  s.fixtures.cap_a = {
    measurements: [
      { itemId: HAM, remainingAreaPx: 10000 },
      { itemId: POTATOES, remainingAreaPx: 5000 },
    ],
    qualityFlags: [NEIGHBOR],
  };
  s.fixtures.cap_b = {
    measurements: [
      { itemId: HAM, remainingAreaPx: 4000 },
      { itemId: null, remainingAreaPx: 1000 },
    ],
  };
  s.fixtures.cap_c = { status: 'failed', errorCode: 'GEMINI_TIMEOUT', qualityFlags: [NEIGHBOR] };
  await capture(s, 'cap_a', `${DATE}T22:00:00.000Z`);
  await capture(s, 'cap_b', `${DATE}T22:30:00.000Z`);
  await capture(s, 'cap_c', `${DATE}T23:00:00.000Z`);
  const put = await s.api('PUT', `/api/portions-served?hallId=${HALL}&serviceId=${SERVICE}`, {
    serviceId: SERVICE,
    menuVersion: 1,
    entries: [
      { itemId: HAM, count: 30 },
      { itemId: POTATOES, count: 100 },
    ],
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  return s;
}

test('analytics counts the same neighbor flag that vision emits', () => {
  assert.equal(NEIGHBOR_FOOD_EXCLUDED, NEIGHBOR_FOOD_EXCLUDED_FLAG);
});

test('fixture factor rows exist as the hand calculation assumes', () => {
  const ham = findWasteFactor('Baked Boneless Ham');
  const potatoes = findWasteFactor('Oven Roasted Garlic Potatoes');
  assert.deepEqual([ham?.weightGPerCm2, ham?.kgCo2ePerKg, ham?.waterM3PerKg, ham?.impactUsdPerKg], [0.9, 12.39, 1.808, 5.07]);
  assert.deepEqual([potatoes?.weightGPerCm2, potatoes?.impactUsdPerKg], [1.6, 0.29]);
  assert.equal(findWasteFactor('Mystery Stew'), null);
  assert.ok(WASTE_FACTORS.length >= 23);
});

test('GET /api/dashboard/impact: pixel totals, relative points, px-per-portion targets, coverage', async (t) => {
  const s = await seeded();
  t.after(() => s.close());
  const res = await s.api('GET', `/api/dashboard/impact?start=${DATE}&end=${DATE}&hallId=${HALL}`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const d = res.json;
  assert.doesNotMatch(JSON.stringify(d), GRAM_KEYS, 'no legacy calibration keys');
  assert.equal(d.totals.grams, null, 'uncalibrated: grams null, never 0');
  assert.equal(d.totals.kgCo2e, null);
  assert.equal(d.totals.waterLitres, null);
  assert.equal(d.totals.physicalUnavailableReason, 'no_calibration');
  assert.deepEqual(d.totals.physicalCoverage, { calibratedCaptures: 0, analyzedCaptures: 2 });
  assert.deepEqual(d.window, { start: DATE, end: DATE, hallId: HALL });
  assert.equal(d.totals.pixels, 20000);
  close(d.totals.impactPoints, 45.63 + 18.252 + 2.32, 'total impact points'); // 66.202
  close(d.totals.co2Points, 12.6 * 12.39 + 8 * 0.62, 'total co2 points');
  close(d.totals.waterPoints, 12.6 * 1.808 + 8 * 0.117, 'total water points');
  close(d.totals.nutritionPoints, 12.6 * 0.38 + 8 * 0.56, 'total nutrition points (separate)');
  assert.equal(d.totals.unavailableReason, 'unknown_item');
  assert.equal(d.totals.captures, 3);
  assert.equal(d.totals.analyzedCaptures, 2);
  assert.equal(d.totals.excludedCaptures, 1);
  assert.equal(typeof d.totals.wasteFactorsVersion, 'string');
  assert.deepEqual(d.labels, { relativeImpact: true, demoPortions: false, sampleData: false });
  // cap_a's counted attempt is flagged; cap_c's failed attempt is not counted.
  assert.deepEqual(d.coverage, { itemsWithFactor: 2, itemsWithoutFactor: 0, itemsWithPortions: 2, capturesWithNeighborFoodExcluded: 1, sampleCaptures: 0 });

  const ham = d.mostWasted.find((r: any) => r.itemId === HAM);
  const potatoes = d.mostWasted.find((r: any) => r.itemId === POTATOES);
  assert.equal(ham.impact.pixels, 14000);
  close(ham.impact.impactPoints, 63.882, 'ham points');
  close(potatoes.impact.impactPoints, 2.32, 'potato points');
  assert.equal(ham.factorKey, 'baked-boneless-ham');
  assert.equal(ham.portionsServed, 30);
  assert.equal(ham.portionsSource, 'manual');
  close(ham.perPortion.pixels, 14000 / 30, 'ham px/portion');
  close(ham.perPortion.impactPoints, 63.882 / 30, 'ham points/portion');
  assert.equal(potatoes.perPortion.pixels, 50);
  close(potatoes.perPortion.impactPoints, 0.0232, 'potato points/portion');
  assert.deepEqual(d.mostWasted.map((r: any) => r.itemId), [HAM, POTATOES, null], 'most wasted by pixels');
  assert.deepEqual(d.targets.map((r: any) => r.itemId), [HAM, POTATOES], 'targets by pixels per portion');

  // Unknown food keeps its pixels, never invented points or a per-portion rate.
  const unknown = d.mostWasted[2];
  assert.equal(unknown.impact.pixels, 1000);
  assert.equal(unknown.impact.impactPoints, null);
  assert.equal(unknown.impact.unavailableReason, 'unknown_item');
  assert.equal(unknown.perPortion, null);

  // An empty window is a valid, empty dashboard; a bad window is a 400 envelope.
  const empty = await s.api('GET', '/api/dashboard/impact?start=2026-09-01&end=2026-09-02');
  assert.equal(empty.status, 200);
  assert.equal(empty.json.totals.pixels, 0);
  assert.equal(empty.json.totals.captures, 0);
  assert.equal(empty.json.coverage.capturesWithNeighborFoodExcluded, 0);
  for (const q of ['', '?start=2026-10-02', '?start=10/02/2026&end=2026-10-02', `?start=${DATE}&end=2026-10-01`]) {
    const bad = await s.api('GET', `/api/dashboard/impact${q}`);
    assert.equal(bad.status, 400, q);
    assert.equal(bad.json.error.code, 'INVALID_WINDOW');
    assert.equal(bad.json.error.retryable, false);
  }
});

test('GET /api/captures: newest first, item pixels, failed captures null (never zero), capped', async (t) => {
  const s = await seeded();
  t.after(() => s.close());
  const res = await s.api('GET', `/api/captures?start=${DATE}&end=${DATE}`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const list = res.json;
  assert.doesNotMatch(JSON.stringify(list), GRAM_KEYS);
  for (const c of list) {
    assert.equal(c.calibrationId, null);
    assert.equal(c.physicalMethod, null);
    for (const item of c.items) {
      assert.equal(item.grams, null);
      assert.equal(item.areaCm2, null);
    }
  }
  assert.deepEqual(list.map((c: any) => c.eventId), ['cap_c', 'cap_b', 'cap_a']);
  const [c, b, a] = list;
  assert.deepEqual(c, { eventId: 'cap_c', capturedAt: `${DATE}T23:00:00.000Z`, serviceId: SERVICE, source: 'replay', state: 'failed', pixelsWasted: null, items: [], hasOverlay: false, calibrationId: null, physicalMethod: null });
  assert.equal(a.state, 'succeeded');
  assert.equal(a.pixelsWasted, 15000);
  assert.equal(a.hasOverlay, false);
  assert.deepEqual(
    [...a.items].sort((x: any, y: any) => y.pixels - x.pixels),
    [
      { itemId: HAM, displayName: 'Baked Boneless Ham', pixels: 10000, grams: null, kgCo2e: null, waterLitres: null, areaCm2: null },
      { itemId: POTATOES, displayName: 'Oven Roasted Garlic Potatoes', pixels: 5000, grams: null, kgCo2e: null, waterLitres: null, areaCm2: null },
    ],
  );
  assert.equal(b.pixelsWasted, 5000);
  assert.deepEqual(b.items.find((i: any) => i.itemId === null), { itemId: null, displayName: 'Food not on the menu', pixels: 1000, grams: null, kgCo2e: null, waterLitres: null, areaCm2: null });

  const capped = await s.api('GET', `/api/captures?start=${DATE}&end=${DATE}&limit=1`);
  assert.deepEqual(capped.json.map((x: any) => x.eventId), ['cap_c']);
  const bad = await s.api('GET', `/api/captures?start=${DATE}&end=${DATE}&limit=0`);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'INVALID_PARAMETER');
});

test('GET /api/recommendation: labeled fallback without Gemini, grounded in pixels and relative points', async (t) => {
  const s = await seeded();
  t.after(() => s.close());
  const res = await s.api('GET', `/api/recommendation?start=${DATE}&end=${DATE}`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const r = res.json;
  assert.equal(r.source, 'fallback');
  assert.match(r.text, /^Baked Boneless Ham had the most food left per portion/);
  assert.deepEqual(r.bullets.map((b: any) => b.metric), [
    'Baked Boneless Ham: 467 pixels wasted per portion',
    'Oven Roasted Garlic Potatoes: 50 pixels wasted per portion',
    '2 of 3 plates analyzed',
  ]);
  assert.doesNotMatch(JSON.stringify(r), /\b(g|kg|grams?|litres?|liters?)\b|\$/);
  assert.match(r.inputVersion, /^impact-rec-v2\|/);
  assert.ok(Number.isFinite(Date.parse(r.generatedAt)));
  assert.equal((await s.api('GET', '/api/recommendation?start=x&end=y')).status, 400);
});

function liveGateway(generate: () => Promise<string>, calls: { n: number }): GeminiGateway {
  return {
    model: 'test-model',
    mode: 'live',
    async generateText() {
      calls.n++;
      return generate();
    },
  } as unknown as GeminiGateway;
}

test('GET /api/recommendation: provider failure -> labeled fallback; results cached per input', async (t) => {
  const calls = { n: 0 };
  const s = await seeded({
    gateway: liveGateway(async () => {
      throw new Error('provider down');
    }, calls),
  });
  t.after(() => s.close());
  const first = await s.api('GET', `/api/recommendation?start=${DATE}&end=${DATE}`);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.source, 'fallback');
  const callsAfterFirst = calls.n;
  assert.ok(callsAfterFirst >= 1, 'Gemini was tried');
  const second = await s.api('GET', `/api/recommendation?start=${DATE}&end=${DATE}`);
  assert.deepEqual(second.json, first.json, 'same statistics -> cached answer');
  assert.equal(calls.n, callsAfterFirst, 'no second provider call for identical input');

  // New data changes the input, so a new recommendation is generated.
  s.fixtures.cap_d = { measurements: [{ itemId: POTATOES, remainingAreaPx: 2000 }] };
  await capture(s, 'cap_d', `${DATE}T23:30:00.000Z`);
  const third = await s.api('GET', `/api/recommendation?start=${DATE}&end=${DATE}`);
  assert.equal(third.json.source, 'fallback');
  assert.ok(calls.n > callsAfterFirst, 'changed input -> Gemini tried again');
});

test('GET /api/recommendation: valid Gemini answer is served as source gemini and cached', async (t) => {
  const calls = { n: 0 };
  let metrics: string[] = [];
  const s = await seeded({
    gateway: liveGateway(
      async () =>
        JSON.stringify({
          text: 'Ham leaves the most pixels per portion and the highest relative impact points; try a smaller ham portion for a week.',
          bullets: [
            { text: 'Ham waste per portion.', metric: metrics.find((m) => m.includes('per portion')) },
            { text: 'Plates analyzed.', metric: metrics[0] },
          ],
        }),
      calls,
    ),
  });
  t.after(() => s.close());
  const dash = await s.api('GET', `/api/dashboard/impact?start=${DATE}&end=${DATE}`);
  metrics = recommendationFacts(dash.json).allowedMetrics;
  assert.ok(metrics.includes('Total: 66 relative impact points'), metrics.join(' | '));
  assert.ok(metrics.includes('Baked Boneless Ham: 64 relative impact points'));
  const first = await s.api('GET', `/api/recommendation?start=${DATE}&end=${DATE}`);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.source, 'gemini');
  assert.deepEqual(first.json.bullets.map((b: any) => b.metric), ['Baked Boneless Ham: 467 pixels wasted per portion', '2 of 3 plates analyzed']);
  assert.equal(first.json.inputVersion, recommendationInputVersion(recommendationFacts(dash.json)));
  const second = await s.api('GET', `/api/recommendation?start=${DATE}&end=${DATE}`);
  assert.deepEqual(second.json, first.json);
  assert.equal(calls.n, 1, 'one Gemini call for identical statistics');
});

test('GET /api/dashboard/daily: pixels per day, no grams; null (never 0) without counted plates', async (t) => {
  const s = await seeded();
  t.after(() => s.close());
  const res = await s.api('GET', `/api/dashboard/daily?hallId=${HALL}&start=2026-10-01&end=2026-10-02`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const [before, day] = res.json.days;
  assert.deepEqual(before, { date: '2026-10-01', pixelsWasted: null, capturedDishes: 0, countedDishes: 0, plateWastePercents: [] });
  assert.equal(day.pixelsWasted, 20000);
  assert.equal(day.capturedDishes, 3);
  assert.equal(day.countedDishes, 2);
  assert.equal('grams' in day, false);
});

test('impact totals, capture list, daily: missing points stay null, clean plates are a measured 0', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  assert.equal((await s.api('POST', '/api/menus', MENU)).status, 201);
  const none = await s.api('GET', `/api/dashboard/impact?start=${DATE}&end=${DATE}`);
  const t0 = none.json.totals;
  assert.deepEqual([t0.pixels, t0.co2Points, t0.waterPoints, t0.impactPoints, t0.nutritionPoints], [0, null, null, null, null]);

  s.fixtures.cap_failed = { status: 'failed' };
  await capture(s, 'cap_failed', `${DATE}T21:00:00.000Z`);
  const failed = await s.api('GET', `/api/dashboard/impact?start=${DATE}&end=${DATE}`);
  assert.equal(failed.json.totals.impactPoints, null, 'a failed capture is not zero waste');
  const failedDay = await s.api('GET', `/api/dashboard/daily?hallId=${HALL}&start=${DATE}&end=${DATE}`);
  assert.equal(failedDay.json.days[0].pixelsWasted, null);

  s.fixtures.cap_clean = { measurements: [] };
  await capture(s, 'cap_clean', `${DATE}T21:30:00.000Z`);
  const clean = await s.api('GET', `/api/dashboard/impact?start=${DATE}&end=${DATE}`);
  assert.equal(clean.json.totals.analyzedCaptures, 1);
  assert.equal(clean.json.totals.pixels, 0);
  assert.equal(clean.json.totals.impactPoints, 0, 'an analyzed clean plate is a measured zero');
  const list = await s.api('GET', `/api/captures?start=${DATE}&end=${DATE}`);
  const cleanItem = list.json.find((c: any) => c.eventId === 'cap_clean');
  assert.equal(cleanItem.pixelsWasted, 0);
  const cleanDay = await s.api('GET', `/api/dashboard/daily?hallId=${HALL}&start=${DATE}&end=${DATE}`);
  assert.equal(cleanDay.json.days[0].pixelsWasted, 0);
});
