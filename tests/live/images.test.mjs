/**
 * IMAGE TESTS (live, opt-in): every photo in test2/ through the full flow
 *   ingestPhoto → R2 (raw + normalized) → Gemini classify + per-piece boxes
 *   (2 passes) → SAM 2.1 masks → target-dish counting → overlay in R2 →
 *   SpacetimeDB rows → dashboard API → AI recommendation.
 *
 *   cd tests && npm run test:images        (sets RUN_LIVE=1, loads ../.env)
 *
 * Uses real Gemini (counts every call), the local SAM worker, R2 under a
 * test/live-<time>/ prefix and a throwaway SpacetimeDB database
 * (scrap-test-live-<time>); both are deleted at the end unless
 * KEEP_LIVE_DATA=1. Detections are scored against ground_truth.csv with the
 * rules of vision/scripts/score-experiment.py; a drop below the last
 * experiment (100% recall, 92.3% precision) is reported as a REGRESSION.
 * A report (per-photo results + local copies of the overlays) is written to
 * images/live-test/<time>/ (gitignored).
 *
 * LIVE_STACK=supabase runs the same flow on Supabase instead (Postgres +
 * Storage): a throwaway hall `hall-live-<time>` and a test/live-<time>/ prefix,
 * both deleted at the end unless KEEP_LIVE_DATA=1. GEMINI_CAP (default 60)
 * stops ingesting photos before the run can exceed that many Gemini calls.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  REPO,
  backend,
  cleanR2Prefix,
  cleanSupabasePrefix,
  listSupabase,
  supabaseAvailable,
  supabaseObjectStorage,
  data,
  deleteThrowaway,
  httpAdapter,
  listR2,
  publishThrowaway,
  r2Available,
  r2ObjectStorage,
  spacetimeAvailable,
  spacetimeRepo,
  startBackend,
  sumScanRows,
  test2Photos,
  vision,
} from '../support/stack.mjs';
import { BASELINE, loadGroundTruth, scoreRuns } from '../support/scoring.mjs';

const RUN = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const DB = `scrap-test-live-${RUN.toLowerCase()}`;
const PREFIX = `test/live-${RUN.toLowerCase()}/`;
const SUPA = process.env.LIVE_STACK === 'supabase';
// Supabase is the real project: never write test scans into a real hall.
const HALL = SUPA ? `hall-live-${RUN.toLowerCase()}` : 'hall-main';
const GEMINI_CAP = Number(process.env.GEMINI_CAP ?? 60);
const DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit' }).format(new Date());
const SAM_URL = process.env.SAM_WORKER_URL ?? 'http://127.0.0.1:8790';
const OUT = path.join(REPO, 'images', 'live-test', RUN);

async function why() {
  if (process.env.RUN_LIVE !== '1') return 'set RUN_LIVE=1 to run the live image tests (they call Gemini)';
  if (!process.env.GEMINI_API_KEY) return 'GEMINI_API_KEY is not set in .env';
  if (SUPA) {
    if (!supabaseAvailable()) return 'SUPABASE_URL (https://<ref>.supabase.co) and SUPABASE_SERVICE_ROLE_KEY are not set in .env';
  } else {
    if (!r2Available()) return 'R2 credentials are not set in .env';
    const st = await spacetimeAvailable();
    if (st) return st;
  }
  try {
    const res = await fetch(`${SAM_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return `the SAM worker at ${SAM_URL} answered ${res.status}`;
  } catch {
    return `no SAM worker at ${SAM_URL} (start it: .venv/bin/python vision/sam/worker.py)`;
  }
  return null;
}
const skip = await why();

describe('live image tests: test2/ through the full pipeline', { skip: skip ?? false }, () => {
  let s;
  let repo;
  let gateway;
  let menu;
  const results = [];
  const failures = [];
  const fail = (photo, error) => {
    failures.push(`${photo}: ${error}`);
    console.log(`  ✗ ${photo}: ${error}`);
  };

  before(async () => {
    mkdirSync(OUT, { recursive: true });
    if (SUPA) {
      const { SupabaseRepository } = await import(path.join(REPO, 'backend/dist/backend/src/repo/supabaseRepository.js'));
      repo = new SupabaseRepository({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
    } else {
      publishThrowaway(DB);
      repo = spacetimeRepo(DB);
    }
    gateway = vision.createGeminiGateway();
    const sam = vision.createSamWorkerClient(SAM_URL);
    s = await startBackend({
      repo,
      gateway,
      objectStorage: SUPA ? supabaseObjectStorage(PREFIX) : r2ObjectStorage(PREFIX),
      analyzer: new backend.maskAnalyzer.MaskAnalyzer(gateway, sam),
    });
    // The 23-food dinner (Gemini menu descriptions) with dummy portions (source 'demo').
    const seedModule = await import(path.join(REPO, 'data/dist/data/src/seed/generate.js'));
    const serviceId = `svc_${HALL}_${DATE}_dinner`;
    const menuId = `menu_${HALL}_${DATE}_dinner`;
    menu = {
      service: { serviceId, hallId: HALL, hallTimezone: 'America/Detroit', serviceDate: DATE, mealLabel: 'dinner', menuId, menuVersion: 1 },
      items: seedModule.factorDinnerItems().map((it) => ({
        itemId: `item_${HALL}_${DATE}_dinner_${data.factorKeyFor(it.name)}`,
        menuId,
        displayName: it.name,
        category: it.category,
        ...(it.description ? { description: it.description } : {}),
      })),
    };
    await repo.upsertMenu(menu);
    await repo.replacePortionsServed(serviceId, 1, seedModule.buildDemoPortions(menu));
    console.log(`[live] ${SUPA ? `Supabase, hall ${HALL}, storage prefix` : `database ${DB}, R2 prefix`} ${PREFIX}, ${menu.items.length} menu items, Gemini cap ${GEMINI_CAP}, report → ${path.relative(REPO, OUT)}`);
  });

  after(async () => {
    await s?.close();
    writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ run: RUN, database: DB, prefix: PREFIX, geminiCalls: gateway?.callCount, results, failures }, null, 2));
    if (process.env.KEEP_LIVE_DATA === '1') {
      console.log(`[live] KEEP_LIVE_DATA=1: kept ${SUPA ? `hall ${HALL}` : `database ${DB}`} and prefix ${PREFIX}`);
      return;
    }
    if (SUPA) {
      // Delete exactly this run's rows (children cascade) and objects.
      const { createClient } = createRequire(`${REPO}backend/package.json`)('@supabase/supabase-js');
      const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      const events = (await db.from('capture_event').select('event_id').eq('hall_id', HALL)).data ?? [];
      await db.from('capture_event').delete().eq('hall_id', HALL);
      await db.from('image_object').delete().like('object_key', `${PREFIX}%`);
      if (events.length) await db.from('image_object').delete().in('association_id', events.map((e) => e.event_id));
      await db.from('insight').delete().eq('hall_id', HALL);
      await db.from('meal_service').delete().eq('hall_id', HALL);
      await db.from('menu_item').delete().like('item_id', `%${HALL}%`);
      await db.from('hall').delete().eq('hall_id', HALL);
      const removed = await cleanSupabasePrefix(PREFIX).catch((e) => `failed: ${e.message}`);
      const left = await listSupabase(PREFIX).catch(() => ['?']);
      console.log(`[live] cleanup: ${removed} storage objects deleted (${left.length} left), rows of ${HALL} deleted`);
      return;
    }
    const removed = await cleanR2Prefix(PREFIX).catch((e) => `failed: ${e.message}`);
    const left = await listR2(PREFIX).catch(() => ['?']);
    const dbErr = deleteThrowaway(DB);
    console.log(`[live] cleanup: ${removed} R2 objects deleted (${left.length} left), database ${dbErr ? `NOT deleted: ${dbErr}` : 'deleted'}`);
  });

  it(`every photo: raw + segmented images in ${SUPA ? 'Supabase Storage' : 'R2'}, scan complete in ${SUPA ? 'Postgres' : 'SpacetimeDB'}, overlay and pixels present`, async () => {
    const photos = await test2Photos();
    const { adapter } = httpAdapter(s.baseUrl);
    for (const [i, photo] of photos.entries()) {
      const name = path.basename(photo);
      // Budget guard: a photo costs a few Gemini calls (more with retries); stop well before the cap.
      if (gateway.callCount + 8 > GEMINI_CAP) {
        fail(name, `not run: Gemini call cap ${GEMINI_CAP} would be exceeded (${gateway.callCount} used)`);
        continue;
      }
      const t0 = Date.now();
      const r = await adapter.ingestPhoto({
        photoPath: photo,
        captureKey: `live-${RUN}:${name}`,
        capturedAt: new Date().toISOString(),
        timestampBasis: 'laptop_ingest',
        hallId: HALL,
        serviceId: menu.service.serviceId,
        source: 'replay',
        deviceId: 'simulated:test2',
        sourceName: name,
      });
      const row = { photo: name.replace(/\.[^.]+$/, ''), ms: Date.now() - t0, geminiCallsSoFar: gateway.callCount };
      results.push(row);
      if (!r.ok) {
        fail(name, `${r.error.code}: ${r.error.message}`);
        continue;
      }
      row.eventId = r.event.eventId;
      const event = await repo.getCaptureEvent(r.event.eventId);
      row.state = event.state;
      const attempts = await repo.listAnalysisAttempts(r.event.eventId);
      const attempt = attempts.at(-1);
      row.flags = attempt?.qualityFlags ?? [];
      if (event.state !== 'succeeded') fail(name, `scan is ${event.state}${attempt?.error ? ` (${attempt.error.code}: ${attempt.error.message})` : ''}`);
      const scan = await repo.getScanInfo(r.event.eventId);
      const images = await s.api('GET', `/api/captures/${r.event.eventId}/images`);
      const raw = scan?.originalImageObjectId ? await repo.getImageObject(scan.originalImageObjectId) : undefined;
      const rawInR2 = raw ? (await s.storage.statObject(raw.objectKey)).exists : false;
      const overlayId = attempt?.overlayObjectId;
      const overlay = overlayId ? await repo.getImageObject(overlayId) : undefined;
      const overlayInR2 = overlay ? (await s.storage.statObject(overlay.objectKey)).exists : false;
      if (!rawInR2) fail(name, 'raw original is not in R2');
      if (!overlayInR2) fail(name, 'segmented overlay is not in R2');
      if (!images.json?.raw || !images.json?.overlay) fail(name, 'the images endpoint does not sign the raw photo and the overlay');
      if (overlay) {
        const { bytes } = await s.storage.getObjectBytes(overlay.objectKey);
        writeFileSync(path.join(OUT, `${row.photo}_overlay.jpg`), bytes);
      }
      const measurements = await repo.listMeasurementsByEvent(r.event.eventId);
      const names = new Map(menu.items.map((it) => [it.itemId, it.displayName]));
      row.items = measurements
        .filter((m) => m.attemptId === attempt?.attemptId)
        .map((m) => ({ food: m.itemId === null ? null : names.get(m.itemId) ?? m.itemId, pixels: m.remainingAreaPx }));
      row.capturePixels = attempt?.segmentation?.capturePixelsWasted ?? null;
      row.counted = attempt?.segmentation?.countStatus === 'complete' || attempt?.segmentation?.countStatus === 'empty';
      if (event.state === 'succeeded' && (row.capturePixels === null || !Number.isInteger(row.capturePixels))) fail(name, 'no pixel count');
      console.log(
        `  ${i + 1}/${photos.length} ${name}: ${event.state}, ${row.capturePixels ?? '-'} px, ` +
          `${row.items.filter((x) => x.food).map((x) => x.food).join(', ') || 'no named food'} · Gemini calls so far: ${gateway.callCount}`,
      );
    }
    assert.deepEqual(failures, [], `failures:\n${failures.join('\n')}`);
  });

  it("each dish's Waste Impact points = 0.19 × CO2 points + 1.50 × water points (no nutrition)", async () => {
    const impact = await s.api('GET', `/api/dashboard/impact?hallId=${HALL}&start=${DATE}&end=${DATE}`);
    assert.equal(impact.status, 200);
    const bad = [];
    for (const r of impact.json.mostWasted) {
      if (r.impact.impactPoints === null) continue;
      const expected = 0.19 * r.impact.co2Points + 1.5 * r.impact.waterPoints;
      if (Math.abs(r.impact.impactPoints - expected) > Math.max(0.02, expected * 0.002)) bad.push(`${r.displayName}: ${r.impact.impactPoints} vs ${expected}`);
    }
    assert.deepEqual(bad, []);
  });

  it('dashboard totals match the scan rows', async () => {
    const rows = await sumScanRows(repo, { hallId: HALL, start: DATE, end: DATE });
    const impact = await s.api('GET', `/api/dashboard/impact?hallId=${HALL}&start=${DATE}&end=${DATE}`);
    const totals = await s.api('GET', `/api/dashboard/totals?hallId=${HALL}&today=${DATE}`);
    console.log(`[live] totals: ${rows.pixels} px over ${rows.plates} plates; dashboard ${impact.json.totals.pixels} px; today ${totals.json.today.pixels} px`);
    assert.equal(impact.json.totals.pixels, rows.pixels);
    assert.equal(totals.json.today.pixels, rows.pixels);
    assert.equal(impact.json.totals.analyzedCaptures, rows.plates);
  });

  it('an AI recommendation is generated from the statistics and saved', async () => {
    const rec = await s.api('POST', '/api/recommendation/regenerate', { hallId: HALL, start: DATE, end: DATE });
    console.log(`[live] recommendation (${rec.json.source}): ${rec.json.text}`);
    for (const b of rec.json.bullets ?? []) console.log(`        - ${b.text} [${b.metric}]`);
    assert.equal(rec.status, 200);
    assert.equal(rec.json.source, 'gemini', 'Gemini wrote it (not the rule-based fallback)');
    assert.ok(rec.json.bullets.length >= 2 && rec.json.bullets.length <= 3);
    const saved = await repo.listInsights(HALL);
    assert.ok(saved.some((i) => i.generatedAt === rec.json.generatedAt && i.source === 'gemini'));
    writeFileSync(path.join(OUT, 'recommendation.json'), JSON.stringify(rec.json, null, 2));
  });

  // Scored only when ground_truth.csv is present. It was removed from git on 2026-10-04 and is kept in
  // the gitignored images/ folder (restore with: git show 174c2d4^:ground_truth.csv > images/ground_truth.csv).
  const truthFile = [process.env.GROUND_TRUTH_CSV, path.join(REPO, 'images', 'ground_truth.csv'), path.join(REPO, 'ground_truth.csv')]
    .find((f) => f && existsSync(f)) ?? path.join(REPO, 'images', 'ground_truth.csv');
  const noTruth = existsSync(truthFile) ? false : 'ground_truth.csv is not present: detection is not scored';
  it('detection vs ground_truth.csv: no regression from 100% recall / 92.3% precision', { skip: noTruth }, () => {
    const truth = loadGroundTruth(truthFile);
    const score = scoreRuns(results.filter((r) => r.eventId), truth);
    const pct = (x) => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
    console.log(`[live] detection: ${score.correct} correct, ${score.missed} missed, ${score.wrong} wrong over ${score.scored} scored photos → recall ${pct(score.recall)}, precision ${pct(score.precision)}`);
    for (const p of score.perPhoto) {
      if (!p.scored) console.log(`        ${p.photo}: ${p.reason}`);
      else if (p.missed || p.wrong) console.log(`        ${p.photo}: detected [${p.detected.join(', ')}] vs truth [${p.truth.join(', ')}] (${p.missed} missed, ${p.wrong} wrong)`);
    }
    console.log(`[live] Gemini calls in this run: ${gateway.callCount}`);
    writeFileSync(path.join(OUT, 'score.json'), JSON.stringify(score, null, 2));
    const regressions = [];
    if (score.recall !== null && score.recall < BASELINE.recall) regressions.push(`recall ${pct(score.recall)} < ${pct(BASELINE.recall)}`);
    if (score.precision !== null && score.precision < BASELINE.precision - 1e-9) regressions.push(`precision ${pct(score.precision)} < ${pct(BASELINE.precision)}`);
    assert.deepEqual(regressions, [], `REGRESSION: ${regressions.join('; ')}`);
  });
});

if (skip) console.log(`[live] skipped: ${skip}`);
