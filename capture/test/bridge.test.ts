/**
 * Uno Q inbox bridge (BRIDGE.md §10): each physical dish is counted once.
 *
 * Frames are synthetic: a gray "belt" with an optional colored square
 * "plate". The fake matcher plays Gemini by looking up which plate each
 * thumbnail shows, so these tests exercise grouping, not the model.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';

import { ReplayCaptureAdapter } from '../src/adapter.js';
import type { DishMatchRequest, DishMatchResult } from '../src/contract-types.js';
import { DishGrouper } from '../src/dishGrouper.js';
import { thumbnail } from '../src/frames.js';
import type { DishMatcher } from '../src/http.js';
import { scanInbox } from '../src/inbox.js';
import { type BridgeEvent, InboxBridge } from '../src/inboxBridge.js';
import { InMemoryIngestionSink } from '../src/ingestion.js';
import { InMemoryUploader } from '../src/uploader.js';
import { HALL, SERVICE, makeFixtureDir } from './helpers.js';

const PLATES = {
  A: [200, 60, 40],
  B: [40, 90, 200],
} as const;
type Plate = keyof typeof PLATES;

interface FrameSpec {
  /** Seconds after the start of the test run. */
  t: number;
  plate?: Plate;
  /** Plate's left edge; moving it changes the frame enough to need Gemini. */
  x?: number;
  trigger?: 'manual' | 'interval';
}

const T0 = Date.parse('2026-10-03T16:00:00Z');

class Inbox {
  readonly labels = new Map<string, Plate | 'empty'>();
  private n = 0;
  constructor(readonly dir: string) {}

  async add(spec: FrameSpec): Promise<string> {
    const captureId = `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
    const composite = spec.plate
      ? [
          {
            input: {
              create: { width: 120, height: 120, channels: 3 as const, background: rgb(PLATES[spec.plate]) },
            },
            left: spec.x ?? 140,
            top: 90,
          },
        ]
      : [];
    const photo = await sharp({ create: { width: 400, height: 300, channels: 3, background: rgb([60, 60, 60]) } })
      .composite(composite)
      .jpeg({ quality: 90 })
      .toBuffer();
    this.labels.set((await thumbnail(photo)).base64, spec.plate ?? 'empty');
    const dir = path.join(this.dir, captureId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'photo.jpg'), photo);
    await writeFile(
      path.join(dir, 'metadata.json'),
      JSON.stringify({
        protocolVersion: 1,
        captureId,
        capturedAt: new Date(T0 + spec.t * 1000).toISOString(),
        mimeType: 'image/jpeg',
        byteLength: photo.byteLength,
        sha256: createHash('sha256').update(photo).digest('hex'),
        ...(spec.trigger === 'interval' ? { triggerSource: 'interval', dishIdentity: 'unresolved' } : {}),
      }),
    );
    return captureId;
  }
}

function rgb([r, g, b]: readonly number[]) {
  return { r: r!, g: g!, b: b! };
}

/** Plays Gemini: plate identity comes from the fixture labels. */
class FakeMatcher implements DishMatcher {
  calls = 0;
  failNext = 0;
  /** Candidate plates answered with 'unsure' instead of 'same'. */
  unsure = new Set<string>();
  constructor(private readonly inbox: Inbox) {}

  async match({ reference, candidate }: DishMatchRequest): Promise<DishMatchResult> {
    this.calls++;
    if (this.failNext > 0) {
      this.failNext--;
      throw Object.assign(new Error('Dish comparison failed (503)'), {
        apiError: { code: 'DISH_MATCH_UNAVAILABLE', message: 'No Gemini key.', retryable: true },
      });
    }
    const ref = this.inbox.labels.get(reference.base64);
    const cand = this.inbox.labels.get(candidate.base64);
    assert.ok(ref && cand, 'fake matcher only knows fixture frames');
    const meta = { reason: 'fixture', model: 'fake', promptVersion: 'dish-match-v1' };
    if (cand === 'empty') return { plateVisible: false, ...meta };
    if (this.unsure.has(cand)) return { plateVisible: true, sameDish: 'unsure', ...meta };
    return { plateVisible: true, sameDish: ref === cand ? 'same' : 'different', ...meta };
  }
}

async function setup(options: { stateDir?: string; noDedupe?: boolean } = {}) {
  const dir = await makeFixtureDir();
  const inbox = new Inbox(path.join(dir, 'inbox'));
  await mkdir(inbox.dir, { recursive: true });
  return { inbox, ...build(inbox, options.stateDir ?? dir, options.noDedupe) };
}

function build(inbox: Inbox, stateDir: string, noDedupe = false, matcher = new FakeMatcher(inbox), serviceId = SERVICE) {
  const uploader = new InMemoryUploader();
  const sink = new InMemoryIngestionSink();
  const grouper = new DishGrouper({ matcher, stateFile: path.join(stateDir, 'groups.json'), noDedupe });
  const adapter = new ReplayCaptureAdapter(uploader, sink, { stateFile: path.join(stateDir, 'ingest.json') });
  const events: BridgeEvent[] = [];
  const bridge = new InboxBridge({
    inbox: inbox.dir,
    hallId: HALL,
    serviceId,
    grouper,
    adapter,
    onEvent: (e) => events.push(e),
  });
  return { matcher, uploader, sink, grouper, bridge, events };
}

async function runAll(bridge: InboxBridge) {
  await bridge.pass();
  await bridge.close('flush');
}

test('a stationary plate over many frames is one dish, with one Gemini check', async () => {
  const s = await setup();
  for (let t = 0; t < 10; t++) await s.inbox.add({ t, plate: 'A', trigger: 'interval' });
  await runAll(s.bridge);
  assert.equal(s.sink.events().length, 1);
  assert.equal(s.uploader.finalizedOfKind('capture').length, 1);
  assert.equal(s.uploader.finalizedOfKind('original').length, 1);
  assert.equal(s.matcher.calls, 1, 'only the first frame needs Gemini (plate check)');
  const [event] = s.sink.events();
  assert.equal(event!.source, 'camera');
  assert.equal(s.grouper.groups()[0]!.members.length, 10);
});

test('a plate sliding along the belt stays one dish; its middle frame is uploaded', async () => {
  const s = await setup();
  const ids = [];
  for (const [t, x] of [[0, 60], [1, 110], [2, 160], [3, 210]] as const) {
    ids.push(await s.inbox.add({ t, plate: 'A', x, trigger: 'interval' }));
  }
  await runAll(s.bridge);
  assert.equal(s.sink.events().length, 1);
  const group = s.grouper.groups()[0]!;
  assert.equal(group.representative, ids[1]);
  // The scan time is this computer's clock when the frame arrived (its inbox
  // folder's mtime), not the board timestamp in metadata.json.
  const received = (await stat(path.join(s.inbox.dir, ids[1]!))).mtime.toISOString();
  assert.equal(s.sink.events()[0]!.capturedAt, received);
  assert.notEqual(received, new Date(T0 + 1000).toISOString());
  const scan = s.sink.scans.get(s.sink.events()[0]!.eventId)!;
  assert.equal(scan.timestampBasis, 'laptop_received');
  assert.equal(scan.deviceId, 'uno-q-c920');
  assert.match(scan.originalSha256!, /^[0-9a-f]{64}$/);
});

test('a short occlusion does not split a dish; a long gap then a new plate is two dishes', async () => {
  const s = await setup();
  await s.inbox.add({ t: 0, plate: 'A', trigger: 'interval' });
  await s.inbox.add({ t: 1, trigger: 'interval' }); // hand / empty belt
  await s.inbox.add({ t: 2, trigger: 'interval' });
  await s.inbox.add({ t: 3, plate: 'A', x: 100, trigger: 'interval' }); // same plate is back
  for (let t = 4; t <= 8; t++) await s.inbox.add({ t, trigger: 'interval' }); // belt empty > 3 s
  await s.inbox.add({ t: 9, plate: 'B', trigger: 'interval' });
  await runAll(s.bridge);
  const groups = s.grouper.groups();
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.closedBy, 'gap');
  assert.equal(groups[0]!.members.length, 2);
  assert.equal(s.sink.events().length, 2);
});

test('back-to-back different plates split on a "different" verdict', async () => {
  const s = await setup();
  await s.inbox.add({ t: 0, plate: 'A' });
  await s.inbox.add({ t: 1, plate: 'B' });
  await runAll(s.bridge);
  assert.deepEqual(
    s.grouper.groups().map((g) => g.closedBy),
    ['different', 'flush'],
  );
  assert.equal(s.sink.events().length, 2);
});

test('an "unsure" verdict merges into the open dish and is reported', async () => {
  const s = await setup();
  await s.inbox.add({ t: 0, plate: 'A' });
  await s.inbox.add({ t: 1, plate: 'B' });
  s.matcher.unsure.add('B');
  await runAll(s.bridge);
  assert.equal(s.sink.events().length, 1);
  assert.equal(s.grouper.groups()[0]!.unsureMerges, 1);
  assert.ok(s.events.some((e) => e.kind === 'unsure'));
});

test('pressing Enter twice on one plate is one dish', async () => {
  const s = await setup();
  await s.inbox.add({ t: 0, plate: 'A' });
  await s.inbox.add({ t: 4, plate: 'A' });
  await runAll(s.bridge);
  assert.equal(s.sink.events().length, 1);
});

test('a plate seen again after a flush is not counted again', async () => {
  const s = await setup();
  await s.inbox.add({ t: 0, plate: 'A' });
  await runAll(s.bridge); // one-shot run ends while the plate is still there
  await s.inbox.add({ t: 1, plate: 'A', x: 90 });
  await runAll(s.bridge);
  assert.equal(s.sink.events().length, 1);
  assert.equal(s.grouper.groups()[0]!.lateMembers, 1);
});

test('a dish-match failure pauses in order; resuming gives the same dishes', async () => {
  const s = await setup();
  await s.inbox.add({ t: 0, plate: 'A' });
  await s.inbox.add({ t: 1, plate: 'B' });
  await s.inbox.add({ t: 2, plate: 'A', x: 60 });
  s.matcher.failNext = 1;
  const first = await s.bridge.pass();
  assert.equal(first.paused, true);
  assert.ok(s.events.some((e) => e.kind === 'paused'));
  assert.equal(s.grouper.processedIds().size, 0, 'nothing after the failed frame is processed');
  assert.equal(s.sink.events().length, 0);
  await runAll(s.bridge);
  assert.equal(s.sink.events().length, 3);
});

test('a rerun with saved state asks Gemini nothing and uploads nothing', async () => {
  const s = await setup();
  const stateDir = path.dirname(s.inbox.dir);
  await s.inbox.add({ t: 0, plate: 'A' });
  await s.inbox.add({ t: 1, plate: 'B' });
  await runAll(s.bridge);
  const eventIds = s.grouper.groups().map((g) => g.eventId);

  const again = build(s.inbox, stateDir);
  await runAll(again.bridge);
  assert.equal(again.matcher.calls, 0);
  assert.equal(again.uploader.finalizedCount(), 0);
  assert.equal(again.sink.submissionCount, 0);
  assert.deepEqual(again.grouper.groups().map((g) => g.eventId), eventIds);
});

test('a failed upload stays pending and retries under the same eventId', async () => {
  const s = await setup();
  await s.inbox.add({ t: 0, plate: 'A' });
  s.uploader.failNextUpload(1);
  await runAll(s.bridge);
  assert.equal(s.grouper.pendingIngestion().length, 1);
  await s.bridge.pass();
  assert.equal(s.grouper.pendingIngestion().length, 0);
  assert.equal(s.sink.events().length, 1);
});

test('--no-dedupe: one dish per manual capture, interval frames skipped', async () => {
  const s = await setup({ noDedupe: true });
  await s.inbox.add({ t: 0, plate: 'A' });
  await s.inbox.add({ t: 1, plate: 'B' });
  await s.inbox.add({ t: 2, plate: 'B', trigger: 'interval' });
  await runAll(s.bridge);
  assert.equal(s.sink.events().length, 2);
  assert.equal(s.matcher.calls, 0);
  assert.ok(s.events.some((e) => e.kind === 'skipped'));
});

test('the inbox reader reports bad captures and ignores in-progress transfers', async () => {
  const s = await setup();
  const good = await s.inbox.add({ t: 0, plate: 'A' });
  const tampered = await s.inbox.add({ t: 1, plate: 'B' });
  await writeFile(path.join(s.inbox.dir, tampered, 'photo.jpg'), Buffer.from('not the camera bytes'));
  await mkdir(path.join(s.inbox.dir, 'half-written'));
  await mkdir(path.join(s.inbox.dir, '.receive-abc123'));
  const scan = await scanInbox(s.inbox.dir);
  assert.deepEqual(scan.frames.map((f) => f.captureId), [good]);
  assert.deepEqual(
    scan.issues.map((i) => i.error.code).sort(),
    ['CHECKSUM_MISMATCH', 'INBOX_INCOMPLETE'],
  );
  // Through the bridge, the tampered frame never reaches grouping.
  await runAll(s.bridge);
  assert.equal(s.sink.events().length, 1);
  assert.equal((await readFile(path.join(s.inbox.dir, tampered, 'photo.jpg'), 'utf8')), 'not the camera bytes');
});

test('D3: one inbox frame is ingested once even when a second bridge run targets another service', async () => {
  const s = await setup();
  await s.inbox.add({ t: 0, plate: 'A' });
  await runAll(s.bridge);
  assert.equal(s.sink.events().length, 1);
  // Second run: different service AND a different state dir, same inbox.
  const other = await makeFixtureDir();
  const b = build(s.inbox, other, false, new FakeMatcher(s.inbox), `${SERVICE}-other`);
  await runAll(b.bridge);
  assert.equal(b.sink.events().length, 0, 'the frame was already ingested for another service');
  assert.equal(b.uploader.finalizedOfKind('capture').length, 0);
});
