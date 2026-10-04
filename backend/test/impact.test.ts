/**
 * Waste-impact endpoints (BIG-PLAN D2–D8) over hand-calculated fixtures:
 * GET /api/dashboard/impact, GET /api/captures, GET /api/recommendation.
 * Offline: mock analyzer, local-dev storage, in-memory repo, no live Gemini.
 *
 * Factor rows (menu_waste_factors.csv via scrap-data):
 *   Baked Boneless Ham            0.9 g/cm²
 *   Oven Roasted Garlic Potatoes  1.6 g/cm²
 *   Mystery Stew                  no factor row
 *
 * cap_a (plate fit, 267 px plate -> 0.01 cm²/px):
 *   ham 10,000 px -> 100 cm² -> 90 g; potatoes 5,000 px -> 50 cm² -> 80 g
 * cap_b (configured default, 534 px -> 0.0025 cm²/px):
 *   ham 4,000 px -> 10 cm² -> 9 g; unknown food 1,000 px (no factor)
 * cap_c: analysis failed (excluded, never zero)
 * Portions (manual): ham 30, potatoes 100.
 *   ham 99 g / 30 = 3.3 g/portion; potatoes 80 g / 100 = 0.8 g/portion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { WASTE_FACTORS, findWasteFactor } from 'scrap-data';
import { startTestServer, type TestServer } from './helpers.js';
import type { GeminiGateway } from '@scrap/vision';
import { recommendationFacts, recommendationInputVersion } from '@scrap/analytics';
import type { MenuBundle, PlateCalibration } from '../src/types.js';

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

const FIT: PlateCalibration = { method: 'plate-fit-v1', plateDiameterCm: 26.7, plateDiameterPx: 267, cm2PerPx: (26.7 / 267) ** 2, flags: [] };
const DEFAULT_CAL: PlateCalibration = {
  method: 'configured-default',
  plateDiameterCm: 26.7,
  plateDiameterPx: 534,
  cm2PerPx: (26.7 / 534) ** 2,
  flags: ['calibration_default'],
};
const GEOMETRY = { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' as const };
const close = (actual: number | null | undefined, expected: number, msg?: string) =>
  assert.ok(actual !== null && actual !== undefined && Math.abs(actual - expected) < 1e-6, `${msg ?? ''} expected ${expected}, got ${actual}`);

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
    calibration: FIT,
  };
  s.fixtures.cap_b = {
    measurements: [
      { itemId: HAM, remainingAreaPx: 4000 },
      { itemId: null, remainingAreaPx: 1000 },
    ],
    calibration: DEFAULT_CAL,
  };
  s.fixtures.cap_c = { status: 'failed', errorCode: 'GEMINI_TIMEOUT' };
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

test('fixture factor rows exist as the hand calculation assumes', () => {
  assert.equal(findWasteFactor('Baked Boneless Ham')?.weightGPerCm2, 0.9);
  assert.equal(findWasteFactor('Oven Roasted Garlic Potatoes')?.weightGPerCm2, 1.6);
  assert.equal(findWasteFactor('Mystery Stew'), null);
  assert.ok(WASTE_FACTORS.length >= 23);
});

test('GET /api/dashboard/impact: totals, per-portion targets, most wasted, coverage', async (t) => {
  const s = await seeded();
  t.after(() => s.close());
  const res = await s.api('GET', `/api/dashboard/impact?start=${DATE}&end=${DATE}&hallId=${HALL}`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const d = res.json;
  assert.deepEqual(d.window, { start: DATE, end: DATE, hallId: HALL });
  assert.equal(d.totals.pixels, 20000);
  assert.equal(d.totals.captures, 3);
  assert.equal(d.totals.analyzedCaptures, 2);
  assert.equal(d.totals.excludedCaptures, 1);
  assert.equal(typeof d.totals.wasteFactorsVersion, 'string');
  assert.equal(d.labels.estimate, true);
  assert.equal(d.labels.demoPortions, false, 'manual counts are not demo');
  assert.equal(d.coverage.capturesWithDefaultCalibration, 1);

  const ham = d.mostWasted.find((r: any) => r.itemId === HAM);
  const potatoes = d.mostWasted.find((r: any) => r.itemId === POTATOES);
  assert.equal(ham.impact.pixels, 14000);
  close(ham.impact.grams, 99, 'ham grams');
  close(potatoes.impact.grams, 80, 'potato grams');
  assert.equal(ham.factorKey, 'baked-boneless-ham');
  assert.equal(ham.portionsServed, 30);
  assert.equal(ham.portionsSource, 'manual');
  close(ham.perPortion.grams, 3.3, 'ham g/portion');
  close(potatoes.perPortion.grams, 0.8, 'potato g/portion');
  assert.ok(ham.impact.impactUsd > 0 && ham.impact.kgCo2e > 0 && ham.impact.waterM3 > 0);
  assert.deepEqual(d.mostWasted.slice(0, 2).map((r: any) => r.itemId), [HAM, POTATOES], 'most wasted by grams');
  assert.deepEqual(d.targets.slice(0, 2).map((r: any) => r.itemId), [HAM, POTATOES], 'targets by grams per portion');

  // Unknown food keeps its pixels, never invented grams or a per-portion rate.
  const unknown = [...d.mostWasted, ...d.targets].find((r: any) => r.itemId === null);
  if (unknown) {
    assert.equal(unknown.impact.pixels, 1000);
    assert.equal(unknown.impact.grams, null);
    assert.equal(unknown.perPortion, null);
  }

  // An empty window is a valid, empty dashboard; a bad window is a 400 envelope.
  const empty = await s.api('GET', '/api/dashboard/impact?start=2026-09-01&end=2026-09-02');
  assert.equal(empty.status, 200);
  assert.equal(empty.json.totals.pixels, 0);
  assert.equal(empty.json.totals.captures, 0);
  for (const q of ['', '?start=2026-10-02', '?start=10/02/2026&end=2026-10-02', `?start=${DATE}&end=2026-10-01`]) {
    const bad = await s.api('GET', `/api/dashboard/impact${q}`);
    assert.equal(bad.status, 400, q);
    assert.equal(bad.json.error.code, 'INVALID_WINDOW');
    assert.equal(bad.json.error.retryable, false);
  }
});

test('GET /api/captures: newest first, item grams, failed captures null (never zero), capped', async (t) => {
  const s = await seeded();
  t.after(() => s.close());
  const res = await s.api('GET', `/api/captures?start=${DATE}&end=${DATE}`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const list = res.json;
  assert.deepEqual(list.map((c: any) => c.eventId), ['cap_c', 'cap_b', 'cap_a']);
  const [c, b, a] = list;
  assert.equal(c.state, 'failed');
  assert.equal(c.pixelsWasted, null);
  assert.equal(c.grams, null);
  assert.deepEqual(c.items, []);
  assert.equal(a.state, 'succeeded');
  assert.equal(a.pixelsWasted, 15000);
  close(a.grams, 170, 'cap_a grams');
  assert.equal(a.hasOverlay, false);
  assert.equal(a.serviceId, SERVICE);
  assert.equal(a.source, 'replay');
  const ham = a.items.find((i: any) => i.itemId === HAM);
  assert.equal(ham.displayName, 'Baked Boneless Ham');
  assert.equal(ham.pixels, 10000);
  close(ham.grams, 90);
  assert.equal(b.pixelsWasted, 5000);
  const unknown = b.items.find((i: any) => i.itemId === null);
  assert.equal(unknown.pixels, 1000);
  assert.equal(unknown.grams, null);

  const capped = await s.api('GET', `/api/captures?start=${DATE}&end=${DATE}&limit=1`);
  assert.deepEqual(capped.json.map((x: any) => x.eventId), ['cap_c']);
  const bad = await s.api('GET', `/api/captures?start=${DATE}&end=${DATE}&limit=0`);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'INVALID_PARAMETER');
});

test('GET /api/recommendation: labeled fallback without Gemini, grounded in shown numbers', async (t) => {
  const s = await seeded();
  t.after(() => s.close());
  const res = await s.api('GET', `/api/recommendation?start=${DATE}&end=${DATE}`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const r = res.json;
  assert.equal(r.source, 'fallback');
  assert.equal(typeof r.text, 'string');
  assert.ok(r.text.length > 0);
  assert.ok(Array.isArray(r.bullets));
  for (const b of r.bullets) assert.equal(typeof b.metric, 'string');
  assert.equal(typeof r.inputVersion, 'string');
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
  s.fixtures.cap_d = { measurements: [{ itemId: POTATOES, remainingAreaPx: 2000 }], calibration: FIT };
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
          text: 'Ham leaves the most waste per portion; try a smaller ham portion for a week.',
          bullets: [
            { text: 'Ham waste per portion.', metric: metrics[0] },
            { text: 'Plates analyzed.', metric: metrics[1] },
          ],
        }),
      calls,
    ),
  });
  t.after(() => s.close());
  const dash = await s.api('GET', `/api/dashboard/impact?start=${DATE}&end=${DATE}`);
  metrics = recommendationFacts(dash.json).allowedMetrics;
  assert.ok(metrics.length >= 2);
  const first = await s.api('GET', `/api/recommendation?start=${DATE}&end=${DATE}`);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.source, 'gemini');
  assert.deepEqual(first.json.bullets.map((b: any) => b.metric), metrics.slice(0, 2));
  assert.equal(first.json.inputVersion, recommendationInputVersion(recommendationFacts(dash.json)));
  const second = await s.api('GET', `/api/recommendation?start=${DATE}&end=${DATE}`);
  assert.deepEqual(second.json, first.json);
  assert.equal(calls.n, 1, 'one Gemini call for identical statistics');
});
