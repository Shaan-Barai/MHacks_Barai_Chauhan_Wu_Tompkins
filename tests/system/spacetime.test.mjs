/**
 * Integration: SpacetimeDB reducers and rows on a THROWAWAY local database
 * (scrap-test-<time>), published from db/spacetimedb and deleted afterwards.
 * The real `scrap` database is never touched. Skipped with a message when
 * the spacetime CLI or a local server (spacetime start) is missing.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  DATE,
  HALL,
  SERVICE,
  backend,
  boxFillerSam,
  callReducer,
  deleteThrowaway,
  demoPortions,
  dinnerMenu,
  fakeGemini,
  httpAdapter,
  publishThrowaway,
  spacetimeAvailable,
  spacetimeRepo,
  sql,
  startBackend,
  sumScanRows,
  test2Photos,
} from '../support/stack.mjs';

const DB = `scrap-test-it-${Date.now()}`;
const unavailable = await spacetimeAvailable();

describe(`SpacetimeDB reducers and rows (throwaway database ${DB})`, { skip: unavailable ?? false }, () => {
  let repo;
  before(() => {
    publishThrowaway(DB);
    repo = spacetimeRepo(DB);
  });
  after(() => {
    const err = deleteThrowaway(DB);
    if (err) console.warn(`[spacetime] could not delete ${DB}: ${err}`);
  });

  it('menus: insert, forward-only versions, revision archive', async () => {
    const menu = dinnerMenu();
    await repo.upsertMenu(menu);
    assert.deepEqual((await repo.getMenuByService(SERVICE)).items.map((i) => i.displayName), menu.items.map((i) => i.displayName));
    const v2 = { service: { ...menu.service, menuVersion: 2 }, items: menu.items.slice(0, 3) };
    await repo.upsertMenu(v2);
    await assert.rejects(repo.upsertMenu(menu), /older|STALE|version/i, 'an older version never overwrites a newer one');
    assert.equal((await repo.getMenuByService(SERVICE)).service.menuVersion, 2);
    assert.ok(await repo.getMenuItem(menu.items[3].itemId), 'the dropped item is kept in the revision archive');
    await repo.upsertMenu({ service: { ...menu.service, menuVersion: 3 }, items: menu.items });
  });

  it('capture events: created, then updated in place (one row per eventId)', async () => {
    const event = { eventId: 'cap_st_1', hallId: HALL, serviceId: SERVICE, capturedAt: `${DATE}T22:00:00.000Z`, imageObjectId: 'img_x', geometry: { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' }, source: 'camera', qualityFlags: [], state: 'processing' };
    await repo.upsertCaptureEvent(event);
    await repo.upsertCaptureEvent({ ...event, state: 'failed' });
    assert.equal((await repo.getCaptureEvent('cap_st_1')).state, 'failed');
    assert.equal((await sql(DB, "SELECT * FROM capture_event WHERE event_id = 'cap_st_1'")).length, 1);
  });

  it('scan_info: validated, upserted by eventId', async () => {
    const scan = { eventId: 'cap_st_1', deviceId: 'uno-q-c920', timestampBasis: 'laptop_trigger', originalImageObjectId: 'img_raw', originalSha256: 'a'.repeat(64), demo: false };
    await repo.upsertScanInfo(scan);
    await repo.upsertScanInfo({ ...scan, deviceId: 'uno-q-c920-b' });
    assert.equal((await repo.getScanInfo('cap_st_1')).deviceId, 'uno-q-c920-b');
    const bad = await callReducer(DB, 'upsert_scan_info', { scanJson: JSON.stringify({ ...scan, timestampBasis: 'board_frame_received' }) });
    assert.equal(bad.ok, false, 'the board clock is never accepted as the scan time');
    const badSha = await callReducer(DB, 'upsert_scan_info', { scanJson: JSON.stringify({ ...scan, originalSha256: 'xyz' }) });
    assert.equal(badSha.ok, false);
  });

  it('record_analysis is atomic: an inconsistent count writes nothing', async () => {
    const attempt = (id, capture) => ({
      eventId: 'cap_st_1', attemptId: id, menuId: dinnerMenu().service.menuId, menuVersion: 3, baselineVersions: {}, model: 'm', promptVersion: 'p', status: 'succeeded', qualityFlags: [], createdAt: new Date().toISOString(),
      segmentation: { model: 'sam', checkpoint: 'c', codeRevision: 'r', promptSource: 'gemini_box', settingsVersion: 's', countingRuleVersion: 'target-dish-v1', status: 'succeeded', countStatus: 'complete', capturePixelsWasted: capture, widthPx: 1024, heightPx: 1024, regions: [] },
    });
    const m = (id, attemptId, px) => ({ measurementId: id, eventId: 'cap_st_1', attemptId, itemId: null, remainingAreaPx: px, method: 'mask_pixel_count', qualityFlags: [] });
    await assert.rejects(repo.recordAnalysis(attempt('att_bad', 999), [m('m_bad', 'att_bad', 100)]), /capture union/);
    assert.equal((await sql(DB, "SELECT * FROM analysis_attempt WHERE attempt_id = 'att_bad'")).length, 0);
    assert.equal((await sql(DB, "SELECT * FROM food_measurement WHERE measurement_id = 'm_bad'")).length, 0);
    await repo.recordAnalysis(attempt('att_ok', 300), [m('m_1', 'att_ok', 100), m('m_2', 'att_ok', 200)]);
    assert.equal((await repo.listMeasurementsByAttempt('att_ok')).length, 2);
    assert.equal((await sql(DB, "SELECT * FROM capture_count WHERE attempt_id = 'att_ok'")).length, 1);
  });

  it('portions served: replacement snapshot for the current menu version only', async () => {
    const menu = { ...dinnerMenu(), service: { ...dinnerMenu().service, menuVersion: 3 } };
    const rows = demoPortions(menu).map((p) => ({ ...p, menuVersion: 3, recordId: JSON.stringify([SERVICE, 3, p.itemId]) }));
    await repo.replacePortionsServed(SERVICE, 3, rows);
    await repo.replacePortionsServed(SERVICE, 3, rows.slice(0, 2));
    assert.equal((await repo.listPortionsServed(SERVICE, 3)).length, 2, 'a snapshot replaces, never adds');
    await assert.rejects(repo.replacePortionsServed(SERVICE, 1, rows), /menu changed|STALE/i);
  });

  it('sample data: clear_demo_data removes exactly the marked rows', async () => {
    const realEvents = (await repo.listCaptureEvents({ hallId: HALL })).length;
    const result = await new backend.demo.DemoService(repo).seedHistory({ hallId: HALL, endDate: DATE, days: 2 });
    assert.ok(result.captures > 0);
    assert.ok((await sql(DB, 'SELECT * FROM demo_marker')).length > result.captures);
    assert.equal((await repo.getScanInfo((await repo.listCaptureEvents({ hallId: HALL })).find((c) => c.source === 'demo').eventId)).demo, true);
    const removed = await new backend.demo.DemoService(repo).clear();
    assert.ok(removed.removedRows > 0);
    assert.equal((await repo.listCaptureEvents({ hallId: HALL })).length, realEvents, 'real scans untouched');
    assert.equal((await sql(DB, 'SELECT * FROM demo_marker')).length, 0);
    assert.ok(await repo.getMenuByService(SERVICE), 'the real menu is untouched');
    assert.equal((await repo.listServices(HALL)).filter((s) => s.serviceId.startsWith('svc_demo_')).length, 0);
  });

  it('full backend on SpacetimeDB: scans, image objects, counts; dashboard totals equal the rows', async () => {
    const gemini = fakeGemini();
    const s = await startBackend({ repo, analyzer: new backend.maskAnalyzer.MaskAnalyzer(gemini.gateway, boxFillerSam()) });
    try {
      const { adapter } = httpAdapter(s.baseUrl);
      const photos = await test2Photos(2);
      for (const photo of photos) {
        const r = await adapter.ingestPhoto({ photoPath: photo, captureKey: `st:${path.basename(photo)}`, capturedAt: `${DATE}T23:00:00.000Z`, timestampBasis: 'laptop_ingest', hallId: HALL, serviceId: SERVICE, source: 'replay', deviceId: 'simulated:test2', sourceName: path.basename(photo) });
        assert.ok(r.ok, r.error?.message);
        const event = await repo.getCaptureEvent(r.event.eventId);
        assert.equal(event.state, 'succeeded');
        const objects = await sql(DB, `SELECT * FROM image_object WHERE association_id = '${r.event.eventId}'`);
        assert.equal(objects.length, 3, 'original + normalized + overlay rows (references only, no bytes)');
        assert.equal((await repo.getScanInfo(r.event.eventId)).sourceName, path.basename(photo));
        assert.equal((await sql(DB, `SELECT * FROM capture_count WHERE event_id = '${r.event.eventId}'`)).length, 1);
      }
      const rows = await sumScanRows(repo, { hallId: HALL, start: DATE, end: DATE });
      const impact = await s.api('GET', `/api/dashboard/impact?hallId=${HALL}&start=${DATE}&end=${DATE}`);
      assert.equal(impact.json.totals.pixels, rows.pixels);
      const totals = await s.api('GET', `/api/dashboard/totals?hallId=${HALL}&today=${DATE}`);
      assert.equal(totals.json.today.pixels, rows.pixels);
      // Recommendations are saved in SpacetimeDB with their inputs.
      const rec = await s.api('POST', '/api/recommendation/regenerate', { hallId: HALL, start: DATE, end: DATE });
      assert.equal(rec.status, 200);
      const saved = await sql(DB, `SELECT * FROM insight WHERE hall_id = '${HALL}'`);
      assert.ok(saved.length >= 1);
    } finally {
      await s.close();
    }
  });
});

if (unavailable) console.log(`[spacetime] skipped: ${unavailable}`);
