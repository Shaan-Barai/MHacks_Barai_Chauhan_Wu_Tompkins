/**
 * Admin curation (2026-10-04): an admin chooses which plates the dashboard
 * shows. Hidden plates drop out of every dashboard read but are never
 * deleted, and only an admin can list or change them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, MENU, SERVICE, HALL, GEOMETRY } from './helpers.js';
import type { FoodMeasurement } from '../src/types.js';
import type { SecurityConfig } from '../src/config.js';

const WINDOW = `start=2026-10-03&end=2026-10-03&hallId=${HALL}`;
const PASSCODE = 'correct horse battery staple';

async function seedMaskPlates(s: Awaited<ReturnType<typeof startTestServer>>) {
  await s.seedMenuAndBaselines();
  const plates: [string, number][] = [['plate-a', 800], ['plate-b', 450]];
  for (const [n, [eventId, px]] of plates.entries()) {
    await s.repo.upsertCaptureEvent({ eventId, hallId: HALL, serviceId: SERVICE, capturedAt: `2026-10-03T16:00:0${n}Z`, imageObjectId: `img-${eventId}`, geometry: GEOMETRY, source: 'camera', qualityFlags: [], state: 'succeeded' });
    const measurements: FoodMeasurement[] = [{
      measurementId: `${eventId}-0`, eventId, attemptId: `att-${eventId}`, itemId: 'item_toast', remainingAreaPx: px, method: 'mask_pixel_count', qualityFlags: [],
    }];
    await s.repo.recordAnalysis({ eventId, attemptId: `att-${eventId}`, menuId: MENU.service.menuId, menuVersion: 1, baselineVersions: {}, model: 'fixture', promptVersion: 'fixture', status: 'succeeded', qualityFlags: [], createdAt: '2026-10-03T16:01:00Z',
      segmentation: { model: 'fixture', checkpoint: 'fixture', codeRevision: 'fixture', promptSource: 'gemini_box', settingsVersion: 'fixture', countingRuleVersion: 'union-v1', status: 'succeeded', countStatus: 'complete', capturePixelsWasted: px, widthPx: GEOMETRY.widthPx, heightPx: GEOMETRY.heightPx, regions: [] } }, measurements);
  }
}

test('hidden plates leave every dashboard read but stay listed for the admin', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await seedMaskPlates(s);

  const before = await s.api('GET', `/api/dashboard/impact?${WINDOW}`);
  assert.equal(before.json.totals.captures, 2);
  const pixels = async () => (await s.api('GET', `/api/captures?${WINDOW}`)).json.reduce((n: number, c: { pixelsWasted: number }) => n + c.pixelsWasted, 0);
  assert.equal(await pixels(), 1250);

  const hide = await s.api('PUT', '/api/admin/captures/visibility', { eventIds: ['plate-a'], hidden: true });
  assert.equal(hide.status, 200);

  const impact = await s.api('GET', `/api/dashboard/impact?${WINDOW}`);
  assert.equal(impact.json.totals.captures, 1);
  const gallery = await s.api('GET', `/api/captures?${WINDOW}`);
  assert.deepEqual(gallery.json.map((c: { eventId: string }) => c.eventId), ['plate-b']);
  assert.equal(await pixels(), 450);
  const meal = await s.api('GET', `/api/dashboard/plates?hallId=${HALL}&date=2026-10-03&meal=lunch`);
  assert.deepEqual(meal.json.plates.map((p: { eventId: string }) => p.eventId), ['plate-b']);

  // Still stored, and the admin list shows both with their flag.
  assert.ok(await s.repo.getCaptureEvent('plate-a'));
  const admin = await s.api('GET', `/api/admin/captures?${WINDOW}`);
  assert.equal(admin.status, 200);
  const flags = Object.fromEntries(admin.json.captures.map((c: { eventId: string; hidden: boolean }) => [c.eventId, c.hidden]));
  assert.deepEqual(flags, { 'plate-a': true, 'plate-b': false });

  // Show it again.
  await s.api('PUT', '/api/admin/captures/visibility', { eventIds: ['plate-a'], hidden: false });
  assert.equal(await pixels(), 1250);
  assert.equal((await s.api('GET', `/api/dashboard/impact?${WINDOW}`)).json.totals.captures, 2);
});

test('visibility changes validate their input', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await seedMaskPlates(s);
  assert.equal((await s.api('PUT', '/api/admin/captures/visibility', { eventIds: [], hidden: true })).status, 400);
  assert.equal((await s.api('PUT', '/api/admin/captures/visibility', { eventIds: ['plate-a'], hidden: 'yes' })).status, 400);
  const unknown = await s.api('PUT', '/api/admin/captures/visibility', { eventIds: ['plate-a', 'nope'], hidden: true });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'CAPTURE_NOT_FOUND');
  // Nothing was hidden by the rejected request.
  assert.equal((await s.repo.listHiddenCaptureIds()).size, 0);
});

test('only an admin session can list or change plate visibility (not the ingest token, not the public)', async (t) => {
  const security: SecurityConfig = {
    production: false, ingestToken: 'ingest-token-for-tests-0123456789', adminPasscode: PASSCODE,
    sessionSecret: 'session-secret-for-tests-0123456789', sessionTtlMs: 3600_000, cookieSecure: false,
    trustProxy: false, loginRateLimit: 5, geminiRateLimit: 5, jsonBodyLimit: '1mb',
  };
  const s = await startTestServer(undefined, { config: { security }, headers: { authorization: `Bearer ${security.ingestToken}` } });
  t.after(() => s.close());
  await seedMaskPlates(s);

  const anon = await fetch(`${s.baseUrl}/api/admin/captures?${WINDOW}`);
  assert.equal(anon.status, 401);
  assert.equal((await s.api('GET', `/api/admin/captures?${WINDOW}`)).status, 401); // ingest token
  assert.equal((await s.api('PUT', '/api/admin/captures/visibility', { eventIds: ['plate-a'], hidden: true })).status, 401);

  const login = await fetch(`${s.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: PASSCODE }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const list = await fetch(`${s.baseUrl}/api/admin/captures?${WINDOW}`, { headers: { cookie } });
  assert.equal(list.status, 200);
  const put = await fetch(`${s.baseUrl}/api/admin/captures/visibility`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ eventIds: ['plate-a'], hidden: true }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual([...(await s.repo.listHiddenCaptureIds())], ['plate-a']);
});
