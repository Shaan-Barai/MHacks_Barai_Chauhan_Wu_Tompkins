/**
 * Uno Q inbox → R2 + SpacetimeDB, counting each dish once (BRIDGE.md).
 *
 *   npm run ingest-inbox -- --service <serviceId>            # one pass, then exit
 *   npm run ingest-inbox -- --service <serviceId> --watch    # keep ingesting new photos
 *   npm run calibrate -- --known-area-cm2 46.21 --reference-label "credit card"   # = ingest-inbox --calibrate
 *
 * Options:
 *   --inbox <dir>   capture folder (default: <repo>/images/arduino-inbox)
 *   --poll <s>      --watch scan interval in seconds (default 2)
 *   --idle <s>      --watch: close the open dish after this long with no new photos (default 10)
 *   --no-dedupe     one dish per manual photo, no Gemini; --auto frames are skipped
 *   --state-dir <d> where .inbox-groups.json / .inbox-ingest.json / .inbox-calibrations.json live (default: capture/)
 *   --token-env <NAME>  environment variable holding the ingest token (default SCRAP_INGEST_TOKEN)
 *
 * Calibration (IT_4 I2; docs/calibration.md):
 *   --calibrate              upload a calibration frame (laptop_capture.py --calibrate) instead of dishes
 *   --known-area-cm2 <n>     the reference object's area (default 46.21 = credit card)
 *   --reference-label <s>    what it is (default "credit card")
 *   --camera-id <id>         default uno-q-c920s-1
 *   --hall <hallId>          default: the --service's hall, else hall-main
 *   --frame <captureId>      which calibration frame (default: the newest)
 *   --depth on|off           also set the hall's Depth Anything V2 toggle
 *   --no-activate            don't make it the hall's active calibration
 *
 * Environment:
 *   SCRAP_API_URL       backend (default http://localhost:8787; https in production). API_URL still works.
 *   SCRAP_INGEST_TOKEN  bearer token for uploads/captures/calibrations. Never printed.
 *
 * Frames are grouped into dishes with POST /api/dish-match (Gemini), then one
 * representative photo per dish is normalized, uploaded, and submitted.
 * Grouping verdicts live in .inbox-groups.json and event IDs in
 * .inbox-ingest.json, so reruns never add dishes. Delete them only together
 * with a fresh database. Calibration frames are never ingested as dishes.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  BackendRequestError,
  CREDIT_CARD_AREA_CM2,
  DEFAULT_CAMERA_ID,
  DEFAULT_REFERENCE_LABEL,
  DishGrouper,
  HttpCalibrationClient,
  HttpDishMatcher,
  HttpIngestionSink,
  HttpUploader,
  InboxBridge,
  ReplayCaptureAdapter,
  activateCalibration,
  calibrateFromFrame,
  defaultTokenFiles,
  describeBackend,
  describeCalibration,
  resolveBackend,
  scanInbox,
} from '../dist/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));

const { values: args } = parseArgs({
  options: {
    service: { type: 'string' },
    inbox: { type: 'string', default: path.join(root, '..', 'images', 'arduino-inbox') },
    watch: { type: 'boolean', default: false },
    poll: { type: 'string', default: '2' },
    idle: { type: 'string', default: '10' },
    'no-dedupe': { type: 'boolean', default: false },
    'state-dir': { type: 'string', default: root },
    'token-env': { type: 'string' },
    calibrate: { type: 'boolean', default: false },
    'known-area-cm2': { type: 'string' },
    'reference-label': { type: 'string' },
    'camera-id': { type: 'string' },
    hall: { type: 'string' },
    frame: { type: 'string' },
    depth: { type: 'string' },
    'no-activate': { type: 'boolean', default: false },
  },
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

let backend;
try {
  backend = resolveBackend(process.env, args['token-env'], defaultTokenFiles(path.join(root, '..')));
} catch (error) {
  fail(error.message);
}
for (const warning of backend.warnings) console.error(`  ! ${warning}`);
const api = backend.apiUrl;
const client = { token: backend.token };

/** Plain-language exit for a refused token (401/403); other errors keep their message. */
function explain(error) {
  if (error instanceof BackendRequestError && error.unauthorized) {
    return `${error.message}\n  Backend: ${describeBackend(backend)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function getJson(route) {
  let res;
  try {
    res = await fetch(`${api}${route}`, { headers: backend.token ? { Authorization: `Bearer ${backend.token}` } : {} });
  } catch {
    fail(`No backend at ${api}. Start it first (cd backend && npm start), or set SCRAP_API_URL.`);
  }
  if (res.status === 401 || res.status === 403) fail(explain(new BackendRequestError(res.status, undefined, `GET ${route}`)));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

if (args.calibrate) {
  await runCalibration();
  process.exit(0);
}

// ------------------------------------------------------------------ dishes ---

if (!args.service) fail('Pass --service <serviceId> (see GET /api/services or the dashboard).');
const pollMs = Number(args.poll) * 1000;
const idleMs = Number(args.idle) * 1000;
if (!(pollMs > 0) || !(idleMs > 0)) fail('--poll and --idle must be positive numbers of seconds.');

const services = (await getJson('/api/services')).body.services ?? [];
const service = services.find((s) => s.serviceId === args.service);
if (!service) fail(`Service ${args.service} does not exist. Upload its menu first.`);

const sink = new HttpIngestionSink(api, client);
const grouper = new DishGrouper({
  matcher: new HttpDishMatcher(api, client),
  stateFile: path.join(args['state-dir'], '.inbox-groups.json'),
  noDedupe: args['no-dedupe'],
});
const adapter = new ReplayCaptureAdapter(new HttpUploader(api, client), sink, {
  stateFile: path.join(args['state-dir'], '.inbox-ingest.json'),
});

const short = (id) => id.slice(0, 8);
let failed = 0;
let unauthorized = false;
const bridge = new InboxBridge({
  inbox: args.inbox,
  hallId: service.hallId,
  serviceId: service.serviceId,
  grouper,
  adapter,
  onEvent(e) {
    switch (e.kind) {
      case 'opened':
        console.log(`  + ${short(e.captureId)} new dish`);
        break;
      case 'unsure':
        console.log(`  ? ${short(e.captureId)} merged into ${short(e.groupId)} (unsure: ${e.reason})`);
        break;
      case 'skipped':
        console.log(`  - ${short(e.captureId)} skipped: ${e.why}`);
        break;
      case 'closed':
        console.log(`  ■ dish ${short(e.group.groupId)} closed (${e.group.closedBy}, ${e.group.members.length} frames)`);
        break;
      case 'issue':
        console.log(`  ✗ ${e.issue.captureId}: ${e.issue.error.code} — ${e.issue.error.message}`);
        break;
      case 'calibration_frame':
        console.log(`  ◇ ${short(e.captureId)} is a calibration frame, not a dish (upload it with npm run calibrate)`);
        break;
      case 'focus_warning':
        console.log(`  ! ${short(e.captureId)}: ${e.message}`);
        break;
      case 'paused':
        console.log(`  ⏸ paused at ${short(e.captureId)}: ${e.error.code ?? ''} ${e.error.message}`);
        break;
      case 'ingested': {
        const { group, result } = e;
        if (!result.ok) {
          failed++;
          const auth = /\((401|403)\)/.test(result.error.message);
          if (auth && !unauthorized) {
            unauthorized = true;
            console.log(
              `  ✗ the backend refused the upload (${result.error.message.match(/\((40[13])\)/)?.[1]}). ` +
                `Set ${backend.tokenEnv} to the backend's ingest token. Backend: ${describeBackend(backend)}`,
            );
          }
          console.log(`  ✗ dish ${short(group.groupId)}: ${result.error.code} — ${result.error.message}`);
          break;
        }
        const outcome = sink.outcomes.get(result.event.eventId);
        const state = result.alreadyIngested ? 'already ingested' : outcome?.deduplicated ? 'deduplicated' : outcome?.state;
        console.log(`  ✓ dish ${short(group.groupId)} (${group.members.length} frames) → ${result.event.eventId} (${state})`);
        break;
      }
      // 'joined' / 'no_plate' are per-frame noise at 1 fps.
    }
  },
});

console.log(`Inbox ${args.inbox} → ${service.serviceId} at ${describeBackend(backend)}`);
if (args['no-dedupe']) console.log('  ! --no-dedupe: every manual photo is a separate dish; --auto frames are skipped.');

if (!args.watch) {
  let paused = false;
  try {
    ({ paused } = await bridge.pass());
    if (!paused) await bridge.close('flush');
  } catch (error) {
    fail(`  ✗ ${explain(error)}`);
  }
  console.log(`Done. Gemini checks this run: ${grouper.matchCalls}.`);
  process.exit(paused || failed > 0 ? 1 : 0);
}

let stopping = false;
process.on('SIGINT', async () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log('\nStopping: closing the open dish…');
  await bridge.close('flush');
  console.log(`Gemini checks this run: ${grouper.matchCalls}.`);
  process.exit(failed > 0 ? 1 : 0);
});

let lastNewFrame = Date.now();
let idleClosed = true;
let delay = pollMs;
for (;;) {
  if (stopping) break;
  const { newFrames, paused } = await bridge.pass();
  if (newFrames > 0) {
    lastNewFrame = Date.now();
    idleClosed = false;
  }
  if (!paused && !idleClosed && Date.now() - lastNewFrame >= idleMs) {
    await bridge.close('idle');
    idleClosed = true;
  }
  // Back off while dish comparison is unavailable; nothing is skipped meanwhile.
  delay = paused ? Math.min(delay * 2, 30_000) : pollMs;
  await new Promise((r) => setTimeout(r, delay));
}

// ------------------------------------------------------------- calibration ---

async function runCalibration() {
  if (args.watch || args['no-dedupe']) fail('--calibrate uploads one frame; it does not combine with --watch/--no-dedupe.');
  const knownAreaCm2 = args['known-area-cm2'] === undefined ? CREDIT_CARD_AREA_CM2 : Number(args['known-area-cm2']);
  const referenceLabel = args['reference-label'] ?? DEFAULT_REFERENCE_LABEL;
  const cameraId = args['camera-id'] ?? DEFAULT_CAMERA_ID;
  if (args.depth !== undefined && !['on', 'off'].includes(args.depth)) fail('--depth must be on or off.');
  const depthEnabled = args.depth === undefined ? undefined : args.depth === 'on';

  let hallId = args.hall;
  if (!hallId && args.service) {
    const services = (await getJson('/api/services')).body.services ?? [];
    hallId = services.find((s) => s.serviceId === args.service)?.hallId;
    if (!hallId) fail(`Service ${args.service} does not exist.`);
  }
  hallId ??= 'hall-main';

  let scan;
  try {
    scan = await scanInbox(args.inbox);
  } catch {
    fail(`No inbox at ${args.inbox}. Take a calibration frame first: python3 capture/uno-q/laptop_capture.py --target arduino@BOARD --calibrate`);
  }
  const frame = args.frame
    ? scan.calibrations.find((f) => f.captureId === args.frame)
    : scan.calibrations[scan.calibrations.length - 1];
  if (!frame) {
    const other = args.frame && scan.frames.some((f) => f.captureId === args.frame);
    fail(
      other
        ? `${args.frame} is a dish frame, not a calibration frame. Take one with laptop_capture.py --calibrate.`
        : `No calibration frame${args.frame ? ` ${args.frame}` : ''} in ${args.inbox}. ` +
            'Take one with: python3 capture/uno-q/laptop_capture.py --target arduino@BOARD --calibrate ' +
            '(or npm run simulate-camera -- --calibrate).',
    );
  }

  console.log(`Calibration frame ${frame.captureId} (${frame.simulated ? 'SIMULATED fixture' : 'camera'}) → ${describeBackend(backend)}`);
  console.log(`  reference: "${referenceLabel}", ${knownAreaCm2} cm² (user-entered), camera ${cameraId}, hall ${hallId}`);
  if (frame.focus) {
    const f = frame.focus;
    console.log(`  focus: ${f.lock === 'locked' ? `locked (${f.control}=0, focus_absolute=${f.absolute})` : `NOT locked (${f.lock})`}`);
    if (f.lock !== 'locked') console.log('  ! autofocus changes the focal length; lock focus for calibration and every capture.');
  } else if (!frame.simulated) {
    console.log('  ! focus unknown: the board script predates the focus lock (copy the new uno_q_camera.py).');
  }
  if (frame.widthPx && frame.heightPx) console.log(`  frame: ${frame.widthPx}×${frame.heightPx}, normalized to 1024×1024 like every dish`);

  const calibrationApi = new HttpCalibrationClient(api, client);
  let result;
  try {
    result = await calibrateFromFrame({
      imagePath: frame.photoPath,
      frameId: frame.captureId,
      hallId,
      cameraId,
      knownAreaCm2,
      referenceLabel,
      uploader: new HttpUploader(api, client),
      api: calibrationApi,
      stateFile: path.join(args['state-dir'], '.inbox-calibrations.json'),
    });
  } catch (error) {
    if (error instanceof BackendRequestError && error.status === 404 && error.apiError?.code === 'ROUTE_NOT_FOUND') {
      fail('  ✗ This backend has no /api/calibrations endpoint yet (IT_4 workstream B).');
    }
    fail(`  ✗ ${explain(error)}`);
  }
  const c = result.calibration;
  console.log(`  ${result.reused ? '↺ already calibrated with this photo' : '✓ uploaded'} (image ${result.imageObjectId}, association calibration)`);
  for (const line of describeCalibration(c)) console.log(`  ${line}`);
  if (c.status !== 'succeeded') fail('  ✗ Calibration did not succeed. Check the photo: the whole reference object visible, flat, not on a plate.');

  if (!args['no-activate']) {
    try {
      const settings = await activateCalibration(calibrationApi, hallId, c.calibrationId, depthEnabled);
      console.log(
        `  ✓ active calibration for ${hallId}; Depth Anything V2 ${settings.depthEnabled ? 'ON (volume method)' : 'OFF (area method)'}`,
      );
    } catch (error) {
      fail(`  ✗ Could not activate it: ${explain(error)}`);
    }
  } else {
    console.log('  (not activated: --no-activate)');
  }
  console.log('Keep the camera, its height, focus and resolution unchanged; recalibrate after any change.');
}
