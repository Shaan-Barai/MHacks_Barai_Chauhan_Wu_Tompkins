/**
 * simulate-camera writes an inbox the bridge accepts exactly like a real
 * laptop_capture.py inbox (BRIDGE.md "Run it without the board").
 * Fixture-only: generated JPEGs, an in-memory uploader/sink, and a fake
 * matcher that plays Gemini. No network.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ReplayCaptureAdapter } from '../src/adapter.js';
import type { DishMatchRequest, DishMatchResult } from '../src/contract-types.js';
import { DishGrouper } from '../src/dishGrouper.js';
import { thumbnail } from '../src/frames.js';
import type { DishMatcher } from '../src/http.js';
import { scanInbox } from '../src/inbox.js';
import { InboxBridge } from '../src/inboxBridge.js';
import { InMemoryIngestionSink } from '../src/ingestion.js';
import { InMemoryUploader } from '../src/uploader.js';
import { listPhotos, simulateCamera } from '../src/simulateCamera.js';
import { HALL, SERVICE, makeFile, makeFixtureDir, makeJpeg } from './helpers.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Field set of a manual capture: uno_q_camera.py capture_image(). */
const MANUAL_FIELDS = [
  'protocolVersion', 'captureId', 'capturedAt', 'timestampBasis', 'captureSource', 'device',
  'mimeType', 'widthPx', 'heightPx', 'requestedWidthPx', 'requestedHeightPx', 'normalized',
  'byteLength', 'sha256',
];
const COLORS: Array<[number, number, number]> = [
  [200, 60, 40],
  [40, 90, 200],
  [60, 170, 70],
];

async function photos(dir: string, n = 3): Promise<string[]> {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await makeJpeg(dir, `dish-${i}.jpeg`, 640, 480, COLORS[i % COLORS.length]));
  return out;
}

/** Plays Gemini: every simulated photo is a distinct dish. */
class DistinctPhotosMatcher implements DishMatcher {
  calls = 0;
  readonly labels = new Map<string, string>();
  async learn(file: string): Promise<void> {
    this.labels.set((await thumbnail(await readFile(file))).base64, file);
  }
  async match({ reference, candidate }: DishMatchRequest): Promise<DishMatchResult> {
    this.calls++;
    const ref = this.labels.get(reference.base64);
    const cand = this.labels.get(candidate.base64);
    assert.ok(ref && cand, 'fake matcher only knows fixture photos');
    const meta = { reason: 'fixture', model: 'fake', promptVersion: 'dish-match-v1' };
    return { plateVisible: true, sameDish: ref === cand ? 'same' : 'different', ...meta };
  }
}

function bridgeFor(inbox: string, stateDir: string, noDedupe: boolean, matcher: DishMatcher) {
  const uploader = new InMemoryUploader();
  const sink = new InMemoryIngestionSink();
  const grouper = new DishGrouper({ matcher, stateFile: path.join(stateDir, 'groups.json'), noDedupe });
  const adapter = new ReplayCaptureAdapter(uploader, sink, { stateFile: path.join(stateDir, 'ingest.json') });
  const bridge = new InboxBridge({ inbox, hallId: HALL, serviceId: SERVICE, grouper, adapter });
  return { uploader, sink, grouper, bridge };
}

test('simulate-camera writes the laptop_capture.py layout: <uuid>/{photo.jpg,metadata.json}, no temp dirs left', async () => {
  const dir = await makeFixtureDir();
  const inbox = path.join(dir, 'inbox');
  const sources = await photos(dir);
  const saved = await simulateCamera({ inbox, photos: sources });

  assert.equal(saved.length, 3);
  assert.deepEqual((await readdir(inbox)).sort(), saved.map((s) => s.captureId).sort(), 'no .receive-* leftovers');
  let previous = '';
  for (const [i, capture] of saved.entries()) {
    assert.match(capture.captureId, UUID_V4);
    assert.deepEqual((await readdir(capture.dir)).sort(), ['metadata.json', 'photo.jpg']);
    const photo = await readFile(path.join(capture.dir, 'photo.jpg'));
    assert.deepEqual(photo, await readFile(sources[i]!), 'photo bytes are copied unchanged');
    const text = await readFile(path.join(capture.dir, 'metadata.json'), 'utf8');
    const metadata = JSON.parse(text);
    assert.equal(text, `${JSON.stringify(metadata, null, 2)}\n`, 'same JSON formatting as save_capture()');
    assert.deepEqual(Object.keys(metadata), MANUAL_FIELDS);
    assert.equal(metadata.protocolVersion, 1);
    assert.equal(metadata.captureId, capture.captureId);
    assert.equal(metadata.captureSource, 'simulated_camera');
    assert.equal(metadata.mimeType, 'image/jpeg');
    assert.equal(metadata.normalized, false);
    assert.equal(metadata.triggerSource, undefined, 'manual capture: no triggerSource');
    assert.deepEqual([metadata.widthPx, metadata.heightPx], [640, 480]);
    assert.equal(metadata.byteLength, photo.byteLength);
    assert.equal(metadata.sha256, createHash('sha256').update(photo).digest('hex'));
    assert.match(metadata.capturedAt, /Z$/);
    assert.ok(metadata.capturedAt > previous, 'capture times strictly increase in write order');
    previous = metadata.capturedAt;
  }
});

test('the bridge inbox reader accepts every simulated capture, in write order, as manual simulated frames', async () => {
  const dir = await makeFixtureDir();
  const inbox = path.join(dir, 'inbox');
  const saved = await simulateCamera({ inbox, photos: await photos(dir), clock: () => new Date('2026-10-03T23:00:00Z') });
  const scan = await scanInbox(inbox);
  assert.deepEqual(scan.issues, []);
  assert.deepEqual(scan.frames.map((f) => f.captureId), saved.map((s) => s.captureId));
  assert.ok(scan.frames.every((f) => f.trigger === 'manual' && f.simulated));
  assert.deepEqual(scan.frames.map((f) => f.capturedAt), [
    '2026-10-03T23:00:00.000Z',
    '2026-10-03T23:00:00.001Z',
    '2026-10-03T23:00:00.002Z',
  ]);
});

test('bridge with dedupe: N distinct simulated photos → N dishes, labeled replay, normalized 1024²', async () => {
  const dir = await makeFixtureDir();
  const inbox = path.join(dir, 'inbox');
  const sources = await photos(dir);
  const matcher = new DistinctPhotosMatcher();
  for (const file of sources) await matcher.learn(file);
  await simulateCamera({ inbox, photos: sources });

  const s = bridgeFor(inbox, dir, false, matcher);
  const { paused } = await s.bridge.pass();
  assert.equal(paused, false);
  await s.bridge.close('flush');
  const events = s.sink.events();
  assert.equal(events.length, 3);
  assert.equal(matcher.calls, 3, 'one plate check, then one comparison per new photo');
  for (const event of events) {
    assert.equal(event.source, 'replay', 'simulated photos never pass as camera captures');
    assert.equal(event.hallId, HALL);
    assert.equal(event.serviceId, SERVICE);
    assert.deepEqual(
      [event.geometry.widthPx, event.geometry.heightPx, event.geometry.coordinateSpace],
      [1024, 1024, 'topdown-normalized-v1'],
    );
  }
  assert.equal(new Set(events.map((e) => e.eventId)).size, 3);

  // A rerun with the same state adds nothing.
  const again = bridgeFor(inbox, dir, false, matcher);
  await again.bridge.pass();
  await again.bridge.close('flush');
  assert.equal(again.sink.events().length, 0);
  assert.equal(matcher.calls, 3);
});

test('bridge with --no-dedupe: one dish per simulated photo and zero Gemini checks', async () => {
  const dir = await makeFixtureDir();
  const inbox = path.join(dir, 'inbox');
  const matcher = new DistinctPhotosMatcher();
  await simulateCamera({ inbox, photos: await photos(dir) });
  const s = bridgeFor(inbox, dir, true, matcher);
  await s.bridge.pass();
  await s.bridge.close('flush');
  assert.equal(s.sink.events().length, 3);
  assert.equal(s.uploader.finalizedOfKind('capture').length, 3);
  assert.equal(s.uploader.finalizedOfKind('original').length, 3);
  assert.equal(matcher.calls, 0);
});

test('a real Uno Q frame (no captureSource) is still ingested as camera', async () => {
  const dir = await makeFixtureDir();
  const inbox = path.join(dir, 'inbox');
  const [saved] = await simulateCamera({ inbox, photos: (await photos(dir)).slice(0, 1) });
  const metaPath = path.join(saved!.dir, 'metadata.json');
  const metadata = JSON.parse(await readFile(metaPath, 'utf8'));
  metadata.captureSource = 'uno_q_usb_camera';
  await makeFile(saved!.dir, 'metadata.json', JSON.stringify(metadata));
  const s = bridgeFor(inbox, dir, true, new DistinctPhotosMatcher());
  await s.bridge.pass();
  await s.bridge.close('flush');
  assert.equal(s.sink.events()[0]!.source, 'camera');
});

test('simulate-camera refuses photos the camera could not have sent', async () => {
  const dir = await makeFixtureDir();
  const inbox = path.join(dir, 'inbox');
  const good = await readFile(await makeJpeg(dir, 'good.jpg'));
  const truncated = await makeFile(dir, 'truncated.jpg', good.subarray(0, good.byteLength - 10));
  await assert.rejects(simulateCamera({ inbox, photos: [truncated] }), /not a complete JPEG/);
  const png = await makeFile(dir, 'fake.jpg', 'not a jpeg');
  await assert.rejects(simulateCamera({ inbox, photos: [png] }), /not a complete JPEG/);
  assert.deepEqual(await readdir(inbox), [], 'nothing written for rejected photos');
});

test('listPhotos takes .jpg/.jpeg from a folder, sorted, or a single file', async () => {
  const dir = await makeFixtureDir();
  await makeJpeg(dir, 'b.jpeg');
  await makeJpeg(dir, 'a.JPG');
  await makeFile(dir, 'notes.txt', 'x');
  await makeFile(dir, '.hidden.jpg', 'x');
  assert.deepEqual((await listPhotos(dir)).map((f) => path.basename(f)), ['a.JPG', 'b.jpeg']);
  assert.deepEqual(await listPhotos(path.join(dir, 'b.jpeg')), [path.join(dir, 'b.jpeg')]);
});

// Cross-check against the real laptop code: laptop_capture.py validate_bundle()
// accepts the simulator's photo + metadata, and save_capture() writes the
// same metadata.json bytes.
const laptopCapture = fileURLToPath(new URL('../../uno-q/laptop_capture.py', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;
test('laptop_capture.py validate_bundle() accepts simulated captures byte-for-byte', { skip: !python || !existsSync(laptopCapture) }, async () => {
  const dir = await makeFixtureDir();
  const inbox = path.join(dir, 'inbox');
  const [saved] = await simulateCamera({ inbox, photos: (await photos(dir)).slice(0, 1) });
  const script = `
import io, json, sys, zipfile, pathlib, tempfile
sys.path.insert(0, ${JSON.stringify(path.dirname(laptopCapture))})
import laptop_capture as lc
src = pathlib.Path(sys.argv[1])
photo = (src / "photo.jpg").read_bytes()
meta_text = (src / "metadata.json").read_text()
meta = json.loads(meta_text)
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as z:
    z.writestr("photo.jpg", photo)
    z.writestr("metadata.json", json.dumps(meta) + "\\n")
p, m = lc.validate_bundle(buf.getvalue(), meta["captureId"])
out = pathlib.Path(tempfile.mkdtemp())
dest = lc.save_capture(out, p, m)
assert (dest / "metadata.json").read_text() == meta_text, "metadata.json differs from save_capture()"
assert (dest / "photo.jpg").read_bytes() == photo
print("ok")
`;
  const run = spawnSync('python3', ['-c', script, saved!.dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'ok');
});
