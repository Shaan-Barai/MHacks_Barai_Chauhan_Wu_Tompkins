/**
 * Uno Q inbox → R2 + SpacetimeDB, counting each dish once (BRIDGE.md).
 *
 *   npm run ingest-inbox -- --service <serviceId>            # one pass, then exit
 *   npm run ingest-inbox -- --service <serviceId> --watch    # keep ingesting new photos
 *
 * Options:
 *   --inbox <dir>   capture folder (default: <repo>/images/arduino-inbox)
 *   --poll <s>      --watch scan interval in seconds (default 2)
 *   --idle <s>      --watch: close the open dish after this long with no new photos (default 10)
 *   --no-dedupe     one dish per manual photo, no Gemini; --auto frames are skipped
 *   --state-dir <d> where .inbox-groups.json / .inbox-ingest.json live (default: capture/);
 *                   use a fresh folder for an isolated demo or E2E run
 *   API_URL=...     backend (default http://localhost:8787)
 *
 * Frames are grouped into dishes with POST /api/dish-match (Gemini), then one
 * representative photo per dish is normalized, uploaded, and submitted.
 * Grouping verdicts live in .inbox-groups.json and event IDs in
 * .inbox-ingest.json, so reruns never add dishes. Delete them only together
 * with a fresh database.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  DishGrouper,
  HttpDishMatcher,
  HttpIngestionSink,
  HttpUploader,
  InboxBridge,
  ReplayCaptureAdapter,
} from '../dist/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const api = (process.env.API_URL ?? 'http://localhost:8787').replace(/\/$/, '');

const { values: args } = parseArgs({
  options: {
    service: { type: 'string' },
    inbox: { type: 'string', default: path.join(root, '..', 'images', 'arduino-inbox') },
    watch: { type: 'boolean', default: false },
    poll: { type: 'string', default: '2' },
    idle: { type: 'string', default: '10' },
    'no-dedupe': { type: 'boolean', default: false },
    'state-dir': { type: 'string', default: root },
  },
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!args.service) fail('Pass --service <serviceId> (see GET /api/services or the dashboard).');
const pollMs = Number(args.poll) * 1000;
const idleMs = Number(args.idle) * 1000;
if (!(pollMs > 0) || !(idleMs > 0)) fail('--poll and --idle must be positive numbers of seconds.');

let services;
try {
  const res = await fetch(`${api}/api/services`);
  services = (await res.json()).services ?? [];
} catch {
  fail(`No backend at ${api}. Start it first (cd backend && npm start).`);
}
const service = services.find((s) => s.serviceId === args.service);
if (!service) fail(`Service ${args.service} does not exist. Upload its menu first.`);

const sink = new HttpIngestionSink(api);
const grouper = new DishGrouper({
  matcher: new HttpDishMatcher(api),
  stateFile: path.join(args['state-dir'], '.inbox-groups.json'),
  noDedupe: args['no-dedupe'],
});
const adapter = new ReplayCaptureAdapter(new HttpUploader(api), sink, {
  stateFile: path.join(args['state-dir'], '.inbox-ingest.json'),
});

const short = (id) => id.slice(0, 8);
let failed = 0;
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
      case 'paused':
        console.log(`  ⏸ paused at ${short(e.captureId)}: ${e.error.code ?? ''} ${e.error.message}`);
        break;
      case 'ingested': {
        const { group, result } = e;
        if (!result.ok) {
          failed++;
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

console.log(`Inbox ${args.inbox} → ${service.serviceId} at ${api}`);
if (args['no-dedupe']) console.log('  ! --no-dedupe: every manual photo is a separate dish; --auto frames are skipped.');

if (!args.watch) {
  const { paused } = await bridge.pass();
  if (!paused) await bridge.close('flush');
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
