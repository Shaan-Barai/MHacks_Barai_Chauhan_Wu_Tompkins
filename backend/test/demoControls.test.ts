/**
 * Dashboard demo-data controls: Load dummy data / Clear data / Restore default.
 * Nothing real is ever deleted; "Clear data" is a per-hall capture cutoff.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, MENU, SERVICE, HALL, GEOMETRY } from './helpers.js';
import type { FoodMeasurement } from '../src/types.js';
import type { SecurityConfig } from '../src/config.js';

const WINDOW = `start=2026-09-20&end=2026-10-04&hallId=${HALL}`;

type Server = Awaited<ReturnType<typeof startTestServer>>;

async function addPlate(s: Server, eventId: string, capturedAt: string, px: number) {
  await s.repo.upsertCaptureEvent({ eventId, hallId: HALL, serviceId: SERVICE, capturedAt, imageObjectId: `img-${eventId}`, geometry: GEOMETRY, source: 'camera', qualityFlags: [], state: 'succeeded' });
  const measurements: FoodMeasurement[] = [{
    measurementId: `${eventId}-0`, eventId, attemptId: `att-${eventId}`, itemId: 'item_toast', remainingAreaPx: px, method: 'mask_pixel_count', qualityFlags: [],
    maskCount: { validated: true, assignment: 'exclusive', pixelsWasted: px, geometry: GEOMETRY, menuId: MENU.service.menuId, menuVersion: 1, maskObjectId: `mask-${eventId}`, classificationVersion: 'fixture', segmentationVersion: 'fixture', processingVersion: 'fixture' },
  }];
  await s.repo.recordAnalysis({ eventId, attemptId: `att-${eventId}`, menuId: MENU.service.menuId, menuVersion: 1, baselineVersions: {}, model: 'fixture', promptVersion: 'fixture', status: 'succeeded', qualityFlags: [], createdAt: capturedAt,
    segmentation: { model: 'fixture', checkpoint: 'fixture', codeRevision: 'fixture', promptSource: 'gemini_box', settingsVersion: 'fixture', countingRuleVersion: 'union-v1', status: 'succeeded', countStatus: 'complete', capturePixelsWasted: px, widthPx: GEOMETRY.widthPx, heightPx: GEOMETRY.heightPx, regions: [] } }, measurements);
}

async function snapshot(s: Server) {
  const totals = await s.api('GET', `/api/dashboard/totals?hallId=${HALL}&today=2026-10-04`);
  const gallery = await s.api('GET', `/api/captures?${WINDOW}`);
  const impact = await s.api('GET', `/api/dashboard/impact?${WINDOW}`);
  return {
    totals: totals.json,
    ids: gallery.json.map((c: { eventId: string }) => c.eventId).sort(),
    pixels: impact.json.totals.pixels as number,
  };
}

test('load / clear-data / restore leave real captures stored and restore the default exactly', async (t) => {
  let clock = Date.parse('2026-10-04T15:00:00Z');
  const s = await startTestServer(undefined, { now: () => clock });
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  await addPlate(s, 'plate-a', '2026-10-03T16:00:00Z', 800);
  await addPlate(s, 'plate-b', '2026-10-03T16:00:01Z', 450);
  await s.repo.setCaptureVisibility(['plate-b'], true, '2026-10-03T17:00:00Z'); // admin-hidden stays hidden

  const baseline = await snapshot(s);
  assert.deepEqual(baseline.ids, ['plate-a']);
  assert.equal(baseline.pixels, 800);
  const status0 = await s.api('GET', `/api/demo/status?hallId=${HALL}`);
  assert.deepEqual(status0.json, { hallId: HALL, mode: 'default', sampleLoaded: false, sampleCaptures: 0, clearedAt: null });

  // Load dummy data (no DEMO_SEED gate), twice (idempotent).
  const load = await s.api('POST', '/api/demo/load', {});
  assert.equal(load.status, 200);
  assert.equal(load.json.mode, 'sample');
  assert.equal(load.json.sampleLoaded, true);
  const n = load.json.sampleCaptures as number;
  assert.ok(n > 40);
  const sampled = await snapshot(s);
  assert.ok(sampled.pixels > baseline.pixels);
  assert.ok(sampled.pixels > 0);
  assert.ok(sampled.ids.length > 1); // gallery is capped at its page size
  assert.equal((await s.api('POST', '/api/demo/load', { hallId: HALL })).json.sampleCaptures, n);
  assert.deepEqual((await snapshot(s)).ids, sampled.ids);

  // Clear data: sample rows gone, earlier real captures ignored by the public dashboard.
  clock = Date.parse('2026-10-04T16:00:00Z');
  const cleared = await s.api('POST', '/api/demo/clear-data', {});
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.mode, 'cleared');
  assert.equal(cleared.json.clearedAt, '2026-10-04T16:00:00.000Z');
  assert.equal(cleared.json.sampleCaptures, 0);
  const empty = await snapshot(s);
  assert.deepEqual(empty.ids, []);
  assert.equal(empty.pixels, 0);
  assert.equal(empty.totals.month.captures, 0);
  assert.equal((await s.api('GET', `/api/dashboard/plates?hallId=${HALL}&date=2026-10-03&meal=lunch`)).json.plates.length, 0);

  // Nothing real is deleted: the admin list still shows the old plates.
  const admin = await s.repo.listCaptureEvents({ hallId: HALL, includeHidden: true });
  assert.deepEqual(admin.map((e) => e.eventId).sort(), ['plate-a', 'plate-b']);

  // A scan after the cutoff counts normally.
  await addPlate(s, 'plate-c', '2026-10-04T16:30:00Z', 300);
  const fresh = await snapshot(s);
  assert.deepEqual(fresh.ids, ['plate-c']);
  assert.equal(fresh.pixels, 300);

  // Restore default: the original dashboard again (plate-c is a later real scan, hidden for the comparison).
  const restored = await s.api('POST', '/api/demo/restore', { hallId: HALL });
  assert.deepEqual(restored.json, { hallId: HALL, mode: 'default', sampleLoaded: false, sampleCaptures: 0, clearedAt: null });
  assert.deepEqual((await snapshot(s)).ids, ['plate-a', 'plate-c']);
  await s.repo.setCaptureVisibility(['plate-c'], true, '2026-10-04T17:00:00Z');
  assert.deepEqual(await snapshot(s), baseline);
});

test('a recommendation saved before Clear data is not offered as current', async (t) => {
  let clock = Date.parse('2026-10-04T15:00:00Z');
  const s = await startTestServer(undefined, { now: () => clock });
  t.after(() => s.close());
  await s.repo.upsertInsight({
    insightId: 'ins-1', hallId: HALL, windowStart: '2026-09-20', windowEnd: '2026-10-04', metrics: { kind: 'impact-recommendation' },
    dataVersion: 'v-old', recommendation: JSON.stringify({ text: 'Old advice', bullets: [] }), source: 'gemini', generatedAt: '2026-10-04T14:00:00.000Z',
  } as never);
  const { ImpactService } = await import('../src/services/impactService.js');
  const impact = new ImpactService(s.repo, undefined as never, undefined, () => clock);
  assert.equal((await impact.savedRecommendations(HALL)).length, 1);
  clock = Date.parse('2026-10-04T16:00:00Z');
  await s.api('POST', '/api/demo/clear-data', {});
  assert.equal((await impact.savedRecommendations(HALL)).length, 0);
  await s.api('POST', '/api/demo/restore', {});
  assert.equal((await impact.savedRecommendations(HALL)).length, 1);
});

test('anonymous callers cannot change demo data but can read its status', async (t) => {
  const security: SecurityConfig = {
    production: false, ingestToken: 'ingest-token-for-tests-0123456789', adminPasscode: 'correct horse battery staple',
    sessionSecret: 'session-secret-for-tests-0123456789', sessionTtlMs: 3600_000, cookieSecure: false,
    trustProxy: false, loginRateLimit: 5, geminiRateLimit: 5, jsonBodyLimit: '1mb',
  };
  const s = await startTestServer(undefined, { config: { security }, headers: { authorization: `Bearer ${security.ingestToken}` } });
  t.after(() => s.close());
  for (const path of ['load', 'clear-data', 'restore']) {
    const anon = await fetch(`${s.baseUrl}/api/demo/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anon.status, 401, path);
    assert.equal((await s.api('POST', `/api/demo/${path}`, {})).status, 200, `${path} with ingest token`);
  }
  const status = await fetch(`${s.baseUrl}/api/demo/status`);
  assert.equal(status.status, 200);
  assert.equal(((await status.json()) as { hallId: string }).hallId, HALL);
});
