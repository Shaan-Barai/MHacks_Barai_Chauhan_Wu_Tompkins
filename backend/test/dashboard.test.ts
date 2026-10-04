import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, MENU, SERVICE, HALL, GEOMETRY } from './helpers.js';
import type { FoodMeasurement } from '../src/types.js';

async function seedPlates(s: Awaited<ReturnType<typeof startTestServer>>) {
  await s.seedMenuAndBaselines();
  const plates: [string, [string | null, number, number | undefined][]][] = [
    ['plate-half', [['item_eggs', 50, 100], [null, 10, undefined]]],
    ['plate-clean', []],
    ['plate-over', [['item_toast', 300, 100]]],
  ];
  for (const [eventId, foods] of plates) {
    await s.repo.upsertCaptureEvent({ eventId, hallId: HALL, serviceId: SERVICE, capturedAt: `2026-10-03T16:00:0${plates.findIndex(p => p[0] === eventId)}Z`, imageObjectId: `img-${eventId}`, geometry: GEOMETRY, source: 'replay', qualityFlags: [], state: 'succeeded' });
    const measurements: FoodMeasurement[] = foods.map(([itemId, remaining, baseline], i) => ({
      measurementId: `${eventId}-${i}`, eventId, attemptId: `att-${eventId}`, itemId, remainingAreaPx: remaining,
      method: 'gemini_area_estimate', qualityFlags: ['ai_estimate'], ...(baseline === undefined ? {} : { baselineAreaPx: baseline }),
    }));
    await s.repo.recordAnalysis({ eventId, attemptId: `att-${eventId}`, menuId: MENU.service.menuId, menuVersion: 1, baselineVersions: {}, model: 'fixture', promptVersion: 'fixture', status: 'succeeded', qualityFlags: [], createdAt: '2026-10-03T16:01:00Z' }, measurements);
  }
}

test('cards average plate waste percent, with clean plates as 0% and above-full capped at 100%', async t => {
  const s = await startTestServer(); t.after(() => s.close()); await seedPlates(s);
  const cards = await s.api('GET', `/api/dashboard/cards?hallId=${HALL}&today=2026-10-03`);
  assert.equal(cards.status, 200);
  // (50% + 0% + 100%) / 3 plates
  assert.equal(cards.json.today.averagePlateWastePercent, 50);
  assert.equal(cards.json.today.platesCounted, 3);
  assert.equal(cards.json.today.platesWithoutPercent, 0);
});

test('plates endpoint lists every scanned plate with readable labels', async t => {
  const s = await startTestServer(); t.after(() => s.close()); await seedPlates(s);
  const res = await s.api('GET', `/api/dashboard/plates?hallId=${HALL}&date=2026-10-03&meal=lunch`);
  assert.equal(res.status, 200);
  assert.equal(res.json.serviceId, SERVICE);
  assert.deepEqual(res.json.plates.map((p: { eventId: string }) => p.eventId), ['plate-half', 'plate-clean', 'plate-over']);
  const half = res.json.plates[0];
  assert.equal(half.imageObjectId, 'img-plate-half');
  assert.equal(half.foods[0].name, MENU.items.find(i => i.itemId === 'item_eggs')!.displayName);
  assert.equal(half.foods[0].percentOfServing, 50);
  assert.equal(half.foods[1].name, 'Unknown food');
  assert.equal(res.json.plates[2].foods[0].percentOfServing, 100);
  const none = await s.api('GET', `/api/dashboard/plates?hallId=${HALL}&date=2026-10-04&meal=lunch`);
  assert.deepEqual(none.json, { serviceId: null, plates: [] });
});

test('meal suggestion names the top food in plain words while per-portion rates are unavailable', async t => {
  const s = await startTestServer(); t.after(() => s.close()); await seedPlates(s);
  const res = await s.api('GET', `/api/dashboard/meal?hallId=${HALL}&date=2026-10-03&meal=lunch`);
  assert.equal(res.status, 200);
  assert.match(res.json.insight.recommendation, new RegExp(`^${MENU.items.find(i => i.itemId === 'item_toast')!.displayName} made up`));
  assert.doesNotMatch(res.json.insight.recommendation, /pixel|baseline|—/i);
});
