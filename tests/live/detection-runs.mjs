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
 *
 * Timing (Run 5): every Gemini attempt is timed through the gateway's onCall
 * hook (label localize-pass1/2, retries, answer characters, token counts,
 * pieces returned) and every SAM request is timed; the photo's total is the wall
 * clock of its whole ingest. Both passes are started together (Promise.allSettled),
 * so a photo's Gemini stage takes as long as its slower pass. Per-pass statistics
 * leave out passes that ended in a timeout and list them separately.
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
// Per-photo timing records, filled by the gateway hook and the SAM wrapper below.
let current = null;
const gateway = vision.createGeminiGateway({
  onCall: (c) => {
    if (!current) return;
    let pieces = null;
    try {
      const j = c.text ? JSON.parse(c.text) : null;
      pieces = Array.isArray(j) ? j.length : Array.isArray(j?.pieces) ? j.pieces.length : null;
    } catch {
      pieces = 'unparsable';
    }
    const { text, ...rest } = c;
    current.calls.push({ ...rest, pieces, startOffsetMs: Date.parse(c.startedAt) - current.t0 });
  },
});
const samClient = vision.createSamWorkerClient(SAM_URL);
const timedSam = {
  async segment(image, boxes) {
    const t = Date.now();
    try {
      return await samClient.segment(image, boxes);
    } finally {
      current?.sam.push({ ms: Date.now() - t, boxes: boxes.length });
    }
  },
};
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
  const s = await startBackend({ gateway, analyzer: new backend.maskAnalyzer.MaskAnalyzer(gateway, timedSam) });
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
    current = { t0: Date.now(), calls: [], sam: [] };
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
    row.timing = summarizeTiming(current, Date.now() - current.t0, truth.get(row.photo)?.size ?? null);
    current = null;
    results.push(row);
    if (!r.ok) {
      row.error = `${r.error.code}: ${r.error.message}`;
      row.counted = false;
      continue;
    }
    row.timing.image = { widthPx: r.event.geometry?.widthPx, heightPx: r.event.geometry?.heightPx, coordinateSpace: r.event.geometry?.coordinateSpace };
    const attempt = (await s.repo.listAnalysisAttempts(r.event.eventId)).at(-1);
    const measurements = await s.repo.listMeasurementsByEvent(r.event.eventId);
    row.items = measurements
      .filter((m) => m.attemptId === attempt?.attemptId)
      .map((m) => ({ food: m.itemId === null ? null : names.get(m.itemId) ?? m.itemId, pixels: m.remainingAreaPx }));
    row.capturePixels = attempt?.segmentation?.capturePixelsWasted ?? null;
    row.counted = attempt?.segmentation?.countStatus === 'complete' || attempt?.segmentation?.countStatus === 'empty';
    row.flags = attempt?.qualityFlags ?? [];
    const t = row.timing;
    const sec = (p) => (p ? `${(p.ms / 1000).toFixed(1)}s${p.timedOut ? ' TIMEOUT' : ''}${p.attempts > 1 ? ` (${p.attempts} tries)` : ''}` : '—');
    console.log(`  run ${run} ${name}: ${row.items.filter((x) => x.food).map((x) => x.food).join(', ') || 'no named food'} (${row.geminiCalls} calls, total ${gateway.callCount}) · pass1 ${sec(t.pass1)} · pass2 ${sec(t.pass2)} · SAM ${(t.samMs / 1000).toFixed(1)}s · total ${(t.totalMs / 1000).toFixed(1)}s`);
  }
  await s.close();
  const score = scoreRuns(results.filter((r) => r.items || r.error), truth);
  runs.push({ run, geminiCalls: gateway.callCount - startCalls, results, score });
  const pct = (x) => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
  console.log(`[detect] run ${run}: ${score.correct} correct, ${score.missed} missed, ${score.wrong} wrong over ${score.scored} photos → recall ${pct(score.recall)}, precision ${pct(score.precision)}`);
  // Save the raw records first, so a summary bug can never lose a paid run again.
  writeFileSync(path.join(OUT, 'runs.json'), JSON.stringify({ settings, runs, stopped, geminiCalls: gateway.callCount }, null, 2));
  const timingSummary = summarizeRun(results);
  console.log(timingTable(timingSummary));
  writeFileSync(path.join(OUT, 'runs.json'), JSON.stringify({ settings, runs, timingSummary, stopped, geminiCalls: gateway.callCount }, null, 2));
}
if (stopped) console.log(`[detect] ${stopped}`);
console.log(`[detect] Gemini calls: ${gateway.callCount}`);

/** One photo: each pass's attempts (wall clock from its first try to its last), SAM time and the total. */
function summarizeTiming(cur, totalMs, labeledFoods) {
  const pass = (label) => {
    const calls = cur.calls.filter((c) => c.label === label);
    if (!calls.length) return null;
    const last = calls.at(-1);
    const start = Math.min(...calls.map((c) => c.startOffsetMs));
    const end = Math.max(...calls.map((c) => c.startOffsetMs + c.durationMs));
    return {
      ms: end - start, startOffsetMs: start, attempts: calls.length, ok: last.ok, timedOut: !last.ok && last.errorCode === 'GEMINI_TIMEOUT',
      errors: calls.filter((c) => !c.ok).map((c) => c.errorCode), pieces: last.pieces ?? null, outputChars: last.outputChars ?? null,
      usage: last.usage ?? null, finishReason: last.finishReason ?? null, settings: last.settings, tries: calls.map((c) => ({ ms: c.durationMs, ok: c.ok, errorCode: c.errorCode ?? null, usage: c.usage ?? null })),
    };
  };
  const p1 = pass('localize-pass1');
  const p2 = pass('localize-pass2');
  return {
    labeledFoods, pass1: p1, pass2: p2, samMs: cur.sam.reduce((a, x) => a + x.ms, 0), samRequests: cur.sam.length,
    samBoxes: cur.sam.reduce((a, x) => a + x.boxes, 0), totalMs,
    passesConcurrent: Boolean(p1 && p2 && Math.abs(p1.startOffsetMs - p2.startOffsetMs) < 1000),
  };
}

// A function declaration (hoisted): a `const` here was still uninitialized when the top-level loop called it.
function stat(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { n: s.length, avgS: +(s.reduce((a, b) => a + b, 0) / s.length / 1000).toFixed(2), medianS: +(mid / 1000).toFixed(2), minS: +(s[0] / 1000).toFixed(2), maxS: +(s.at(-1) / 1000).toFixed(2) };
}

/** Per-pass average/median/fastest/slowest over the photos; timed-out passes listed, not averaged. */
function summarizeRun(results) {
  const t = results.map((r) => ({ photo: r.photo, ...r.timing })).filter((x) => x.totalMs !== undefined);
  const timeouts = (k) => t.filter((x) => x[k]?.timedOut).map((x) => x.photo);
  const anyTimeout = (x) => x.pass1?.timedOut || x.pass2?.timedOut;
  return {
    photos: t.length,
    pass1: { ...stat(t.filter((x) => x.pass1 && !x.pass1.timedOut).map((x) => x.pass1.ms)), timedOut: timeouts('pass1') },
    pass2: { ...stat(t.filter((x) => x.pass2 && !x.pass2.timedOut).map((x) => x.pass2.ms)), timedOut: timeouts('pass2') },
    sam: stat(t.filter((x) => x.samRequests > 0).map((x) => x.samMs)),
    total: { ...stat(t.filter((x) => !anyTimeout(x)).map((x) => x.totalMs)), excluded: t.filter(anyTimeout).map((x) => x.photo) },
    concurrentPasses: t.filter((x) => x.passesConcurrent).length,
    retriedPasses: t.flatMap((x) => [x.pass1, x.pass2].filter((p) => p && p.attempts > 1).map(() => x.photo)),
  };
}

function timingTable(s) {
  const row = (name, x, extra = '') => `  ${name.padEnd(7)} avg ${x?.avgS ?? '—'}s · median ${x?.medianS ?? '—'}s · fastest ${x?.minS ?? '—'}s · slowest ${x?.maxS ?? '—'}s (n ${x?.n ?? 0})${extra}`;
  return ['[timing] seconds, wall clock; timeouts not averaged',
    row('pass 1', s.pass1, s.pass1.timedOut.length ? ` · timed out: ${s.pass1.timedOut.join(', ')}` : ''),
    row('pass 2', s.pass2, s.pass2.timedOut.length ? ` · timed out: ${s.pass2.timedOut.join(', ')}` : ''),
    row('SAM', s.sam),
    row('total', s.total, s.total.excluded.length ? ` · left out (a pass timed out): ${s.total.excluded.join(', ')}` : ''),
    `  passes run at the same time on ${s.concurrentPasses} of ${s.photos} photos`].join('\n');
}
