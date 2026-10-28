/**
 * DETECTION RUNS (live, opt-in): the 12 scored test2/ photos through the same
 * pipeline as images.test.mjs (ingestPhoto → Gemini classify + boxes → SAM 2.1
 * → target-dish counting), repeated N times with identical settings, then
 * scored against ground_truth.csv with tests/support/scoring.mjs.
 *
 *   RUN_LIVE=1 node --env-file=../.env live/detection-runs.mjs --runs 3 --max-gemini 90
 *
 * Unlike images.test.mjs it writes nothing outside this machine: an in-memory
 * repository and a temporary local storage folder, no Supabase, no R2, no
 * recommendation. IMG_2705 (not on the menu, never scored) is skipped to save
 * calls. Stops before a photo could push the Gemini count past --max-gemini.
 * Report: images/live-test/detect-<time>/runs.json (gitignored).
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { REPO, backend, data, httpAdapter, startBackend, test2Photos, vision } from '../support/stack.mjs';
import { loadGroundTruth, scoreRuns } from '../support/scoring.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const RUNS = Number(arg('runs', 3));
const MAX_GEMINI = Number(arg('max-gemini', 90));
const SKIP_PHOTOS = new Set(['IMG_2705']);
// Isolation runs: --photos IMG_2700,IMG_2702 and --exclude-items 'Halal Rice,Tomatoes,Lettuce' (the 3 foods added 2026-10-04).
const ONLY_PHOTOS = arg('photos', '') ? new Set(arg('photos', '').split(',')) : null;
const EXCLUDE_ITEMS = new Set(arg('exclude-items', '').split(',').map((x) => x.trim()).filter(Boolean));
const SAM_URL = process.env.SAM_WORKER_URL ?? 'http://127.0.0.1:8790';
const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const OUT = path.join(REPO, 'images', 'live-test', `detect-${STAMP}`);
const DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit' }).format(new Date());

if (process.env.RUN_LIVE !== '1') {
  console.log('set RUN_LIVE=1 to run (calls Gemini)');
  process.exit(0);
}
if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
const truthFile = [process.env.GROUND_TRUTH_CSV, path.join(REPO, 'images', 'ground_truth.csv')].find((f) => f && existsSync(f));
if (!truthFile) throw new Error('images/ground_truth.csv is missing');
await fetch(`${SAM_URL}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => {
  throw new Error(`no SAM worker at ${SAM_URL}`);
});

mkdirSync(OUT, { recursive: true });
const truth = loadGroundTruth(truthFile);
const photos = (await test2Photos())
  .filter((p) => !SKIP_PHOTOS.has(path.basename(p).replace(/\.[^.]+$/, '')))
  .filter((p) => !ONLY_PHOTOS || ONLY_PHOTOS.has(path.basename(p).replace(/\.[^.]+$/, '')));
const gateway = vision.createGeminiGateway();
const settings = {
  model: gateway.model,
  seed: process.env.GEMINI_SEED ?? 'default (42)',
  passes: process.env.GEMINI_PASSES ?? 'default (2)',
  timeoutMs: process.env.GEMINI_TIMEOUT_MS ?? 'default (90000)',
  maxRetries: process.env.GEMINI_MAX_RETRIES ?? 'default (2)',
  photos: photos.map((p) => path.basename(p)),
  groundTruth: path.relative(REPO, truthFile),
  excludedMenuItems: [...EXCLUDE_ITEMS],
};
console.log(`[detect] ${RUNS} runs × ${photos.length} photos, model ${settings.model}, cap ${MAX_GEMINI} Gemini calls → ${path.relative(REPO, OUT)}`);

const runs = [];
let stopped = null;
for (let run = 1; run <= RUNS && !stopped; run++) {
  // A fresh in-memory backend per run, so no run can see another's captures.
  const s = await startBackend({ gateway, analyzer: new backend.maskAnalyzer.MaskAnalyzer(gateway, vision.createSamWorkerClient(SAM_URL)) });
  const HALL = `hall-detect-${run}`;
  const seedModule = await import(path.join(REPO, 'data/dist/data/src/seed/generate.js'));
  const serviceId = `svc_${HALL}_${DATE}_dinner`;
  const menuId = `menu_${HALL}_${DATE}_dinner`;
  const menu = {
    service: { serviceId, hallId: HALL, hallTimezone: 'America/Detroit', serviceDate: DATE, mealLabel: 'dinner', menuId, menuVersion: 1 },
    items: seedModule.factorDinnerItems().filter((it) => !EXCLUDE_ITEMS.has(it.name)).map((it) => ({
      itemId: `item_${HALL}_${DATE}_dinner_${data.factorKeyFor(it.name)}`,
      menuId,
      displayName: it.name,
      category: it.category,
      ...(it.description ? { description: it.description } : {}),
    })),
  };
  await s.repo.upsertMenu(menu);
  const names = new Map(menu.items.map((it) => [it.itemId, it.displayName]));
  const { adapter } = httpAdapter(s.baseUrl);
  const startCalls = gateway.callCount;
  const results = [];
  for (const photo of photos) {
    const name = path.basename(photo);
    if (gateway.callCount + 4 > MAX_GEMINI) {
      stopped = `stopped before ${name} in run ${run}: ${gateway.callCount} calls used, cap ${MAX_GEMINI}`;
      break;
    }
    const before = gateway.callCount;
    const r = await adapter.ingestPhoto({
      photoPath: photo,
      captureKey: `detect-${STAMP}-${run}:${name}`,
      capturedAt: new Date().toISOString(),
      timestampBasis: 'laptop_ingest',
      hallId: HALL,
      serviceId,
      source: 'replay',
      deviceId: 'simulated:test2',
      sourceName: name,
    });
    const row = { photo: name.replace(/\.[^.]+$/, ''), geminiCalls: gateway.callCount - before };
    results.push(row);
    if (!r.ok) {
      row.error = `${r.error.code}: ${r.error.message}`;
      row.counted = false;
      continue;
    }
    const attempt = (await s.repo.listAnalysisAttempts(r.event.eventId)).at(-1);
    const measurements = await s.repo.listMeasurementsByEvent(r.event.eventId);
    row.items = measurements
      .filter((m) => m.attemptId === attempt?.attemptId)
      .map((m) => ({ food: m.itemId === null ? null : names.get(m.itemId) ?? m.itemId, pixels: m.remainingAreaPx }));
    row.capturePixels = attempt?.segmentation?.capturePixelsWasted ?? null;
    row.counted = attempt?.segmentation?.countStatus === 'complete' || attempt?.segmentation?.countStatus === 'empty';
    row.flags = attempt?.qualityFlags ?? [];
    console.log(`  run ${run} ${name}: ${row.items.filter((x) => x.food).map((x) => x.food).join(', ') || 'no named food'} (${row.geminiCalls} calls, total ${gateway.callCount})`);
  }
  await s.close();
  const score = scoreRuns(results.filter((r) => r.items || r.error), truth);
  runs.push({ run, geminiCalls: gateway.callCount - startCalls, results, score });
  const pct = (x) => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
  console.log(`[detect] run ${run}: ${score.correct} correct, ${score.missed} missed, ${score.wrong} wrong over ${score.scored} photos → recall ${pct(score.recall)}, precision ${pct(score.precision)}`);
  writeFileSync(path.join(OUT, 'runs.json'), JSON.stringify({ settings, runs, stopped, geminiCalls: gateway.callCount }, null, 2));
}
if (stopped) console.log(`[detect] ${stopped}`);
console.log(`[detect] Gemini calls: ${gateway.callCount}`);
