/**
 * Camera simulator: put photos into the Uno Q inbox exactly like
 * laptop_capture.py does for a manual capture, so the whole camera path runs
 * without the board (BRIDGE.md, capture/README.md).
 *
 *   npm run simulate-camera                                   # every test2/*.jpeg → images/arduino-inbox
 *   npm run simulate-camera -- --count 3 --interval 2
 *   npm run simulate-camera -- --inbox /tmp/inbox --photos path/to/dir-or-file.jpg
 *   npm run simulate-camera -- --count 3 --service svc_hall-main_2026-10-03_dinner
 *
 * Options:
 *   --inbox <dir>     inbox to write into (default: <repo>/images/arduino-inbox)
 *   --photos <path>   a JPEG file or a folder of .jpg/.jpeg files (default: <repo>/test2)
 *   --count <n>       write the first n photos (default: all). Each photo is a new dish
 *   --interval <s>    seconds between photos (default 0)
 *   --service <id>    after writing, run one ingest-inbox pass for this service
 *                     (with --no-dedupe unless --dedupe is given)
 *   --dedupe          with --service: group frames with Gemini instead of --no-dedupe
 *   --state-dir <d>   with --service: passed to ingest-inbox (default: capture/)
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

const { values: args } = parseArgs({
  options: {
    inbox: { type: 'string', default: path.join(repo, 'images', 'arduino-inbox') },
    photos: { type: 'string', default: path.join(repo, 'test2') },
    count: { type: 'string' },
    interval: { type: 'string', default: '0' },
    service: { type: 'string' },
    dedupe: { type: 'boolean', default: false },
    'state-dir': { type: 'string' },
  },
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

let photos;
try {
  photos = await listPhotos(args.photos);
} catch {
  fail(`No photos at ${args.photos}.`);
}
if (photos.length === 0) fail(`No .jpg/.jpeg photos in ${args.photos}.`);
if (args.count !== undefined) {
  const count = Number(args.count);
  if (!Number.isInteger(count) || count < 1) fail('--count must be a positive whole number.');
  if (count > photos.length) fail(`--count ${count} asks for more photos than the ${photos.length} available.`);
  photos = photos.slice(0, count);
}
const interval = Number(args.interval);
if (!(interval >= 0) || interval > 60) fail('--interval must be 0 to 60 seconds.');
if ((args.dedupe || args['state-dir']) && !args.service) fail('--dedupe and --state-dir need --service.');

console.log(`Simulated camera → ${path.resolve(args.inbox)} (${photos.length} photo${photos.length === 1 ? '' : 's'}, manual captures)`);
try {
  await simulateCamera({
    inbox: args.inbox,
    photos,
    intervalMs: interval * 1000,
    onSaved: (c) =>
      console.log(`  saved ${c.captureId} ← ${path.basename(c.sourcePhoto)} (${c.metadata.widthPx} x ${c.metadata.heightPx})`),
  });
} catch (error) {
  fail(`Simulated capture failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (!args.service) {
  console.log('Next: cd capture && npm run ingest-inbox -- --service <serviceId> --no-dedupe' +
    (path.resolve(args.inbox) === path.join(repo, 'images', 'arduino-inbox') ? '' : ` --inbox ${path.resolve(args.inbox)}`));
  process.exit(0);
}

const bridgeArgs = [path.join(root, 'scripts', 'ingest-inbox.mjs'), '--service', args.service, '--inbox', path.resolve(args.inbox)];
if (!args.dedupe) bridgeArgs.push('--no-dedupe');
if (args['state-dir']) bridgeArgs.push('--state-dir', path.resolve(args['state-dir']));
const bridge = spawnSync(process.execPath, bridgeArgs, { stdio: 'inherit', env: process.env });
process.exit(bridge.status ?? 1);
