/**
 * Camera simulator: put photos into the Uno Q inbox exactly like
 * laptop_capture.py does for a manual capture, so the whole camera path runs
 * without the board (BRIDGE.md, capture/README.md).
 *
 *   npm run simulate-camera                                   # every test2/*.jpeg → images/arduino-inbox
 *   npm run simulate-camera -- --count 3 --interval 2
 *   npm run simulate-camera -- --inbox /tmp/inbox --photos path/to/dir-or-file.jpg
 *   npm run simulate-camera -- --count 3 --service svc_hall-main_2026-10-03_dinner
 *   npm run simulate-camera -- --calibrate                    # fixture calibration frame → POST /api/calibrations
 *
 * Options:
 *   --inbox <dir>     inbox to write into (default: <repo>/images/arduino-inbox)
 *   --photos <path>   a JPEG file or a folder of .jpg/.jpeg files (default: <repo>/test2,
 *                     or the synthetic card fixture with --calibrate)
 *   --count <n>       write the first n photos (default: all). Each photo is a new dish
 *   --interval <s>    seconds between photos (default 0)
 *   --service <id>    after writing, run one ingest-inbox pass for this service
 *                     (with --no-dedupe unless --dedupe is given)
 *   --dedupe          with --service: group frames with Gemini instead of --no-dedupe
 *   --state-dir <d>   passed to ingest-inbox (default: capture/)
 *   --token-env <N>   passed to ingest-inbox (default SCRAP_INGEST_TOKEN)
 *
 * Calibration (--calibrate): writes ONE calibration frame (capturePurpose
 * "calibration", default photo capture/fixtures/calibration/credit-card-synthetic.jpg,
 * a SYNTHETIC fixture) and runs `ingest-inbox --calibrate` for it: upload →
 * POST /api/calibrations → activate. Passed through: --known-area-cm2 (default:
 * the fixture's 46.21), --reference-label, --camera-id, --hall, --no-activate. --write-only stops after writing the frame.
 *
 * The metadata says captureSource "simulated_camera"; the bridge therefore
 * labels these dishes source "replay", never "camera".
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { listPhotos, simulateCamera } from '../dist/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = path.join(root, '..');
const CALIBRATION_FIXTURE = path.join(root, 'fixtures', 'calibration', 'credit-card-synthetic.jpg');

const { values: args } = parseArgs({
  options: {
    inbox: { type: 'string', default: path.join(repo, 'images', 'arduino-inbox') },
    photos: { type: 'string' },
    count: { type: 'string' },
    interval: { type: 'string', default: '0' },
    service: { type: 'string' },
    dedupe: { type: 'boolean', default: false },
    'state-dir': { type: 'string' },
    'token-env': { type: 'string' },
    calibrate: { type: 'boolean', default: false },
    'write-only': { type: 'boolean', default: false },
    'known-area-cm2': { type: 'string' },
    'reference-label': { type: 'string' },
    'camera-id': { type: 'string' },
    hall: { type: 'string' },
    'no-activate': { type: 'boolean', default: false },
  },
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

const calibrate = args.calibrate;
const calibrationOnly = ['known-area-cm2', 'reference-label', 'camera-id', 'hall', 'no-activate', 'write-only'];
if (!calibrate && calibrationOnly.some((k) => args[k] !== undefined && args[k] !== false)) {
  fail(`--${calibrationOnly.find((k) => args[k] !== undefined && args[k] !== false)} needs --calibrate.`);
}
if (calibrate && (args.dedupe || args.count !== undefined || args.interval !== '0')) {
  fail('--calibrate writes one frame; --count/--interval/--dedupe do not apply.');
}

let photos;
try {
  photos = await listPhotos(args.photos ?? (calibrate ? CALIBRATION_FIXTURE : path.join(repo, 'test2')));
} catch {
  fail(`No photos at ${args.photos}.`);
}
if (photos.length === 0) fail(`No .jpg/.jpeg photos in ${args.photos}.`);
if (calibrate) photos = photos.slice(0, 1);
if (args.count !== undefined) {
  const count = Number(args.count);
  if (!Number.isInteger(count) || count < 1) fail('--count must be a positive whole number.');
  if (count > photos.length) fail(`--count ${count} asks for more photos than the ${photos.length} available.`);
  photos = photos.slice(0, count);
}
const interval = Number(args.interval);
if (!(interval >= 0) || interval > 60) fail('--interval must be 0 to 60 seconds.');
if (!calibrate && (args.dedupe || args['state-dir']) && !args.service) fail('--dedupe and --state-dir need --service.');

const kind = calibrate ? 'calibration frame' : 'manual captures';
console.log(`Simulated camera → ${path.resolve(args.inbox)} (${photos.length} photo${photos.length === 1 ? '' : 's'}, ${kind})`);
let saved;
try {
  saved = await simulateCamera({
    inbox: args.inbox,
    photos,
    intervalMs: interval * 1000,
    purpose: calibrate ? 'calibration' : 'dish',
    onSaved: (c) =>
      console.log(`  saved ${c.captureId} ← ${path.basename(c.sourcePhoto)} (${c.metadata.widthPx} x ${c.metadata.heightPx})`),
  });
} catch (error) {
  fail(`Simulated capture failed: ${error instanceof Error ? error.message : String(error)}`);
}

const bridge = (extra) => {
  const bridgeArgs = [path.join(root, 'scripts', 'ingest-inbox.mjs'), '--inbox', path.resolve(args.inbox), ...extra];
  if (args['state-dir']) bridgeArgs.push('--state-dir', path.resolve(args['state-dir']));
  if (args['token-env']) bridgeArgs.push('--token-env', args['token-env']);
  const run = spawnSync(process.execPath, bridgeArgs, { stdio: 'inherit', env: process.env });
  process.exit(run.status ?? 1);
};

if (calibrate) {
  if (photos[0] === CALIBRATION_FIXTURE) console.log('  (SYNTHETIC fixture: a drawn credit card, see docs/fixture-provenance.md)');
  if (args['write-only']) {
    console.log(`Next: cd capture && npm run calibrate -- --frame ${saved[0].captureId} --known-area-cm2 46.21`);
    process.exit(0);
  }
  const extra = ['--calibrate', '--frame', saved[0].captureId];
  for (const key of ['known-area-cm2', 'reference-label', 'camera-id', 'hall']) {
    if (args[key] !== undefined) extra.push(`--${key}`, args[key]);
  }
  if (args.service) extra.push('--service', args.service);
  if (args['no-activate']) extra.push('--no-activate');
  bridge(extra);
}

if (!args.service) {
  console.log('Next: cd capture && npm run ingest-inbox -- --service <serviceId> --no-dedupe' +
    (path.resolve(args.inbox) === path.join(repo, 'images', 'arduino-inbox') ? '' : ` --inbox ${path.resolve(args.inbox)}`));
  process.exit(0);
}

bridge(['--service', args.service, ...(args.dedupe ? [] : ['--no-dedupe'])]);
