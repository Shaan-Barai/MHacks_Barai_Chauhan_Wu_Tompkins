/**
 * CAMERA TESTS over SSH (opt-in, RUN_CAMERA=1). One stage per call, so a
 * person can place a plate (or clear the tray) between stages:
 *
 *   cd tests && npm run test:camera -- auto        # stages 1-6, stop at the first failure
 *   cd tests && npm run test:camera -- plate       # 7: a plate of food under the camera
 *   cd tests && npm run test:camera -- empty       # 8: nothing under the camera
 *   cd tests && npm run test:camera -- reliability # 9: 5 captures in a row
 *   cd tests && npm run test:camera -- cleanup     # 10: board temp files, R2 test/ prefix, test database
 *
 * Stages: reachable, login, camera, tools, capture, transfer, plate, empty,
 * reliability, cleanup. (Pixels only: there is no plate-size calibration stage.)
 *
 * Board access is key-only (BatchMode, connect timeout): it never waits on a
 * password. Nothing is installed or reconfigured on the board; the only board
 * files touched are the capture bundles this run created (deleted in cleanup).
 * Full-flow stages use real Gemini + SAM, R2 under test/camera-<run>/ and a
 * throwaway SpacetimeDB database, all removed by `cleanup`. Photos and
 * overlays are saved to images/camera-test/<run>/ for review.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  REPO,
  backend,
  capture,
  cleanR2Prefix,
  data,
  deleteThrowaway,
  httpAdapter,
  listR2,
  publishThrowaway,
  r2ObjectStorage,
  spacetimeRepo,
  startBackend,
  vision,
} from '../support/stack.mjs';

const STAGES = ['reachable', 'login', 'camera', 'tools', 'capture', 'transfer', 'plate', 'empty', 'reliability', 'cleanup'];
const STATE_DIR = path.join(REPO, 'images', 'camera-test');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const HALL = 'hall-main';

const stageArg = process.argv[2] ?? 'auto';
if (process.env.RUN_CAMERA !== '1') {
  console.log('Camera tests are opt-in: set RUN_CAMERA=1 (npm run test:camera does).');
  process.exit(0);
}
if (stageArg !== 'auto' && !STAGES.includes(stageArg)) {
  console.error(`Unknown stage "${stageArg}". Use auto or one of: ${STAGES.join(', ')}`);
  process.exit(2);
}

function loadState() {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const run = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase();
  return { run, db: `scrap-test-camera-${run}`, prefix: `test/camera-${run}/`, dbPublished: false, captureIds: [], results: {} };
}
const state = loadState();
const OUT = path.join(STATE_DIR, state.run);
mkdirSync(OUT, { recursive: true });
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const config = capture.loadCameraConfig();
const run = capture.spawnRunner;

class StageFailure extends Error {
  constructor(message, likely) {
    super(message);
    this.likely = likely;
  }
}

async function board(cmd, timeoutMs = 20_000) {
  const r = await capture.runOnBoard(run, config, cmd, timeoutMs);
  if (r.code === 255 || r.timedOut) throw new StageFailure(capture.explainSshFailure(r, config), 'SSH failed; rerun the login stage');
  return r;
}

// --- stages ------------------------------------------------------------------

async function reachable() {
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: config.host, port: 22, timeout: 5000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('no answer within 5 s'));
    });
    socket.once('error', reject);
  }).catch((e) => {
    throw new StageFailure(
      `${config.host}:22 did not answer (${e.message}).`,
      'the board is off or off Wi-Fi, its IP changed (update CAMERA_HOST in .env), or this computer is not on the campus network',
    );
  });
  return `${config.host}:22 answered in ${Date.now() - t0} ms`;
}

async function login() {
  const r = await board('echo login-ok; uname -sr; date -u +%Y-%m-%dT%H:%M:%SZ');
  const [ok, uname, boardTime] = r.stdout.toString().trim().split('\n');
  if (ok !== 'login-ok') throw new StageFailure(`unexpected answer: ${r.stdout}`, 'the login shell printed something unexpected');
  const skew = Math.abs(Date.now() - Date.parse(boardTime)) / 1000;
  return `key login as ${config.user} (BatchMode, ${config.connectTimeoutS} s timeout); ${uname}; board clock off by ${skew.toFixed(0)} s (not used for scan times)`;
}

async function camera() {
  const r = await board('v4l2-ctl --list-devices 2>&1');
  const devices = capture.parseV4l2Devices(r.stdout.toString());
  const node = capture.pickCameraNode(devices, config.deviceName);
  if (!node) {
    throw new StageFailure(
      `no device named "${config.deviceName}" (found: ${devices.map((d) => `${d.name} [${d.nodes.join(', ')}]`).join('; ') || 'none'})`,
      'power: the C920 may need a powered USB-C hub on the UNO Q; or the cable/hub is loose',
    );
  }
  const formats = (await board(`v4l2-ctl -d ${node} --list-formats-ext 2>&1`)).stdout.toString();
  const mjpg = /MJPG/.test(formats) && /1920x1080/.test(formats);
  if (!mjpg) throw new StageFailure(`${node} does not offer MJPG 1920x1080`, 'the wrong node was picked or another program holds the camera');
  state.device = node;
  return `${devices.find((d) => d.nodes.includes(node)).name} → capture node ${node} (picked by name; ${devices.find((d) => d.nodes.includes(node)).nodes.join(', ')}); MJPG 1920x1080 offered`;
}

async function tools() {
  const r = await board(
    'for t in ffmpeg fswebcam v4l2-ctl python3; do if command -v $t >/dev/null 2>&1; then echo "$t yes"; else echo "$t no"; fi; done; ' +
      `if [ -f ${config.remoteScript} ]; then echo "script yes $(sha256sum ${config.remoteScript} | cut -d' ' -f1)"; else echo "script no"; fi`,
  );
  const lines = Object.fromEntries(r.stdout.toString().trim().split('\n').map((l) => [l.split(' ')[0], l.split(' ').slice(1)]));
  const have = (t) => lines[t]?.[0] === 'yes';
  const repoSha = createHash('sha256').update(readFileSync(path.join(REPO, 'capture/uno-q/uno_q_camera.py'))).digest('hex');
  const summary = `ffmpeg ${have('ffmpeg') ? 'yes' : 'NO'}, fswebcam ${have('fswebcam') ? 'yes' : 'no'}, v4l2-ctl ${have('v4l2-ctl') ? 'yes' : 'NO'}, python3 ${have('python3') ? 'yes' : 'NO'}, board script ${have('script') ? (lines.script[1] === repoSha ? 'up to date' : 'DIFFERENT from the repo copy') : 'MISSING'}`;
  if (!have('ffmpeg') || !have('python3')) {
    throw new StageFailure(summary, 'a capture tool is missing; ask before installing (sudo apt install ffmpeg)');
  }
  if (!have('script')) throw new StageFailure(summary, `the board script is not at ~/${config.remoteScript}; ask before copying it (capture/uno-q/README.md step 4)`);
  state.boardScriptCurrent = lines.script[1] === repoSha;
  return summary;
}

async function takeOne(label) {
  const t0 = Date.now();
  const photo = await capture.takePhoto({
    config: { ...config, ...(state.device ? { device: state.device } : {}) },
    outDir: path.join(OUT, 'photos'),
    laptopCaptureScript: path.join(REPO, 'capture/uno-q/laptop_capture.py'),
  });
  state.captureIds.push(photo.captureId);
  save();
  return { photo, ms: Date.now() - t0, label };
}

async function captureStage() {
  const { photo, ms } = await takeOne('capture');
  const bytes = readFileSync(photo.photoPath);
  const verdict = await capture.checkCameraPhoto(bytes, { widthPx: config.widthPx, heightPx: config.heightPx });
  writeFileSync(path.join(OUT, 'capture.jpg'), bytes);
  state.lastCapture = { captureId: photo.captureId, sha256: photo.sha256, photoPath: photo.photoPath, ms, triggeredAt: photo.triggeredAt, receivedAt: photo.receivedAt };
  const q = verdict.quality;
  const detail = `${q.widthPx}x${q.heightPx} ${q.format}, brightness ${q.brightness.toFixed(0)}/255, sharpness ${q.sharpness.toFixed(0)}, ${(bytes.length / 1024).toFixed(0)} KB, warmup ${config.warmupSeconds} s (≈${Math.round(config.warmupSeconds * 30)} frames discarded)`;
  if (!verdict.ok) throw new StageFailure(`${detail}: ${verdict.problems.join('; ')}`, 'camera view: open the privacy shutter, add light, check focus and framing');
  return `${detail}; saved images/camera-test/${state.run}/capture.jpg`;
}

async function transfer() {
  const last = state.lastCapture;
  if (!last) throw new StageFailure('no capture to check', 'run the capture stage first');
  const py = `import zipfile,hashlib,os;p=os.path.expanduser('~/scrap-camera/captures/${last.captureId}.zip');print(hashlib.sha256(zipfile.ZipFile(p).read('photo.jpg')).hexdigest())`;
  const r = await board(`python3 -c "${py}"`);
  const boardSha = r.stdout.toString().trim();
  const laptopSha = createHash('sha256').update(readFileSync(last.photoPath)).digest('hex');
  if (boardSha !== laptopSha) throw new StageFailure(`board ${boardSha.slice(0, 16)}… ≠ laptop ${laptopSha.slice(0, 16)}…`, 'a corrupted or truncated transfer');
  const transferMs = Date.parse(last.receivedAt) - Date.parse(last.triggeredAt);
  return `SHA-256 matches on both ends (${laptopSha.slice(0, 16)}…); trigger to photo on this computer ${(transferMs / 1000).toFixed(1)} s`;
}

/** Full-flow helper: backend on the throwaway database + R2 test prefix, real Gemini + SAM. */
async function withPipeline(fn) {
  if (!state.dbPublished) {
    publishThrowaway(state.db);
    state.dbPublished = true;
    save();
  }
  const repo = spacetimeRepo(state.db);
  const gateway = vision.createGeminiGateway();
  const s = await startBackend({
    repo,
    gateway,
    objectStorage: r2ObjectStorage(state.prefix),
    analyzer: new backend.maskAnalyzer.MaskAnalyzer(gateway, vision.createSamWorkerClient(process.env.SAM_WORKER_URL)),
  });
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit' }).format(new Date());
  const serviceId = `svc_${HALL}_${date}_dinner`;
  if (!(await repo.getMenuByService(serviceId))) {
    const seed = await import(path.join(REPO, 'data/dist/data/src/seed/generate.js'));
    const menuId = `menu_${HALL}_${date}_dinner`;
    const menu = {
      service: { serviceId, hallId: HALL, hallTimezone: 'America/Detroit', serviceDate: date, mealLabel: 'dinner', menuId, menuVersion: 1 },
      items: seed.factorDinnerItems().map((it) => ({ itemId: `item_${HALL}_${date}_dinner_${data.factorKeyFor(it.name)}`, menuId, displayName: it.name, category: it.category, ...(it.description ? { description: it.description } : {}) })),
    };
    await repo.upsertMenu(menu);
    await repo.replacePortionsServed(serviceId, 1, seed.buildDemoPortions(menu));
  }
  // CAMERA_EXTRA_FOODS="Halal Rice,Tomato,Lettuce": foods on the test plate that are not
  // on the dinner menu are added as a menu revision so Gemini can classify them.
  const extra = (process.env.CAMERA_EXTRA_FOODS ?? '').split(',').map((f) => f.trim()).filter(Boolean);
  if (extra.length) {
    const current = await repo.getMenuByService(serviceId);
    const missing = extra.filter((f) => !current.items.some((i) => i.displayName.toLowerCase() === f.toLowerCase()));
    if (missing.length) {
      await repo.upsertMenu({
        service: { ...current.service, menuVersion: current.service.menuVersion + 1 },
        items: [
          ...current.items,
          ...missing.map((f) => ({ itemId: `item_${HALL}_${date}_dinner_${data.factorKeyFor(f)}`, menuId: current.service.menuId, displayName: f, category: 'Test plate' })),
        ],
      });
    }
  }
  try {
    return await fn({ s, repo, gateway, serviceId, date });
  } finally {
    await s.close();
  }
}

/** One photo from the camera through the whole flow; returns timings, rows and local image copies. */
async function cameraScan(ctx, label) {
  const t0 = Date.now();
  const { photo } = await takeOne(label);
  const { adapter } = httpAdapter(ctx.s.baseUrl, path.join(OUT, 'ingest-state.json'));
  const r = await adapter.ingestPhoto({
    photoPath: photo.photoPath,
    captureKey: photo.captureId,
    capturedAt: photo.triggeredAt,
    timestampBasis: 'laptop_trigger',
    hallId: HALL,
    serviceId: ctx.serviceId,
    source: 'camera',
    deviceId: config.deviceId,
    expectedSha256: photo.sha256,
  });
  if (!r.ok) throw new StageFailure(`${r.error.code}: ${r.error.message}`, 'ingest failed (R2 or SpacetimeDB)');
  // Visible on the dashboard API = trigger-to-dashboard time.
  const list = await ctx.s.api('GET', `/api/captures?hallId=${HALL}&start=${ctx.date}&end=${ctx.date}&limit=200`);
  const listed = (Array.isArray(list.json) ? list.json : list.json.captures).find((c) => c.eventId === r.event.eventId);
  const dashboardMs = Date.now() - t0;
  const event = await ctx.repo.getCaptureEvent(r.event.eventId);
  const attempt = (await ctx.repo.listAnalysisAttempts(r.event.eventId)).at(-1);
  const measurements = (await ctx.repo.listMeasurementsByEvent(r.event.eventId)).filter((m) => m.attemptId === attempt?.attemptId);
  const scan = await ctx.repo.getScanInfo(r.event.eventId);
  const raw = scan?.originalImageObjectId ? await ctx.repo.getImageObject(scan.originalImageObjectId) : undefined;
  const overlay = attempt?.overlayObjectId ? await ctx.repo.getImageObject(attempt.overlayObjectId) : undefined;
  const files = {};
  if (raw) {
    files.original = path.join(OUT, `${label}_original.jpg`);
    writeFileSync(files.original, (await ctx.s.storage.getObjectBytes(raw.objectKey)).bytes);
  }
  if (overlay) {
    files.overlay = path.join(OUT, `${label}_overlay.jpg`);
    writeFileSync(files.overlay, (await ctx.s.storage.getObjectBytes(overlay.objectKey)).bytes);
  }
  const items = await ctx.repo.getMenuByService(ctx.serviceId);
  const names = new Map(items.items.map((i) => [i.itemId, i.displayName]));
  return {
    eventId: r.event.eventId,
    state: event.state,
    error: attempt?.error,
    flags: attempt?.qualityFlags ?? [],
    pixels: attempt?.segmentation?.capturePixelsWasted ?? null,
    countStatus: attempt?.segmentation?.countStatus,
    foods: measurements.map((m) => `${m.itemId === null ? 'Food not on the menu' : names.get(m.itemId)} ${m.remainingAreaPx} px`),
    rawInR2: raw ? (await ctx.s.storage.statObject(raw.objectKey)).exists : false,
    overlayInR2: overlay ? (await ctx.s.storage.statObject(overlay.objectKey)).exists : false,
    listedOnDashboard: Boolean(listed),
    dashboardMs,
    geminiCalls: ctx.gateway.callCount,
    files,
  };
}

async function plate() {
  return withPipeline(async (ctx) => {
    const scan = await cameraScan(ctx, 'plate');
    state.results.plate = scan;
    const problems = [];
    if (scan.state !== 'succeeded') problems.push(`scan is ${scan.state}${scan.error ? ` (${scan.error.code}: ${scan.error.message})` : ''}`);
    if (!scan.rawInR2) problems.push('raw photo not in R2');
    if (!scan.overlayInR2) problems.push('overlay not in R2');
    if (!scan.listedOnDashboard) problems.push('not on the dashboard API');
    if (scan.foods.length === 0) problems.push('no food detected on the plate');
    // CAMERA_EXPECT_FOODS: what is actually on the plate (compared, reported).
    const expected = (process.env.CAMERA_EXPECT_FOODS ?? '').split(',').map((f) => f.trim()).filter(Boolean);
    if (expected.length) {
      const detected = scan.foods.map((f) => f.replace(/ \d+ px$/, ''));
      const missed = expected.filter((e) => !detected.some((d) => d.toLowerCase() === e.toLowerCase()));
      const extra = detected.filter((d) => !expected.some((e) => e.toLowerCase() === d.toLowerCase()));
      scan.expected = { expected, missed, extra };
      if (missed.length || extra.length) problems.push(`expected [${expected.join(', ')}]: missed [${missed.join(', ')}], extra [${extra.join(', ')}]`);
    }
    const rel = (f) => path.relative(REPO, f);
    const detail = `${scan.state}, ${scan.pixels} px: ${scan.foods.join('; ') || 'none'}; flags [${scan.flags.join(', ')}]; ${(scan.dashboardMs / 1000).toFixed(1)} s trigger→dashboard; Gemini calls ${scan.geminiCalls}; original ${scan.files.original ? rel(scan.files.original) : '-'}, overlay ${scan.files.overlay ? rel(scan.files.overlay) : '-'}`;
    if (problems.length) throw new StageFailure(`${detail} — ${problems.join('; ')}`, 'see the original/overlay for framing, focus and lighting');
    return detail;
  });
}

async function empty() {
  return withPipeline(async (ctx) => {
    const scan = await cameraScan(ctx, 'empty');
    state.results.empty = scan;
    const detail = `${scan.state}, count ${scan.countStatus}, ${scan.pixels} px, ${scan.foods.length} waste rows; flags [${scan.flags.join(', ')}]`;
    if (scan.state !== 'succeeded' || scan.foods.length !== 0 || (scan.pixels ?? 0) !== 0) {
      throw new StageFailure(detail, scan.foods.length ? 'something under the camera was counted as food: check the tray is clear' : 'an empty tray should complete with zero waste');
    }
    return `${detail} (completed with zero dishes, nothing crashed)`;
  });
}

async function reliability() {
  return withPipeline(async (ctx) => {
    const runs = [];
    for (let i = 1; i <= 5; i++) {
      try {
        const scan = await cameraScan(ctx, `reliability_${i}`);
        runs.push({ ok: scan.state === 'succeeded' && scan.rawInR2 && scan.listedOnDashboard, ms: scan.dashboardMs, state: scan.state });
        console.log(`    ${i}/5: ${scan.state} in ${(scan.dashboardMs / 1000).toFixed(1)} s`);
      } catch (e) {
        runs.push({ ok: false, error: e.message });
        console.log(`    ${i}/5: FAILED ${e.message}`);
      }
    }
    state.results.reliability = runs;
    const ok = runs.filter((r) => r.ok);
    const avg = ok.length ? ok.reduce((s, r) => s + r.ms, 0) / ok.length / 1000 : NaN;
    const detail = `${ok.length}/5 succeeded (${(100 * ok.length / 5).toFixed(0)}%); average trigger→dashboard ${avg.toFixed(1)} s; Gemini calls ${ctx.gateway.callCount}`;
    if (ok.length < 5) throw new StageFailure(detail, 'intermittent Wi-Fi/SSH or analysis failures; see the per-capture lines');
    return detail;
  });
}

async function cleanup() {
  const ids = [...new Set(state.captureIds)];
  let boardMsg = 'no board files to delete';
  if (ids.length) {
    const files = ids.map((id) => `scrap-camera/captures/${id}.zip`).join(' ');
    await board(`rm -f ${files}`);
    const left = (await board(`ls ${files} 2>/dev/null | wc -l`)).stdout.toString().trim();
    boardMsg = `${ids.length} capture bundle(s) deleted from the board (${left} left)`;
  }
  const removed = await cleanR2Prefix(state.prefix);
  const leftR2 = (await listR2(state.prefix)).length;
  const dbErr = state.dbPublished ? deleteThrowaway(state.db) : null;
  const summary = `${boardMsg}; ${removed} R2 objects under ${state.prefix} deleted (${leftR2} left); database ${state.dbPublished ? (dbErr ? `NOT deleted: ${dbErr}` : `${state.db} deleted`) : 'never created'}; local photos kept in images/camera-test/${state.run}/`;
  if (leftR2 > 0 || dbErr) throw new StageFailure(summary, 'cleanup incomplete');
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(state, null, 2));
  // A new run starts fresh.
  writeFileSync(STATE_FILE, JSON.stringify({ ...state, finished: true }, null, 2));
  return summary;
}

const RUNNERS = { reachable, login, camera, tools, capture: captureStage, transfer, plate, empty, reliability, cleanup };

if (state.finished) {
  // The previous run was cleaned up; start a new one.
  const fresh = { ...loadState(), finished: undefined };
  Object.assign(state, { ...fresh, run: new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase() });
  state.db = `scrap-test-camera-${state.run}`;
  state.prefix = `test/camera-${state.run}/`;
  state.dbPublished = false;
  state.captureIds = [];
  state.results = {};
  delete state.finished;
  delete state.lastCapture;
}

const plan = stageArg === 'auto' ? STAGES.slice(0, 6) : [stageArg];
let failedAt = null;
for (const name of plan) {
  const n = STAGES.indexOf(name) + 1;
  process.stdout.write(`Stage ${n} ${name}: `);
  try {
    const detail = await RUNNERS[name]();
    console.log(`PASS — ${detail}`);
    state.results[name] = { ...(state.results[name] ?? {}), pass: true, detail };
  } catch (e) {
    const likely = e instanceof StageFailure ? e.likely : 'unexpected error';
    console.log(`FAIL — ${e.message}\n  likely cause: ${likely}`);
    state.results[name] = { pass: false, error: e.message, likely };
    failedAt = name;
  }
  save();
  if (failedAt) break;
  if (name === 'reachable' && failedAt === null) continue;
}
if (failedAt) {
  console.log(`Stopped at stage ${STAGES.indexOf(failedAt) + 1} (${failedAt}).`);
  process.exit(1);
}
