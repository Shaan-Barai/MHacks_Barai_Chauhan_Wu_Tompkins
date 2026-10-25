/**
 * Integration: the full backend on Supabase (Postgres + Storage), the twin of
 * spacetime.test.mjs. Uses a per-run hall (hall-sbit-<time>) and a test/<run>/
 * storage prefix; every row and object it creates is deleted afterwards.
 * Gemini and SAM are fakes, so it spends no Gemini calls.
 *
 * Covers: an upload lands in Storage and only its path is saved in Postgres;
 * write functions are atomic; portions replace; demo data clears exactly its
 * rows; dashboard totals equal the sum of the scan rows.
 *
 * Skipped (with a message) when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not in ../.env.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  DATE,
  HALL,
  REPO,
  backend,
  boxFillerSam,
  cleanSupabasePrefix,
  demoPortions,
  dinnerMenu,
  fakeGemini,
  httpAdapter,
  listSupabase,
  startBackend,
  sumScanRows,
  supabaseAvailable,
  supabaseObjectStorage,
  test2Photos,
} from '../support/stack.mjs';

const skip = supabaseAvailable() ? false : 'SUPABASE_URL (https://<ref>.supabase.co) and SUPABASE_SERVICE_ROLE_KEY are not set in .env';
const RUN = `sbit${Date.now().toString(36)}`;
const RUN_HALL = `hall-${RUN}`;
const PREFIX = `test/${RUN}/`;
/** The shared dinner fixture, re-labelled onto this run's hall. */
const relabel = (value) => JSON.parse(JSON.stringify(value).replaceAll(HALL, RUN_HALL));
const menuV = (v, items) => {
  const m = relabel(dinnerMenu());
  return { service: { ...m.service, menuVersion: v }, items: items ?? m.items };
};
const SERVICE = menuV(1).service.serviceId;

describe(`Supabase backend end to end (hall ${RUN_HALL})`, { skip }, () => {
  let repo;
  let db;
  before(async () => {
    const { SupabaseRepository } = await import(path.join(REPO, 'backend/dist/backend/src/repo/supabaseRepository.js'));
    repo = new SupabaseRepository({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
    const { createClient } = createRequire(`${REPO}backend/package.json`)('@supabase/supabase-js');
    db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  });
  after(async () => {
    if (skip) return;
    // Children cascade from capture_event / meal_service; delete only this run's rows.
    const events = (await db.from('capture_event').select('event_id').eq('hall_id', RUN_HALL)).data ?? [];
    await db.from('capture_event').delete().eq('hall_id', RUN_HALL);
    await db.from('image_object').delete().like('object_key', `${PREFIX}%`);
    if (events.length) await db.from('image_object').delete().in('association_id', events.map((e) => e.event_id));
    await db.from('insight').delete().eq('hall_id', RUN_HALL);
    await db.from('meal_service').delete().eq('hall_id', RUN_HALL);
    await db.from('menu_item').delete().like('item_id', `%${RUN_HALL}%`);
    await db.from('menu_item_revision').delete().like('item_id', `%${RUN_HALL}%`);
    await db.from('dashboard_view').delete().eq('hall_id', RUN_HALL);
    await db.from('demo_marker').delete().like('row_key', `%${RUN_HALL}%`);
    await db.from('hall').delete().eq('hall_id', RUN_HALL);
    await cleanSupabasePrefix(PREFIX);
    const left = await Promise.all(['capture_event', 'meal_service', 'hall'].map(async (t) => (await db.from(t).select('*', { count: 'exact', head: true }).eq('hall_id', RUN_HALL)).count));
    assert.deepEqual(left, [0, 0, 0], 'this run left no rows behind');
  });

  it('menus: insert, forward-only versions, revision archive', async () => {
    await repo.upsertMenu(menuV(1));
    await repo.upsertMenu(menuV(2, menuV(1).items.slice(0, 3)));
    await assert.rejects(repo.upsertMenu(menuV(1)), /newer version|older/i, 'an older version never overwrites a newer one');
    assert.equal((await repo.getMenuByService(SERVICE)).service.menuVersion, 2);
    assert.ok(await repo.getMenuItem(menuV(1).items[3].itemId), 'the dropped item is kept in the revision archive');
    await repo.upsertMenu(menuV(3));
    assert.deepEqual((await repo.getMenuByService(SERVICE)).items.map((i) => i.displayName), menuV(1).items.map((i) => i.displayName), 'upload order kept');
  });

  it('record_analysis is atomic: an inconsistent count writes nothing', async () => {
    const img = { objectId: `img_${RUN}_x`, provider: 'supabase', container: 'scrap-images', objectKey: `${PREFIX}captures/x.jpg`, mimeType: 'image/jpeg', sizeBytes: 1, association: { kind: 'capture', id: `cap_${RUN}_1` }, state: 'finalized' };
    await repo.upsertImageObject(img);
    const event = { eventId: `cap_${RUN}_1`, hallId: RUN_HALL, serviceId: SERVICE, capturedAt: `${DATE}T22:00:00.000Z`, imageObjectId: img.objectId, geometry: { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' }, source: 'camera', qualityFlags: [], state: 'processing' };
    await repo.upsertCaptureEvent(event);
    await repo.upsertCaptureEvent({ ...event, state: 'failed' });
    assert.equal((await repo.listCaptureEvents({ serviceId: SERVICE })).length, 1, 'a retry updates the same capture');
    const attempt = (id, capture) => ({
      eventId: event.eventId, attemptId: id, menuId: menuV(3).service.menuId, menuVersion: 3, baselineVersions: {}, model: 'm', promptVersion: 'p', status: 'succeeded', qualityFlags: [], createdAt: new Date().toISOString(),
      segmentation: { model: 'sam', checkpoint: 'c', codeRevision: 'r', promptSource: 'gemini_box', settingsVersion: 's', countingRuleVersion: 'target-dish-v1', status: 'succeeded', countStatus: 'complete', capturePixelsWasted: capture, widthPx: 1024, heightPx: 1024, regions: [] },
    });
    const m = (id, attemptId, px) => ({ measurementId: id, eventId: event.eventId, attemptId, itemId: null, remainingAreaPx: px, method: 'mask_pixel_count', qualityFlags: [] });
    await assert.rejects(repo.recordAnalysis(attempt(`att_${RUN}_bad`, 999), [m(`m_${RUN}_bad`, `att_${RUN}_bad`, 100)]), /capture union/);
    assert.equal((await db.from('analysis_attempt').select('*', { count: 'exact', head: true }).eq('attempt_id', `att_${RUN}_bad`)).count, 0);
    assert.equal((await db.from('food_measurement').select('*', { count: 'exact', head: true }).eq('measurement_id', `m_${RUN}_bad`)).count, 0);
    await repo.recordAnalysis(attempt(`att_${RUN}_ok`, 300), [m(`m_${RUN}_1`, `att_${RUN}_ok`, 100), m(`m_${RUN}_2`, `att_${RUN}_ok`, 200)]);
    assert.equal((await repo.listMeasurementsByAttempt(`att_${RUN}_ok`)).length, 2);
    // This scratch capture is not part of the dashboard-totals check below.
    await db.from('capture_event').delete().eq('event_id', event.eventId);
  });

  it('portions served: replacement snapshot for the current menu version only', async () => {
    const menu = menuV(3);
    const rows = demoPortions(menu).map((p) => ({ ...p, menuVersion: 3, recordId: JSON.stringify([SERVICE, 3, p.itemId]) }));
    await repo.replacePortionsServed(SERVICE, 3, rows);
    await repo.replacePortionsServed(SERVICE, 3, rows.slice(0, 2));
    assert.equal((await repo.listPortionsServed(SERVICE, 3)).length, 2, 'a snapshot replaces, never adds');
    await assert.rejects(repo.replacePortionsServed(SERVICE, 1, rows), /menu changed|STALE/i);
  });

  it('sample data: clear_demo_data removes exactly the marked rows', async () => {
    const before = (await db.from('demo_marker').select('*', { count: 'exact', head: true })).count;
    assert.equal(before, 0, 'no other sample data exists, so clearing cannot touch anyone else');
    const result = await new backend.demo.DemoService(repo).seedHistory({ hallId: RUN_HALL, endDate: DATE, days: 2 });
    assert.ok(result.captures > 0);
    const removed = await new backend.demo.DemoService(repo).clear();
    assert.ok(removed.removedRows > 0);
    assert.equal((await db.from('demo_marker').select('*', { count: 'exact', head: true })).count, 0);
    assert.ok(await repo.getMenuByService(SERVICE), 'the real menu is untouched');
    assert.equal((await repo.listServices(RUN_HALL)).filter((s) => s.serviceId.startsWith('svc_demo_')).length, 0);
  });

  it('full backend: uploads land in Storage with only their path in Postgres; dashboard totals equal the scan rows', async () => {
    const gemini = fakeGemini();
    const s = await startBackend({ repo, objectStorage: supabaseObjectStorage(PREFIX), analyzer: new backend.maskAnalyzer.MaskAnalyzer(gemini.gateway, boxFillerSam()) });
    try {
      const { adapter } = httpAdapter(s.baseUrl);
      for (const photo of await test2Photos(2)) {
        const r = await adapter.ingestPhoto({ photoPath: photo, captureKey: `${RUN}:${path.basename(photo)}`, capturedAt: `${DATE}T23:00:00.000Z`, timestampBasis: 'laptop_ingest', hallId: RUN_HALL, serviceId: SERVICE, source: 'replay', deviceId: 'simulated:test2', sourceName: path.basename(photo) });
        assert.ok(r.ok, r.error?.message);
        assert.equal((await repo.getCaptureEvent(r.event.eventId)).state, 'succeeded');
        // Every image this capture produced: a Postgres row holding the path, and the bytes in Storage.
        const { data: rows } = await db.from('image_object').select('*').eq('association_id', r.event.eventId);
        assert.ok(rows.length >= 2, 'original + normalized (+ overlay)');
        const stored = new Set(await listSupabase(PREFIX));
        for (const row of rows) {
          assert.equal(row.provider, 'supabase');
          assert.ok(row.object_key.startsWith(PREFIX), row.object_key);
          assert.ok(stored.has(row.object_key), `${row.object_key} is in the bucket`);
          assert.ok(JSON.stringify(row).length < 800 && !/base64|data:image/.test(JSON.stringify(row)), 'the row is a path + metadata, never image data');
        }
      }
      assert.equal(gemini.calls(), 4, 'fake Gemini only (2 calls per photo); no real Gemini call');
      const rows = await sumScanRows(repo, { hallId: RUN_HALL, start: DATE, end: DATE });
      assert.ok(rows.pixels > 0);
      const impact = await s.api('GET', `/api/dashboard/impact?hallId=${RUN_HALL}&start=${DATE}&end=${DATE}`);
      assert.equal(impact.json.totals.pixels, rows.pixels, 'dashboard total = sum of scan rows');
      const totals = await s.api('GET', `/api/dashboard/totals?hallId=${RUN_HALL}&today=${DATE}`);
      assert.equal(totals.json.today.pixels, rows.pixels);
      const plates = await s.api('GET', `/api/captures?hallId=${RUN_HALL}&start=${DATE}&end=${DATE}`);
      assert.equal(plates.json.filter((p) => p.state === 'succeeded').length, rows.plates);
    } finally {
      await s.close();
    }
  });
});
