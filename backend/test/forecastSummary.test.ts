/** GET /api/forecast/summary: forecast worker output summarized with analytics/ formulas. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import type { ForecastSource } from '../src/services/forecastService.js';

const outcome = (over: Record<string, unknown> = {}) => ({
  dishId: 'sim-rice', serviceDate: '2026-10-20', mealLabel: 'lunch', demandLb: 90, recommendedPrepLb: 110, fssForecastLb: 130, consumedLb: 100,
  ranOut: false, panLeftoverLb: 30, leftoverCostUsd: 150, trayWasteLb: 5, trayWasteCostUsd: 25, trayWasteSource: 'simulated' as const, isSimulated: true, ...over,
});

function source(over: Partial<ForecastSource> = {}): ForecastSource & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    async outcomes(...a) { calls.push(['outcomes', ...a]); return [outcome(), outcome({ ranOut: true, recommendedPrepLb: 100, consumedLb: 100, fssForecastLb: 100 })]; },
    async dishes() { return [{ dishId: 'sim-rice', displayName: 'Sticky Rice', serviceStyle: 'side', isSimulated: true }]; },
    async comparisonSimulated() { return true; },
    async upcoming(...a) { calls.push(['upcoming', ...a]); return [{ serviceDate: '2026-10-25', mealLabel: 'lunch', dishId: 'sim-rice', recommendedPrepLb: 55, lowLb: 40, highLb: 62, fssForecastLb: 70, expectedDiners: 700, why: 'Sticky Rice: …', simulated: true }]; },
    ...over,
  };
}

test('summary: totals and per-dish rows from analytics, simulated flag, next 7 days of forecasts', async (t) => {
  const src = source();
  const s = await startTestServer(undefined, { forecastSource: src });
  t.after(() => s.close());
  const res = await s.api('GET', '/api/forecast/summary?hallId=hall-main&start=2026-10-01&end=2026-10-23&today=2026-10-25');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.available, true);
  assert.equal(res.json.simulated, true, 'the dashboard must show the SIMULATED banner');
  assert.equal(res.json.comparisonLabel, 'Simulated FSS (assumed +25% over-prep)', 'never plain "FSS" for the simulator');
  assert.equal(res.json.totals.meals, 2);
  assert.equal(res.json.totals.ourWape, 0.1, '|90 - 100| / 100 on the meal that did not run out');
  assert.equal(res.json.totals.fssStockouts, 1, 'prepped exactly the FSS amount and ran out');
  assert.equal(res.json.totals.panLeftoverLb, 60);
  assert.deepEqual(res.json.totals.trayWasteSources, ['simulated']);
  assert.equal(res.json.dishes[0].displayName, 'Sticky Rice');
  assert.equal(res.json.upcoming[0].displayName, 'Sticky Rice');
  assert.deepEqual(src.calls.find((c) => c[0] === 'upcoming'), ['upcoming', 'hall-main', '2026-10-25', '2026-10-31']);
});

test('summary: unavailable without Supabase; bad parameters are 400', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const res = await s.api('GET', '/api/forecast/summary?hallId=hall-main&start=2026-10-01&end=2026-10-23');
  assert.equal(res.status, 200);
  assert.equal(res.json.available, false);
  const s2 = await startTestServer(undefined, { forecastSource: source() });
  t.after(() => s2.close());
  assert.equal((await s2.api('GET', '/api/forecast/summary?start=2026-10-01&end=2026-10-23')).status, 400);
  assert.equal((await s2.api('GET', '/api/forecast/summary?hallId=h&start=2026-10-23&end=2026-10-01')).status, 400);
});

test('a real FSS export is labeled plainly', async (t) => {
  const s = await startTestServer(undefined, { forecastSource: source({ comparisonSimulated: async () => false }) });
  t.after(() => s.close());
  const res = await s.api('GET', '/api/forecast/summary?hallId=hall-main&start=2026-10-01&end=2026-10-23&today=2026-10-25');
  assert.equal(res.json.comparisonLabel, 'FSS');
});
