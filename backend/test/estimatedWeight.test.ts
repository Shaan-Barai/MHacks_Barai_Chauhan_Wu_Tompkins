/**
 * Run 3 plate-scale-v1: GET /api/dashboard/estimated-weight returns ESTIMATED pounds
 * beside the unchanged Pixels wasted, with its assumptions; the impact totals do not move.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, MENU, SERVICE, HALL, GEOMETRY } from './helpers.js';
import type { FoodMeasurement } from '../src/types.js';

const WINDOW = `start=2026-10-03&end=2026-10-03&hallId=${HALL}`;

async function seed(s: Awaited<ReturnType<typeof startTestServer>>) {
  await s.seedMenuAndBaselines();
  // plate-a: 100,000 px of Scrambled Eggs (1 g/cm²) on a plate 890 px wide; plate-b: 50,000 px, no plate scale.
  for (const [n, [eventId, px]] of ([['plate-a', 100_000], ['plate-b', 50_000]] as const).entries()) {
    await s.repo.upsertCaptureEvent({ eventId, hallId: HALL, serviceId: SERVICE, capturedAt: `2026-10-03T16:00:0${n}Z`, imageObjectId: `img-${eventId}`, geometry: GEOMETRY, source: 'camera', qualityFlags: [], state: 'succeeded' });
    const measurements: FoodMeasurement[] = [{
      measurementId: `${eventId}-0`, eventId, attemptId: `att-${eventId}`, itemId: 'item_eggs', remainingAreaPx: px, method: 'mask_pixel_count', qualityFlags: [],
      maskCount: { validated: true, assignment: 'exclusive', pixelsWasted: px, geometry: GEOMETRY, menuId: MENU.service.menuId, menuVersion: 1, maskObjectId: `mask-${eventId}`, classificationVersion: 'fixture', segmentationVersion: 'fixture', processingVersion: 'fixture' },
    }];
    await s.repo.recordAnalysis({ eventId, attemptId: `att-${eventId}`, menuId: MENU.service.menuId, menuVersion: 1, baselineVersions: {}, model: 'fixture', promptVersion: 'fixture', status: 'succeeded', qualityFlags: [], createdAt: '2026-10-03T16:01:00Z',
      segmentation: { model: 'fixture', checkpoint: 'fixture', codeRevision: 'fixture', promptSource: 'gemini_box', settingsVersion: 'fixture', countingRuleVersion: 'union-v1', status: 'succeeded', countStatus: 'complete', capturePixelsWasted: px, widthPx: GEOMETRY.widthPx, heightPx: GEOMETRY.heightPx, regions: [] } }, measurements);
  }
  await s.repo.recordPlateScale!({ attemptId: 'att-plate-a', eventId: 'plate-a', method: 'plate-scale-v1', dishType: 'plate', fullyVisible: true, plateDiameterPx: 890,
    boxWidthPx: 880, boxHeightPx: 900, assumedPlateDiameterCm: 26.7, unavailableReason: null, createdAt: '2026-10-03T16:01:00Z' });
  await s.repo.recordPlateScale!({ attemptId: 'att-plate-b', eventId: 'plate-b', method: 'plate-scale-v1', dishType: null, fullyVisible: null, plateDiameterPx: null,
    boxWidthPx: null, boxHeightPx: null, assumedPlateDiameterCm: 26.7, unavailableReason: 'not_fully_visible', createdAt: '2026-10-03T16:01:00Z' });
}

test('estimated pounds sit beside unchanged pixels, labeled with their assumptions', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await seed(s);
  const before = (await s.api('GET', `/api/dashboard/impact?${WINDOW}`)).json.totals.pixels;
  const res = await s.api('GET', `/api/dashboard/estimated-weight?${WINDOW}`);
  assert.equal(res.status, 200);
  const w = res.json;
  assert.equal(w.isEstimate, true);
  assert.equal(w.method, 'plate-scale-v1');
  assert.match(w.note, /Estimate/);
  const eggs = w.items.find((i: { itemId: string }) => i.itemId === 'item_eggs');
  // 100,000 px × (26.7/890)² = 90 cm² × 1 g/cm² = 90 g = 0.198416 lb; plate-b adds pixels, not pounds
  assert.equal(eggs.pixels, 150_000);
  assert.equal(eggs.pixelsWithScale, 100_000);
  assert.ok(Math.abs(eggs.estimatedGrams - 90) < 1e-9);
  assert.equal(eggs.estimatedLb.toFixed(6), (90 / 453.59237).toFixed(6));
  assert.deepEqual([w.totals.captures, w.totals.capturesWithScale], [2, 1]);
  assert.deepEqual(w.assumedPlateDiametersCm, [26.7]); // stated in the Statistics tooltip
  // Pixels wasted is unchanged by the estimate.
  assert.equal(w.totals.pixels, before);
  assert.equal((await s.api('GET', `/api/dashboard/impact?${WINDOW}`)).json.totals.pixels, before);
});

test('no plate scales: pixels still counted, pounds null (never 0)', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  const res = await s.api('GET', `/api/dashboard/estimated-weight?${WINDOW}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.totals.estimatedLb, null);
  assert.deepEqual(res.json.assumedPlateDiametersCm, []);
});

test('ingestion records the plate measurement with the assumed diameter; a failed scan records none', async (t) => {
  const { MockAnalyzer } = await import('../src/analysis/mockAnalyzer.js');
  const fixtures: Record<string, import('../src/analysis/mockAnalyzer.js').MockFixture> = {};
  const mock = new MockAnalyzer(fixtures);
  const plates: Record<string, { ok: true; version: string; diameterPx: number; boxWidthPx: number; boxHeightPx: number } | { ok: false; version: string; reason: string }> = {
    cap_plate_ok: { ok: true, version: 'plate-scale-v1', diameterPx: 890, boxWidthPx: 880, boxHeightPx: 900 },
    cap_plate_bowl: { ok: false, version: 'plate-scale-v1', reason: 'not_a_plate' },
  };
  const s = await startTestServer(
    { async analyze(input) { const r = await mock.analyze(input); const p = plates[input.event.eventId]; return p ? { ...r, plate: p } : r; } },
    { config: { plateDiameterCm: 22.9 } },
  );
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  for (const id of Object.keys(plates)) {
    fixtures[id] = { measurements: [{ itemId: 'item_eggs', remainingAreaPx: 100 }] };
    assert.equal((await s.submitCapture(id, await s.uploadImage(id))).status, 201);
  }
  const rows = await s.repo.listPlateScales!(Object.keys(plates));
  const ok = rows.find((r) => r.eventId === 'cap_plate_ok')!;
  assert.deepEqual([ok.method, ok.plateDiameterPx, ok.assumedPlateDiameterCm, ok.unavailableReason], ['plate-scale-v1', 890, 22.9, null]);
  const bowl = rows.find((r) => r.eventId === 'cap_plate_bowl')!;
  assert.deepEqual([bowl.plateDiameterPx, bowl.unavailableReason], [null, 'not_a_plate']);
  // Pixels are what the analyzer counted, untouched.
  assert.equal((await s.repo.listMeasurementsByEvent('cap_plate_ok'))[0]?.remainingAreaPx, 100);
});
