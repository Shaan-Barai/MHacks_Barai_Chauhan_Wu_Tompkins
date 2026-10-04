/**
 * Calibration client (IT_4 I2): one calibration frame → normalized like a
 * dish → upload (association `calibration`) → POST /api/calibrations →
 * activate. Calibration frames never become dishes. Fixture-only: in-memory
 * uploader and a fake calibration API; no network, no Gemini.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { ReplayCaptureAdapter } from '../src/adapter.js';
import {
  CREDIT_CARD_AREA_CM2,
  activateCalibration,
  calibrateFromFrame,
  describeCalibration,
  validateCalibrationInput,
} from '../src/calibration.js';
import type { CameraCalibration, MeasurementSettings } from '../src/contract-types.js';
import { DishGrouper } from '../src/dishGrouper.js';
import type { CalibrationApi, CalibrationRequest } from '../src/http.js';
import { scanInbox } from '../src/inbox.js';
import { type BridgeEvent, InboxBridge } from '../src/inboxBridge.js';
import { InMemoryIngestionSink } from '../src/ingestion.js';
import { simulateCamera } from '../src/simulateCamera.js';
import { InMemoryUploader, type UploadRequest } from '../src/uploader.js';
import { HALL, SERVICE, makeFixtureDir, makeJpeg } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// dist/test → capture/fixtures
const FIXTURE = path.resolve(HERE, '..', '..', 'fixtures', 'calibration', 'credit-card-synthetic.jpg');
const SIDECAR = FIXTURE.replace(/\.jpg$/, '.json');

function succeeded(req: CalibrationRequest, id: string): CameraCalibration {
  const referencePixels = 37_875;
  const k = req.knownAreaCm2 / referencePixels;
  return {
    calibrationId: id,
    hallId: req.hallId,
    cameraId: req.cameraId,
    createdAt: '2026-10-04T12:00:00Z',
    status: 'succeeded',
    method: 'reference-area-v1',
    imageObjectId: req.imageObjectId,
    widthPx: 1024,
    heightPx: 1024,
    knownAreaCm2: req.knownAreaCm2,
    referenceLabel: req.referenceLabel,
    referencePixels,
    cm2PerPx: k,
    intrinsics: { cameraModel: 'logitech-c920s', widthPx: 1024, heightPx: 1024, fxPx: 1289.7, fyPx: 1289.7, cxPx: 512, cyPx: 512, source: 'nominal-fov' },
    cameraHeightCmGeometric: 1289.7 * Math.sqrt(k),
    depth: null,
    flags: [],
  };
}

class FakeCalibrationApi implements CalibrationApi {
  created: CalibrationRequest[] = [];
  gets = 0;
  /** Status sequence returned by createCalibration/getCalibration for the next calibration. */
  script: Array<CameraCalibration['status']> = ['succeeded'];
  private readonly store = new Map<string, CameraCalibration>();
  private readonly pending = new Map<string, Array<CameraCalibration['status']>>();
  settings = new Map<string, MeasurementSettings>();

  async createCalibration(req: CalibrationRequest): Promise<CameraCalibration> {
    this.created.push(req);
    const id = `cal_${this.created.length}`;
    const [first, ...rest] = this.script;
    this.pending.set(id, rest);
    const c = { ...succeeded(req, id), status: first! };
    if (first === 'failed') c.error = { code: 'REFERENCE_NOT_FOUND', message: 'No card found.', retryable: false };
    this.store.set(id, c);
    return c;
  }

  async getCalibration(id: string): Promise<CameraCalibration> {
    this.gets++;
    const c = this.store.get(id)!;
    const next = this.pending.get(id)?.shift();
    if (next) this.store.set(id, { ...c, status: next });
    return this.store.get(id)!;
  }

  async getSettings(hallId: string): Promise<MeasurementSettings | null> {
    return this.settings.get(hallId) ?? null;
  }

  async putSettings(s: Partial<MeasurementSettings> & { hallId: string }): Promise<MeasurementSettings> {
    const merged = { depthEnabled: false, activeCalibrationId: null, plateThicknessCm: 1.5, updatedAt: 'now', ...this.settings.get(s.hallId), ...s };
    this.settings.set(s.hallId, merged);
    return merged;
  }
}

class RecordingUploader extends InMemoryUploader {
  requests: UploadRequest[] = [];
  bytes: Uint8Array[] = [];
  override async authorizeUpload(request: UploadRequest) {
    this.requests.push(request);
    return super.authorizeUpload(request);
  }
  override async uploadBytes(auth: { uploadId: string }, bytes: Uint8Array) {
    this.bytes.push(bytes);
    return super.uploadBytes(auth, bytes);
  }
}

async function frame() {
  const dir = await makeFixtureDir();
  const photo = await makeJpeg(dir, 'card.jpg', 1920, 1080, [40, 30, 30]);
  return { dir, photo };
}

const base = { hallId: HALL, cameraId: 'uno-q-c920s-1', knownAreaCm2: CREDIT_CARD_AREA_CM2, referenceLabel: 'credit card' };

test('calibrateFromFrame normalizes like a dish, uploads as calibration, then POSTs', async () => {
  const { dir, photo } = await frame();
  const uploader = new RecordingUploader();
  const api = new FakeCalibrationApi();
  const result = await calibrateFromFrame({ ...base, imagePath: photo, frameId: 'frame-1', uploader, api, stateFile: path.join(dir, 's.json') });

  assert.equal(uploader.requests.length, 1);
  assert.deepEqual(uploader.requests[0]!.association, { kind: 'calibration', id: 'frame-1' });
  assert.equal(uploader.requests[0]!.widthPx, 1024);
  assert.equal(uploader.requests[0]!.heightPx, 1024);
  const meta = await sharp(Buffer.from(uploader.bytes[0]!)).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [1024, 1024, 'jpeg']);
  assert.deepEqual([result.sourceWidthPx, result.sourceHeightPx], [1920, 1080]);

  assert.deepEqual(api.created, [{ ...base, imageObjectId: result.imageObjectId }]);
  assert.equal(result.calibration.status, 'succeeded');
  assert.equal(result.reused, false);
});

test('rerun reuses the calibration; a new known area makes a new one without re-uploading', async () => {
  const { dir, photo } = await frame();
  const uploader = new RecordingUploader();
  const api = new FakeCalibrationApi();
  const stateFile = path.join(dir, 's.json');
  const first = await calibrateFromFrame({ ...base, imagePath: photo, frameId: 'f', uploader, api, stateFile });
  const again = await calibrateFromFrame({ ...base, imagePath: photo, frameId: 'f', uploader, api, stateFile });
  assert.equal(again.reused, true);
  assert.equal(again.calibration.calibrationId, first.calibration.calibrationId);
  assert.equal(api.created.length, 1);

  const fixed = await calibrateFromFrame({ ...base, knownAreaCm2: 50, imagePath: photo, frameId: 'f', uploader, api, stateFile });
  assert.equal(api.created.length, 2);
  assert.notEqual(fixed.calibration.calibrationId, first.calibration.calibrationId);
  assert.equal(uploader.requests.length, 1, 'the same photo is uploaded once');
  assert.ok(existsSync(stateFile));
});

test('processing is polled until terminal; a failed calibration is retried on rerun', async () => {
  const { dir, photo } = await frame();
  const api = new FakeCalibrationApi();
  api.script = ['processing', 'processing', 'succeeded'];
  const sleeps: number[] = [];
  const result = await calibrateFromFrame({
    ...base, imagePath: photo, frameId: 'p', uploader: new InMemoryUploader(), api,
    pollIntervalMs: 5, sleep: async (ms) => void sleeps.push(ms),
  });
  assert.equal(result.calibration.status, 'succeeded');
  assert.equal(sleeps.length, 2);

  const stateFile = path.join(dir, 'f.json');
  api.script = ['failed'];
  const failed = await calibrateFromFrame({ ...base, imagePath: photo, frameId: 'x', uploader: new InMemoryUploader(), api, stateFile });
  assert.equal(failed.calibration.status, 'failed');
  assert.match(describeCalibration(failed.calibration).join('\n'), /REFERENCE_NOT_FOUND/);
  api.script = ['succeeded'];
  const retried = await calibrateFromFrame({ ...base, imagePath: photo, frameId: 'x', uploader: new InMemoryUploader(), api, stateFile });
  assert.equal(retried.calibration.status, 'succeeded');
  assert.equal(retried.reused, false);
});

test('input validation is plain-language', () => {
  assert.throws(() => validateCalibrationInput({ ...base, knownAreaCm2: 0 }), /above 0/);
  assert.throws(() => validateCalibrationInput({ ...base, knownAreaCm2: Number.NaN }), /known-area-cm2/);
  assert.throws(() => validateCalibrationInput({ ...base, referenceLabel: ' ' }), /reference-label/);
  assert.throws(() => validateCalibrationInput({ ...base, cameraId: 'a b' }), /camera-id/);
  assert.doesNotThrow(() => validateCalibrationInput(base));
});

test('activateCalibration keeps the depth toggle unless told otherwise', async () => {
  const api = new FakeCalibrationApi();
  let s = await activateCalibration(api, HALL, 'cal_a');
  assert.deepEqual([s.activeCalibrationId, s.depthEnabled], ['cal_a', false]);
  s = await activateCalibration(api, HALL, 'cal_a', true);
  assert.equal(s.depthEnabled, true);
  s = await activateCalibration(api, HALL, 'cal_b');
  assert.deepEqual([s.activeCalibrationId, s.depthEnabled], ['cal_b', true]);
});

test('describeCalibration shows k, both heights and flags', () => {
  const c = succeeded({ ...base, imageObjectId: 'img' }, 'cal_9');
  let text = describeCalibration(c).join('\n');
  assert.match(text, /k = 0\.00122\d cm² per pixel/);
  assert.match(text, /geometric \(f·√k\): 45\.0 cm/);
  assert.match(text, /Depth Anything V2: not measured/);
  assert.match(text, /flags: none/);
  c.depth = {
    checkpoint: 'depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf', settingsVersion: 'dav2-metric-small-v1',
    rawReferenceMedianM: 0.4, scale: 1.125, cameraHeightCmDepth: 45, tablePlane: { a: 0, b: 0, c: 45 }, depthObjectId: 'img_d',
  };
  c.flags = ['depth_scale_disagrees'];
  text = describeCalibration(c).join('\n');
  assert.match(text, /Depth Anything V2: 45\.0 cm\s+\(scale 1\.125/);
  assert.match(text, /flags: depth_scale_disagrees/);
});

test('calibration frames are listed apart and never ingested as dishes', async () => {
  const dir = await makeFixtureDir();
  const inbox = path.join(dir, 'inbox');
  const dish = await makeJpeg(dir, 'dish.jpg', 400, 300);
  const [cal] = await simulateCamera({ inbox, photos: [dish], purpose: 'calibration' });
  await simulateCamera({ inbox, photos: [dish] });
  const scan = await scanInbox(inbox);
  assert.equal(scan.calibrations.length, 1);
  assert.equal(scan.calibrations[0]!.captureId, cal!.captureId);
  assert.equal(scan.calibrations[0]!.purpose, 'calibration');
  assert.equal(scan.frames.length, 1);
  assert.equal(scan.frames[0]!.purpose, 'dish');

  const sink = new InMemoryIngestionSink();
  const events: BridgeEvent[] = [];
  const bridge = new InboxBridge({
    inbox, hallId: HALL, serviceId: SERVICE,
    grouper: new DishGrouper({ matcher: { match: async () => assert.fail('no Gemini with --no-dedupe') }, stateFile: path.join(dir, 'g.json'), noDedupe: true }),
    adapter: new ReplayCaptureAdapter(new InMemoryUploader(), sink, { stateFile: path.join(dir, 'i.json') }),
    onEvent: (e) => events.push(e),
  });
  await bridge.pass();
  await bridge.close('flush');
  await bridge.pass();
  assert.equal(sink.events().length, 1, 'only the dish is a capture event');
  assert.equal(events.filter((e) => e.kind === 'calibration_frame').length, 1, 'reported once');
});

test('the bridge warns once when a camera frame is not focus-locked like the calibration', async () => {
  const dir = await makeFixtureDir();
  const inbox = path.join(dir, 'inbox');
  const dish = await makeJpeg(dir, 'dish.jpg', 400, 300);
  const [cal] = await simulateCamera({ inbox, photos: [dish], purpose: 'calibration' });
  const [a, b] = await simulateCamera({ inbox, photos: [dish, dish] });
  const { readFile, writeFile } = await import('node:fs/promises');
  // Pretend these came from the board (focus metadata, not simulated).
  const edit = async (id: string, focus: object) => {
    const file = path.join(inbox, id, 'metadata.json');
    const meta = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...meta, captureSource: 'uno_q_usb_camera', focus }));
  };
  await edit(cal!.captureId, { lock: 'locked', control: 'focus_automatic_continuous', absolute: 0 });
  await edit(a!.captureId, { lock: 'locked', control: 'focus_automatic_continuous', absolute: 30 });
  await edit(b!.captureId, { lock: 'failed', control: null, absolute: null });
  const events: BridgeEvent[] = [];
  const bridge = new InboxBridge({
    inbox, hallId: HALL, serviceId: SERVICE,
    grouper: new DishGrouper({ matcher: { match: async () => assert.fail('no Gemini') }, stateFile: path.join(dir, 'g.json'), noDedupe: true }),
    adapter: new ReplayCaptureAdapter(new InMemoryUploader(), new InMemoryIngestionSink(), { stateFile: path.join(dir, 'i.json') }),
    onEvent: (e) => events.push(e),
  });
  await bridge.pass();
  const warnings = events.filter((e) => e.kind === 'focus_warning');
  assert.equal(warnings.length, 1);
  assert.match((warnings[0] as { message: string }).message, /differs from the calibration frame \(0\)/);
});

test('the committed synthetic calibration fixture matches its sidecar', async () => {
  const sidecar = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  assert.equal(sidecar.synthetic, true);
  const meta = await sharp(FIXTURE).metadata();
  assert.deepEqual([meta.width, meta.height], [sidecar.frame.widthPx, sidecar.frame.heightPx]);
  assert.equal(sidecar.reference.knownAreaCm2, CREDIT_CARD_AREA_CM2);
  // The drawn card lies inside the centre square that normalization keeps, away from its edges.
  const { left, top, width, height } = sidecar.reference.drawnPx;
  const crop = sidecar.normalized.cropLeftPx;
  assert.ok(left > crop + 20 && left + width < crop + 1080 - 20 && top > 20 && top + height < 1080 - 20);
  // Pixels inside the card are the light card colour, outside the dark table.
  const { data, info } = await sharp(FIXTURE).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    return data[i]! + data[i + 1]! + data[i + 2]!;
  };
  assert.ok(at(left + Math.round(width * 0.8), top + Math.round(height * 0.45)) > 300, 'card is light');
  assert.ok(at(left - 30, top + 30) < 300, 'table is dark');
  const expected = sidecar.normalized.expectedCameraHeightCmGeometric;
  assert.ok(Math.abs(expected - 45) < 0.5, `designed for 45 cm, got ${expected}`);
});
