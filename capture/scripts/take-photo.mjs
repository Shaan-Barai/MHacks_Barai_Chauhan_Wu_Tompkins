/**
 * Take one photo with the Uno Q camera and send it through the full pipeline:
 *
 *   SSH trigger (key only) → photo + SHA-256 back to this computer
 *   → ingestPhoto: raw original + normalized image to R2, scan row in SpacetimeDB
 *   → backend analysis (Gemini + SAM) → overlay in R2, results in SpacetimeDB
 *
 *   cd capture && npm run take-photo                       # meal from the computer's clock
 *   cd capture && npm run take-photo -- --service <id>     # explicit meal service
 *   cd capture && npm run take-photo -- --json             # one JSON line (used by the dashboard button)
 *
 * Settings come from the repo .env: CAMERA_HOST, CAMERA_USER, CAMERA_SSH_KEY
 * (see .env.example), MEAL_WINDOWS, HALL_ID, API_URL. The scan time is this
 * computer's clock at the trigger, never the board's.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = path.join(root, '..');
const envFile = path.join(repo, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const {
  HttpIngestionSink,
  HttpUploader,
  ReplayCaptureAdapter,
  loadCameraConfig,
  parseMealWindows,
  resolveServiceAt,
  takePhoto,
} = await import('../dist/src/index.js');

const { values: args } = parseArgs({
  options: {
    service: { type: 'string' },
    hall: { type: 'string', default: process.env.HALL_ID || 'hall-main' },
    out: { type: 'string', default: path.join(repo, 'images', 'take-photo') },
    json: { type: 'boolean', default: false },
  },
});
const api = (process.env.API_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const say = (line) => {
  if (!args.json) console.log(line);
};

function finish(result, code) {
  if (args.json) console.log(JSON.stringify(result));
  else if (!result.ok) console.error(`${result.stage ? `[${result.stage}] ` : ''}${result.error}`);
  process.exit(code);
}

try {
  const config = loadCameraConfig();

  // 1. Which meal this scan belongs to.
  let services;
  try {
    services = (await (await fetch(`${api}/api/services?hallId=${encodeURIComponent(args.hall)}`)).json()).services ?? [];
  } catch {
    finish({ ok: false, stage: 'backend', error: `No backend at ${api}. Start it first (cd backend && npm start).` }, 1);
  }
  let service;
  if (args.service) {
    service = services.find((s) => s.serviceId === args.service);
    if (!service) finish({ ok: false, stage: 'service', error: `Service ${args.service} does not exist. Upload its menu first.` }, 1);
  } else {
    const resolved = resolveServiceAt(services, new Date(), { hallId: args.hall, windows: parseMealWindows(process.env.MEAL_WINDOWS || undefined) });
    if (!resolved.ok) finish({ ok: false, stage: 'service', error: resolved.reason }, 1);
    service = resolved.service;
  }

  // 2. Trigger the camera and bring the photo over (SHA-256 checked).
  say(`Taking a photo on ${config.user}@${config.host} for ${service.serviceId} …`);
  const photo = await takePhoto({
    config,
    outDir: args.out,
    laptopCaptureScript: path.join(root, 'uno-q', 'laptop_capture.py'),
  });
  say(`  received ${photo.widthPx}x${photo.heightPx} from ${photo.device} (sha256 ${photo.sha256.slice(0, 12)}…)`);

  // 3–5. The one ingest path: raw + normalized to R2, scan row, analysis.
  const sink = new HttpIngestionSink(api);
  const adapter = new ReplayCaptureAdapter(new HttpUploader(api), sink, {
    stateFile: path.join(root, '.take-photo-state.json'),
  });
  const result = await adapter.ingestPhoto({
    photoPath: photo.photoPath,
    captureKey: photo.captureId,
    capturedAt: photo.triggeredAt,
    timestampBasis: 'laptop_trigger',
    hallId: service.hallId,
    serviceId: service.serviceId,
    source: 'camera',
    deviceId: config.deviceId,
    expectedSha256: photo.sha256,
  });
  if (!result.ok) finish({ ok: false, stage: 'ingest', error: `${result.error.code}: ${result.error.message}`, photo }, 1);
  const outcome = sink.outcomes.get(result.event.eventId);
  const state = result.alreadyIngested ? 'already ingested' : outcome?.state ?? 'submitted';
  say(`  ✓ ${result.event.eventId} (${state}) — open the dashboard Plates gallery to see it`);
  finish(
    {
      ok: true,
      eventId: result.event.eventId,
      serviceId: service.serviceId,
      state,
      triggeredAt: photo.triggeredAt,
      receivedAt: photo.receivedAt,
      device: photo.device,
      widthPx: photo.widthPx,
      heightPx: photo.heightPx,
    },
    state === 'failed' ? 1 : 0,
  );
} catch (error) {
  finish({ ok: false, stage: error?.stage ?? 'camera', error: error instanceof Error ? error.message : String(error) }, 1);
}
