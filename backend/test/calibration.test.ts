/**
 * IT_4 calibration + measurement settings + physical snapshot on ingestion,
 * with a fake calibration runner and the mock analyzer (area method).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, HALL, GEOMETRY } from './helpers.js';
import { MockAnalyzer } from '../src/analysis/mockAnalyzer.js';
import type { CalibrationRunner, CalibrationRunOutput } from '../src/analysis/calibrationRunner.js';
import type { Analyzer, AnalyzerInput } from '../src/analysis/analyzer.js';
import type { CameraIntrinsics } from '../src/types.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function intrinsics(w: number, h: number): CameraIntrinsics {
  return { cameraModel: 'logitech-c920s', widthPx: w, heightPx: h, fxPx: 725, fyPx: 725, cxPx: w / 2, cyPx: h / 2, source: 'nominal-fov' };
}

class FakeRunner implements CalibrationRunner {
  calls = 0;
  constructor(private readonly out: Partial<CalibrationRunOutput> = {}, private readonly size = { w: 1024, h: 1024 }) {}
  async run(): Promise<CalibrationRunOutput> {
    this.calls++;
    return {
      status: 'succeeded',
      widthPx: this.size.w,
      heightPx: this.size.h,
      referencePixels: 9242,
      cm2PerPx: 0.005,
      intrinsics: intrinsics(this.size.w, this.size.h),
      cameraHeightCmGeometric: 51.3,
      depth: {
        checkpoint: 'depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf',
        settingsVersion: 'dav2-metric-small-v1',
        rawReferenceMedianM: 0.6,
        scale: 0.855,
        cameraHeightCmDepth: 51.3,
        tablePlane: { a: 0, b: 0, c: 51.3 },
        depthPng: PNG,
      },
      flags: [],
      overlayJpeg: JPEG,
      referenceMaskPng: PNG,
      ...this.out,
    };
  }
}

async function uploadCalibrationPhoto(s: Awaited<ReturnType<typeof startTestServer>>, calibrationId: string) {
  const req = await s.api('POST', '/api/images/uploads', {
    associationKind: 'calibration',
    associationId: calibrationId,
    mimeType: 'image/png',
    sizeBytes: 64,
    widthPx: 1024,
    heightPx: 1024,
  });
  assert.equal(req.status, 201, JSON.stringify(req.json));
  assert.match(req.json.objectKey, /^calibrations\//);
  const put = await fetch(`${s.baseUrl}${req.json.uploadUrl}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.from('calibration-photo-bytes') });
  assert.equal(put.status, 204);
  assert.equal((await s.api('POST', `/api/images/${req.json.objectId}/finalize`)).status, 200);
  return req.json.objectId as string;
}

const body = (imageObjectId: string) => ({ hallId: HALL, cameraId: 'uno-q-c920s-1', imageObjectId, knownAreaCm2: 46.21, referenceLabel: 'credit card' });

test('POST /api/calibrations stores the calibration, its images, and is idempotent', async (t) => {
  const runner = new FakeRunner();
  const s = await startTestServer(undefined, { calibrationRunner: runner });
  t.after(() => s.close());

  const img = await uploadCalibrationPhoto(s, 'cal_a');
  const first = await s.api('POST', '/api/calibrations', body(img));
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const cal = first.json;
  assert.equal(cal.calibrationId, 'cal_a');
  assert.equal(cal.status, 'succeeded');
  assert.equal(cal.referencePixels, 9242);
  assert.equal(cal.cm2PerPx, 46.21 / 9242, 'k is recomputed from the stored inputs');
  assert.equal(cal.depth.scale, 0.855);
  assert.ok(cal.depth.depthObjectId && cal.overlayObjectId && cal.referenceMaskObjectId);

  const again = await s.api('POST', '/api/calibrations', body(img));
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, cal);
  assert.equal(runner.calls, 1, 'a retry never re-runs Gemini/SAM');

  const list = await s.api('GET', `/api/calibrations?hallId=${HALL}`);
  assert.deepEqual(list.json.calibrations.map((c: any) => c.calibrationId), ['cal_a']);
  assert.equal((await s.api('GET', '/api/calibrations/cal_a')).json.calibrationId, 'cal_a');
  assert.equal((await s.api('GET', '/api/calibrations/nope')).status, 404);

  const images = await s.api('GET', '/api/calibrations/cal_a/images');
  assert.equal(images.status, 200);
  for (const k of ['photo', 'overlay', 'referenceMask', 'depth']) {
    assert.ok(images.json[k]?.url, `${k} has a signed URL`);
    assert.ok(images.json[k]?.expiresAt);
  }
  const depthObj = await s.repo.getImageObject(cal.depth.depthObjectId);
  assert.deepEqual(depthObj?.association, { kind: 'depth', id: 'cal_a' });
  const overlayObj = await s.repo.getImageObject(cal.overlayObjectId);
  assert.deepEqual(overlayObj?.association, { kind: 'calibration_overlay', id: 'cal_a' });
});

test('calibration validation, failures, and an unavailable runner', async (t) => {
  const s = await startTestServer(undefined, { calibrationRunner: new FakeRunner({ status: 'failed', referencePixels: 0, cm2PerPx: 0, depth: null, flags: ['reference_not_found'] }) });
  t.after(() => s.close());

  const captureImg = await s.uploadImage('cap_x');
  const wrongKind = await s.api('POST', '/api/calibrations', body(captureImg));
  assert.equal(wrongKind.status, 400);
  assert.equal(wrongKind.json.error.code, 'IMAGE_ASSOCIATION_MISMATCH');
  const img = await uploadCalibrationPhoto(s, 'cal_bad');
  for (const bad of [{ knownAreaCm2: 0 }, { knownAreaCm2: -3 }, { knownAreaCm2: 'x' }, { referenceLabel: '' }, { hallId: undefined }]) {
    const r = await s.api('POST', '/api/calibrations', { ...body(img), ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }

  const failed = await s.api('POST', '/api/calibrations', body(img));
  assert.equal(failed.status, 201);
  assert.equal(failed.json.status, 'failed');
  assert.equal(failed.json.error.code, 'REFERENCE_NOT_FOUND');
  assert.deepEqual(failed.json.flags, ['reference_not_found']);
  assert.equal(failed.json.depth, null);

  // A failed calibration can never be activated.
  const activate = await s.api('PUT', '/api/settings/measurement', { hallId: HALL, activeCalibrationId: 'cal_bad' });
  assert.equal(activate.status, 400);
  assert.equal(activate.json.error.code, 'INVALID_CALIBRATION');

  const noRunner = await startTestServer();
  t.after(() => noRunner.close());
  const img2 = await uploadCalibrationPhoto(noRunner, 'cal_none');
  const r = await noRunner.api('POST', '/api/calibrations', body(img2));
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'CALIBRATION_UNAVAILABLE');
  assert.equal(r.json.error.retryable, true);
});

test('measurement settings: defaults, partial updates, validation', async (t) => {
  const s = await startTestServer(undefined, { calibrationRunner: new FakeRunner() });
  t.after(() => s.close());
  const def = await s.api('GET', `/api/settings/measurement?hallId=${HALL}`);
  assert.equal(def.status, 200);
  assert.deepEqual(
    { ...def.json, updatedAt: undefined },
    { hallId: HALL, depthEnabled: false, activeCalibrationId: null, plateThicknessCm: 1.5, updatedAt: undefined },
  );
  assert.equal((await s.api('GET', '/api/settings/measurement')).status, 400);

  const img = await uploadCalibrationPhoto(s, 'cal_ok');
  await s.api('POST', '/api/calibrations', body(img));
  const put = await s.api('PUT', '/api/settings/measurement', { hallId: HALL, activeCalibrationId: 'cal_ok', depthEnabled: true });
  assert.equal(put.status, 200);
  assert.equal(put.json.activeCalibrationId, 'cal_ok');
  assert.equal(put.json.depthEnabled, true);
  assert.equal(put.json.plateThicknessCm, 1.5);
  const thick = await s.api('PUT', '/api/settings/measurement', { hallId: HALL, plateThicknessCm: 2 });
  assert.equal(thick.json.activeCalibrationId, 'cal_ok', 'omitted fields are kept');
  assert.equal(thick.json.plateThicknessCm, 2);
  for (const bad of [{ plateThicknessCm: -1 }, { plateThicknessCm: 50 }, { depthEnabled: 'yes' }, { activeCalibrationId: 'nope' }, { activeCalibrationId: 7 }]) {
    assert.equal((await s.api('PUT', '/api/settings/measurement', { hallId: HALL, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await s.api('PUT', '/api/settings/measurement', { hallId: 'hall-other', activeCalibrationId: 'cal_ok' })).status, 400, 'another hall');
  const off = await s.api('PUT', '/api/settings/measurement', { hallId: HALL, activeCalibrationId: null });
  assert.equal(off.json.activeCalibrationId, null);
});

test('ingestion snapshots the active calibration; activating another one never rewrites history', async (t) => {
  const s = await startTestServer(undefined, { calibrationRunner: new FakeRunner() });
  t.after(() => s.close());
  await s.seedMenuAndBaselines();

  // No calibration: pixels only, no physical, no snapshot.
  const plain = await s.submitCapture('cap_plain', await s.uploadImage('cap_plain'));
  assert.equal(plain.status, 201);
  assert.equal(plain.json.measurements[0].physical, undefined);
  assert.equal(plain.json.attempt.calibrationId, undefined);

  await s.api('POST', '/api/calibrations', body(await uploadCalibrationPhoto(s, 'cal_1')));
  await s.api('PUT', '/api/settings/measurement', { hallId: HALL, activeCalibrationId: 'cal_1' });
  const k1 = 46.21 / 9242;
  const cap = await s.submitCapture('cap_cal', await s.uploadImage('cap_cal'));
  assert.equal(cap.status, 201);
  const m = cap.json.measurements[0];
  assert.equal(m.remainingAreaPx, 12000, 'pixels unchanged');
  assert.equal(m.physical.method, 'area-calibrated-v1');
  assert.equal(m.physical.calibrationId, 'cal_1');
  assert.ok(Math.abs(m.physical.areaCm2 - 12000 * k1) < 1e-3);
  assert.equal(m.physical.volumeCm3, null);
  assert.equal(cap.json.attempt.calibrationId, 'cal_1');
  assert.equal(cap.json.attempt.physicalMethod, 'area-calibrated-v1');

  // A second calibration becomes active; the earlier capture keeps cal_1.
  await s.api('POST', '/api/calibrations', body(await uploadCalibrationPhoto(s, 'cal_2')));
  await s.api('PUT', '/api/settings/measurement', { hallId: HALL, activeCalibrationId: 'cal_2' });
  // Payloads: coverage counts the calibrated plate; the gallery shows its area.
  const dash = await s.api('GET', `/api/dashboard/impact?start=2026-10-03&end=2026-10-03&hallId=${HALL}`);
  assert.equal(dash.status, 200);
  assert.deepEqual(dash.json.totals.physicalCoverage, { calibratedCaptures: 1, volumeCaptures: 0, analyzedCaptures: 2 });
  const gallery = await s.api('GET', `/api/captures?start=2026-10-03&end=2026-10-03&hallId=${HALL}`);
  const row = gallery.json.find((c: any) => c.eventId === 'cap_cal');
  assert.equal(row.calibrationId, 'cal_1');
  assert.equal(row.physicalMethod, 'area-calibrated-v1');
  assert.ok(Math.abs(row.items[0].areaCm2 - 12000 * k1) < 1e-3);
  assert.equal(row.items[0].volumeCm3, null);
  const plainRow = gallery.json.find((c: any) => c.eventId === 'cap_plain');
  assert.equal(plainRow.items[0].areaCm2, null);
  assert.equal(plainRow.items[0].grams, null);

  const stored = await s.api('GET', '/api/captures/cap_cal');
  assert.equal(stored.json.measurements[0].physical.calibrationId, 'cal_1');
  assert.equal(stored.json.attempts.at(-1).calibrationId, 'cal_1');
});

test('a calibration for another resolution gives no physical numbers but is snapshotted', async (t) => {
  const s = await startTestServer(undefined, { calibrationRunner: new FakeRunner({}, { w: 1920, h: 1080 }) });
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  await s.api('POST', '/api/calibrations', body(await uploadCalibrationPhoto(s, 'cal_hd')));
  await s.api('PUT', '/api/settings/measurement', { hallId: HALL, activeCalibrationId: 'cal_hd' });
  const cap = await s.submitCapture('cap_sq', await s.uploadImage('cap_sq'));
  assert.equal(cap.status, 201);
  assert.equal(cap.json.measurements[0].remainingAreaPx, 12000);
  assert.equal(cap.json.measurements[0].physical, undefined);
  assert.equal(cap.json.attempt.calibrationId, 'cal_hd', 'snapshot: incompatible_geometry is derivable');
  assert.equal(cap.json.attempt.physicalMethod, undefined);
});

test('volume results store the depth map in object storage', async (t) => {
  const mock = new MockAnalyzer();
  let seen: AnalyzerInput | undefined;
  const volumeAnalyzer: Analyzer = {
    async analyze(input) {
      seen = input;
      const r = await mock.analyze(input);
      const cal = input.physical!.calibration!;
      r.measurements[0]!.physical = {
        calibrationId: cal.calibrationId,
        method: 'volume-dav2-v1',
        areaCm2: 60,
        volumeCm3: 50,
        meanHeightMm: 8,
        maxHeightMm: 20,
        depthSettingsVersion: 'dav2-metric-small-v1',
        plateReference: 'dish-ring-fit',
        flags: [],
      };
      r.attempt.physicalMethod = 'volume-dav2-v1';
      r.physical = { status: 'applied', depth: { png: PNG, widthPx: 1024, heightPx: 1024 } };
      return r;
    },
  };
  const s = await startTestServer(volumeAnalyzer, { calibrationRunner: new FakeRunner() });
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  await s.api('POST', '/api/calibrations', body(await uploadCalibrationPhoto(s, 'cal_v')));
  await s.api('PUT', '/api/settings/measurement', { hallId: HALL, activeCalibrationId: 'cal_v', depthEnabled: true, plateThicknessCm: 2 });

  const cap = await s.submitCapture('cap_vol', await s.uploadImage('cap_vol'));
  assert.equal(cap.status, 201, JSON.stringify(cap.json));
  assert.equal(seen?.physical?.depthEnabled, true);
  assert.equal(seen?.physical?.plateThicknessCm, 2);
  assert.ok(seen?.physical?.depthClient, 'the depth worker client is passed through');
  assert.equal(cap.json.attempt.physicalMethod, 'volume-dav2-v1');
  assert.equal(cap.json.measurements[0].physical.volumeCm3, 50);
  const depthId = cap.json.attempt.depthObjectId;
  assert.ok(depthId);
  assert.deepEqual((await s.repo.getImageObject(depthId))?.association, { kind: 'depth', id: 'cap_vol' });
  assert.equal(GEOMETRY.widthPx, 1024);
});

test('overlay legend suffix: grams · kg CO2e · L water from analytics, nothing without an estimate', async () => {
  const { physicalLabelSuffix } = await import('../src/wiring.js');
  const menu = {
    service: { serviceId: 's', hallId: HALL, hallTimezone: 'America/Detroit', serviceDate: '2026-10-04', mealLabel: 'dinner' as const, menuId: 'm', menuVersion: 1 },
    items: [{ itemId: 'ham', menuId: 'm', displayName: 'Baked Boneless Ham' }],
  };
  const suffix = physicalLabelSuffix(menu)!;
  const physical = { calibrationId: 'c', method: 'area-calibrated-v1' as const, areaCm2: 20, volumeCm3: null, meanHeightMm: null, maxHeightMm: null, flags: [] };
  const bucket = (over: object) => ({ itemId: 'ham', label: 'Baked Boneless Ham', pixels: 1, bitmap: new Uint8Array(1), color: [0, 0, 0], physical, ...over }) as any;
  assert.match(String(suffix(bucket({}))), /^[\d,]+ g · .*CO2e · .*L water \(est\.\)$/);
  assert.equal(suffix(bucket({ physical: null })), null, 'no estimate: nothing, never "0 g"');
  assert.equal(suffix(bucket({ itemId: null })), null, 'unknown food has no grams');
});
