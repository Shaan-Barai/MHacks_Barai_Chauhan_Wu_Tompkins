/**
 * IT_4: calibrated area, Depth Anything V2 volume, calibration math, depth
 * PNG codec, worker token headers, legend suffixes. Synthetic depth maps and
 * fakes only (the token tests use a loopback HTTP server, no external network).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { createGeminiGateway } from '../src/gateway.js';
import { analyzeCaptureWithMasks, isLiquidMenuItem, type MaskAnalysisInput, type PhysicalCalibration } from '../src/maskPipeline.js';
import { computeAreaEstimate, computeVolumeEstimates, fitPlaneRobust, type VolumeInput } from '../src/volume.js';
import {
  C920S_NATIVE_FOCAL_PX,
  CREDIT_CARD_AREA_CM2,
  c920sIntrinsics,
  calibrationLegendRows,
  cleanReferenceMask,
  fillHoles,
  intrinsicsOverridesFromEnv,
  runCalibration,
  validateCalibrationText,
} from '../src/calibration.js';
import { createDepthWorkerClient, decodeDepthPng16, decodeDepthResponse, encodeDepthPng16, type DepthEstimator, type DepthMap } from '../src/depthClient.js';
import { createSamWorkerClient, type Segmenter } from '../src/samClient.js';
import { fitLegendText, layoutLegend, legendRows, renderOverlay, type OverlayBucket } from '../src/overlay.js';
import { GatewayError } from '../src/errors.js';

const near = (got: number, want: number, rel: number, msg?: string) =>
  assert.ok(Math.abs(got - want) <= rel * Math.abs(want), `${msg ?? ''} got ${got}, want ${want} ±${rel * 100}%`);

/** Rectangle bitmap [x0, x1) × [y0, y1) on W × H. */
function rect(W: number, H: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const b = new Uint8Array(W * H);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) b[y * W + x] = 1;
  return b;
}

// ---------------------------------------------------------------------------
// volume.ts
// ---------------------------------------------------------------------------

/** Scene: 300×300, f = 960 px, plate flat at 50 cm, a 5×5×2 cm box (top at 48 cm ⇒ 100×100 px). */
function boxScene(over: Partial<VolumeInput> = {}): VolumeInput {
  const W = 300;
  const H = 300;
  const depthM = new Float32Array(W * H).fill(0.5);
  const box = rect(W, H, 100, 100, 200, 200);
  for (let i = 0; i < box.length; i++) if (box[i]) depthM[i] = 0.48;
  return {
    calibrationId: 'cal_1',
    cm2PerPx: 0.0025,
    depthM,
    width: W,
    height: H,
    scale: 1,
    intrinsics: { fxPx: 960, fyPx: 960 },
    buckets: [{ key: 'box', bitmap: box }],
    dishRegion: rect(W, H, 20, 20, 280, 280),
    tablePlane: { a: 0, b: 0, c: 51.5 },
    plateThicknessCm: 1.5,
    depthSettingsVersion: 'dav2-metric-small-v1',
    ...over,
  };
}

test('volume: flat plate at 50 cm + 5×5×2 cm box ⇒ 50 cm³ ±1% (plate plane from the dish ring)', () => {
  const r = computeVolumeEstimates(boxScene());
  const e = r.estimates[0]!.estimate;
  assert.equal(e.method, 'volume-dav2-v1');
  near(e.volumeCm3!, 50, 0.01, 'volume');
  near(e.areaCm2, 25, 0.01, 'area');
  assert.equal(e.meanHeightMm, 20);
  assert.equal(e.maxHeightMm, 20);
  assert.equal(e.plateReference, 'dish-ring-fit');
  assert.equal(e.depthSettingsVersion, 'dav2-metric-small-v1');
  assert.deepEqual(e.flags, []);
  assert.equal(r.plate!.reference, 'dish-ring-fit');
  near(r.plate!.plane.c, 50, 1e-9);
});

test('volume: raw DAv2 depth is corrected by the calibration scale', () => {
  const s = boxScene();
  const raw = Float32Array.from(s.depthM as Float32Array, (v) => v / 1.25); // DAv2 reads 20% short
  const e = computeVolumeEstimates({ ...s, depthM: raw, scale: 1.25 }).estimates[0]!.estimate;
  near(e.volumeCm3!, 50, 0.01);
});

test('volume: tilted plate plane is recovered; box of height 2 cm on the tilt', () => {
  const W = 300;
  const H = 300;
  const f = 960;
  const plane = (x: number, y: number) => 50 + 0.01 * x - 0.005 * y; // cm
  const depthM = new Float32Array(W * H);
  const box = rect(W, H, 100, 100, 200, 200);
  let expected = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const D = plane(x, y) - (box[i] ? 2 : 0);
      depthM[i] = D / 100;
      if (box[i]) {
        const Df = Math.fround(D / 100) * 100;
        expected += 2 * (Df / f) ** 2;
      }
    }
  const r = computeVolumeEstimates({ ...boxScene(), depthM });
  near(r.plate!.plane.a, 0.01, 1e-3);
  near(r.plate!.plane.b, -0.005, 1e-3);
  const e = r.estimates[0]!.estimate;
  near(e.volumeCm3!, expected, 0.001);
  near(e.meanHeightMm!, 20, 0.002);
});

test('volume: food covering the plate ⇒ calibration table plane minus plate thickness, flagged', () => {
  const s = boxScene();
  const W = s.width;
  const cover = rect(W, s.height, 20, 20, 280, 280);
  const depthM = new Float32Array(W * s.height).fill(0.515); // table at 51.5 cm
  for (let i = 0; i < cover.length; i++) if (cover[i]) depthM[i] = 0.48; // food top 2 cm above a 50 cm plate
  const r = computeVolumeEstimates({ ...s, depthM, buckets: [{ key: 'pile', bitmap: cover }] });
  const e = r.estimates[0]!.estimate;
  assert.equal(r.plate!.reference, 'calibration-plane');
  assert.equal(r.plate!.fallbackReason, 'ring_too_small');
  assert.equal(e.plateReference, 'calibration-plane');
  assert.ok(e.flags.includes('plate_plane_from_calibration'));
  near(e.volumeCm3!, 260 * 260 * 2 * 0.0025, 1e-6);
  // No dish region at all ⇒ the same fallback.
  const r2 = computeVolumeEstimates({ ...boxScene(), dishRegion: null });
  assert.equal(r2.plate!.fallbackReason, 'no_dish_region');
  assert.ok(r2.estimates[0]!.estimate.flags.includes('plate_plane_from_calibration'));
});

test('volume: negative heights and outliers are clipped and flagged above 5% of the mask', () => {
  const s = boxScene();
  const depthM = Float32Array.from(s.depthM as Float32Array);
  const W = s.width;
  // Rows 100-119 of the box (20%) read BELOW the plate; rows 120-129 (10%) read 30 cm above it.
  for (let y = 100; y < 120; y++) for (let x = 100; x < 200; x++) depthM[y * W + x] = 0.52;
  for (let y = 120; y < 130; y++) for (let x = 100; x < 200; x++) depthM[y * W + x] = 0.2;
  const e = computeVolumeEstimates({ ...s, depthM }).estimates[0]!.estimate;
  assert.ok(e.flags.includes('negative_heights_clipped'));
  assert.ok(e.flags.includes('height_outliers_clipped'));
  assert.equal(e.maxHeightMm, 120);
  const want = 7000 * 2 * 0.0025 + 1000 * 12 * (20 / 960) ** 2; // valid rows + clamped outlier rows; negatives add 0
  near(e.volumeCm3!, want, 0.001);
  // Below the 5% threshold: no flags.
  const few = Float32Array.from(s.depthM as Float32Array);
  for (let x = 100; x < 200; x++) few[100 * W + x] = 0.52; // 1%
  assert.deepEqual(computeVolumeEstimates({ ...s, depthM: few }).estimates[0]!.estimate.flags, []);
});

test('volume: food that mostly reads below the plate falls back to area (no near-zero volume)', () => {
  const s = boxScene();
  const depthM = Float32Array.from(s.depthM as Float32Array);
  for (let y = 100; y < 160; y++) for (let x = 100; x < 200; x++) depthM[y * s.width + x] = 0.51; // 60% below the plate
  const e = computeVolumeEstimates({ ...s, depthM }).estimates[0]!.estimate;
  assert.equal(e.method, 'area-calibrated-v1');
  assert.deepEqual(e.flags, ['negative_heights_clipped', 'depth_invalid']);
  assert.equal(e.volumeCm3, null);
  assert.equal(e.areaCm2, 25);
});

test('volume: food that reads barely above the plate (mean < 1 mm) falls back to area, never ~0', () => {
  const s = boxScene();
  const depthM = Float32Array.from(s.depthM as Float32Array);
  // 40% of the box below the plate (under the 50% rule), the rest only 0.5 mm above it.
  for (let y = 100; y < 200; y++) for (let x = 100; x < 200; x++) depthM[y * s.width + x] = y < 140 ? 0.501 : 0.49995;
  const e = computeVolumeEstimates({ ...s, depthM }).estimates[0]!.estimate;
  assert.equal(e.method, 'area-calibrated-v1');
  assert.deepEqual(e.flags, ['negative_heights_clipped', 'depth_invalid']);
  assert.equal(e.volumeCm3, null);
  assert.equal(e.areaCm2, 25);
});

test('volume: bowls/liquids use the area method with bowl_volume_unreliable; never zero', () => {
  const s = boxScene();
  const e = computeVolumeEstimates({ ...s, bowl: true }).estimates[0]!.estimate;
  assert.equal(e.method, 'area-calibrated-v1');
  assert.deepEqual(e.flags, ['bowl_volume_unreliable']);
  assert.equal(e.volumeCm3, null);
  assert.equal(e.areaCm2, 10000 * 0.0025);
  const perBucket = computeVolumeEstimates({ ...s, buckets: [{ ...s.buckets[0]!, bowl: true }] }).estimates[0]!.estimate;
  assert.deepEqual(perBucket.flags, ['bowl_volume_unreliable']);
  assert.ok(isLiquidMenuItem({ displayName: '4 Bean Stew' }));
  assert.ok(isLiquidMenuItem({ displayName: 'Daily', category: 'Soup' }));
  assert.ok(!isLiquidMenuItem({ displayName: 'Stewart Salad' }));
});

test('volume: invalid depth falls back to the calibrated area (depth_invalid), never zero', () => {
  const s = boxScene();
  const depthM = Float32Array.from(s.depthM as Float32Array);
  for (let y = 100; y < 115; y++) for (let x = 100; x < 200; x++) depthM[y * s.width + x] = Number.NaN; // 15% of the box
  const e = computeVolumeEstimates({ ...s, depthM }).estimates[0]!.estimate;
  assert.equal(e.method, 'area-calibrated-v1');
  assert.deepEqual(e.flags, ['depth_invalid']);
  assert.equal(e.areaCm2, 25);
  // A few invalid pixels (5%) are extrapolated from the valid ones.
  const ok = Float32Array.from(s.depthM as Float32Array);
  for (let y = 100; y < 105; y++) for (let x = 100; x < 200; x++) ok[y * s.width + x] = 0;
  near(computeVolumeEstimates({ ...s, depthM: ok }).estimates[0]!.estimate.volumeCm3!, 50, 0.01);
  // Wrong-size depth or a bad scale ⇒ the whole capture falls back.
  const bad = computeVolumeEstimates({ ...s, depthM: new Float32Array(10) });
  assert.equal(bad.depthValid, false);
  assert.deepEqual(bad.estimates[0]!.estimate.flags, ['depth_invalid']);
  assert.equal(computeVolumeEstimates({ ...s, scale: Number.NaN }).depthValid, false);
});

test('area method: area = pixels × k', () => {
  assert.deepEqual(computeAreaEstimate(1234, { calibrationId: 'c', cm2PerPx: 0.01 }), {
    calibrationId: 'c',
    method: 'area-calibrated-v1',
    areaCm2: 12.34,
    volumeCm3: null,
    meanHeightMm: null,
    maxHeightMm: null,
    flags: [],
  });
});

test('robust plane fit ignores a raised object covering 30% of the points', () => {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let y = 0; y < 50; y++)
    for (let x = 0; x < 50; x++) {
      xs.push(x);
      ys.push(y);
      zs.push(x < 15 ? 40 : 50 + 0.02 * x);
    }
  const fit = fitPlaneRobust(xs, ys, zs)!;
  near(fit.plane.a, 0.02, 1e-6);
  near(fit.plane.c, 50, 1e-6);
});

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

test('C920s nominal intrinsics: 1360 px at 1920 wide; 1024² center crop; overrides', () => {
  near(C920S_NATIVE_FOCAL_PX, 1360.2, 1e-4);
  const native = c920sIntrinsics(1920, 1080);
  near(native.fxPx, 1360.2, 1e-4);
  assert.equal(native.cxPx, 960);
  assert.equal(native.cyPx, 540);
  assert.equal(native.source, 'nominal-fov');
  near(c920sIntrinsics(1280, 720).fxPx, 1360.2 * (1280 / 1920), 1e-4);
  const square = c920sIntrinsics(1024, 1024); // capture normalization: 1080² center crop → 1024²
  near(square.fxPx, 1360.2 * (1024 / 1080), 1e-4);
  assert.equal(square.fxPx, square.fyPx);
  const measured = c920sIntrinsics(1024, 1024, intrinsicsOverridesFromEnv({ CAMERA_FX_PX: '1300', CAMERA_FY_PX: '1302' }));
  assert.deepEqual([measured.fxPx, measured.fyPx, measured.source], [1300, 1302, 'checkerboard']);
  assert.equal(c920sIntrinsics(640, 480, { fxPx: 500 }).source, 'configured');
  assert.deepEqual(intrinsicsOverridesFromEnv({}), {});
});

test('calibration Gemini answer validation is strict', () => {
  assert.deepEqual(validateCalibrationText('{"found":false,"box_2d":[0,0,0,0],"confidence":"low","fully_visible":false}'), { ok: true, found: false });
  const r = validateCalibrationText('{"found":true,"box_2d":[-3,10,500,1004],"confidence":"weird","fully_visible":true}');
  assert.deepEqual(r, { ok: true, found: true, box2d: [0, 10, 500, 1000], confidence: 'low', fullyVisible: true });
  assert.deepEqual(validateCalibrationText('nope'), { ok: false, reason: 'invalid_json' });
  assert.deepEqual(validateCalibrationText('{"found":"yes"}'), { ok: false, reason: 'found_not_boolean' });
  assert.deepEqual(validateCalibrationText('{"found":true,"box_2d":[1,2]}'), { ok: false, reason: 'bad_box' });
});

const CAL_W = 200;
const CAL_H = 200;

async function solidJpeg(W: number, H: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: W, height: H, channels: 3, background: '#808080' } }).jpeg().toBuffer());
}

function maskPngOf(bitmap: Uint8Array, W: number, H: number): Uint8Array {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) {
    const v = bitmap[i] ? 255 : 0;
    png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

/** SAM fake returning a fixed bitmap for every box. */
function fixedSam(bitmap: Uint8Array, W: number, H: number, score = 0.97): Segmenter & { boxes: number[][][] } {
  const boxes: number[][][] = [];
  let px = 0;
  for (const v of bitmap) px += v;
  return {
    boxes,
    async segment(_img, b) {
      boxes.push(b);
      return {
        model: 'fake-sam',
        checkpoint: 'fake',
        codeRevision: 't',
        device: 'cpu',
        settingsVersion: 'sam2-box-v1',
        widthPx: W,
        heightPx: H,
        results: b.map(() => ({ maskPng: maskPngOf(bitmap, W, H), score, foregroundPx: px })),
      };
    },
  };
}

function fakeDepth(depthM: Float32Array, W: number, H: number): DepthEstimator {
  return {
    async estimate(_img, expected) {
      assert.deepEqual(expected, { widthPx: W, heightPx: H });
      return { model: 'fake-dav2', checkpoint: 'fake/dav2', device: 'cpu', settingsVersion: 'dav2-metric-small-v1', widthPx: W, heightPx: H, depthM, minM: 0, maxM: 1 };
    },
  };
}

const calGemini = (answer: object) => createGeminiGateway({ env: {}, mockTransport: () => JSON.stringify(answer) });
const CARD_BOX = { found: true, box_2d: [600, 300, 850, 600], confidence: 'high', fully_visible: true }; // y 120-170, x 60-120

test('calibration: credit card 46.21 cm² ⇒ k, geometric height f·√k, overlay + mask; holes filled', async () => {
  const card = rect(CAL_W, CAL_H, 62, 125, 112, 165); // 50 × 40 = 2000 px
  card[140 * CAL_W + 80] = 0; // a hole from card printing
  const sam = fixedSam(card, CAL_W, CAL_H);
  const r = await runCalibration({
    imageBytes: await solidJpeg(CAL_W, CAL_H),
    knownAreaCm2: CREDIT_CARD_AREA_CM2,
    referenceLabel: 'credit card',
    gateway: calGemini(CARD_BOX),
    sam,
  });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
  assert.deepEqual(sam.boxes, [[[60, 120, 120, 170]]]);
  const c = r.calibration;
  assert.equal(c.referencePixels, 2000);
  assert.equal(c.cm2PerPx, 46.21 / 2000);
  const f = 1360.2 * (200 / 1080);
  near(c.intrinsics.fxPx, f, 1e-4);
  near(c.cameraHeightCmGeometric, f * Math.sqrt(46.21 / 2000), 1e-4);
  assert.equal(c.depth, null);
  assert.deepEqual(c.flags, []);
  assert.equal(c.method, 'reference-area-v1');
  assert.ok(r.overlay && r.overlay.jpeg.length > 0, r.diagnostics.overlayError);
  const meta = await sharp(Buffer.from(r.overlay.jpeg)).metadata();
  assert.equal(meta.width, CAL_W);
  assert.ok(meta.height! > CAL_H);
  assert.equal(r.depthPng, null);
  assert.match(calibrationLegendRows(c).map((l) => l.text).join('\n'), /k = 0\.02311 cm²\/px[\s\S]*Camera height \(geometric/);
});

test('calibration with depth: scale, depth height, table plane; disagreement and edge flags', async () => {
  const card = rect(CAL_W, CAL_H, 62, 125, 112, 165);
  const zGeo = 1360.2 * (200 / 1080) * Math.sqrt(46.21 / 2000);
  // DAv2 says the table is a tilted plane, 30% farther than geometry says at the card.
  const depthM = new Float32Array(CAL_W * CAL_H);
  for (let y = 0; y < CAL_H; y++) for (let x = 0; x < CAL_W; x++) depthM[y * CAL_W + x] = ((zGeo * 1.3) / 100) * (1 + 0.0005 * (x - 87));
  // A plate-like object near the card (2 cm closer than the table) must not tilt the plane.
  for (let y = 100; y < 190; y++) for (let x = 130; x < 160; x++) depthM[y * CAL_W + x] = depthM[y * CAL_W + x]! - 0.02 * 1.3;
  const r = await runCalibration({
    imageBytes: await solidJpeg(CAL_W, CAL_H),
    knownAreaCm2: CREDIT_CARD_AREA_CM2,
    referenceLabel: 'credit card',
    gateway: calGemini(CARD_BOX),
    sam: fixedSam(card, CAL_W, CAL_H),
    depth: fakeDepth(depthM, CAL_W, CAL_H),
  });
  assert.ok(r.ok);
  const d = r.calibration.depth!;
  near(d.rawReferenceMedianM, (zGeo * 1.3) / 100, 1e-3);
  near(d.scale, 1 / 1.3, 1e-3);
  near(d.cameraHeightCmDepth, zGeo * 1.3, 1e-3);
  near(d.tablePlane.a, zGeo * 0.0005, 0.02);
  assert.ok(Math.abs(d.tablePlane.b) < 1e-3, `b ${d.tablePlane.b}`);
  near(d.tablePlane.a * 87 + d.tablePlane.c, zGeo, 1e-3);
  assert.ok(r.calibration.flags.includes('depth_scale_disagrees'));
  assert.ok(r.depthPng);
  assert.equal(decodeDepthPng16(r.depthPng).widthPx, CAL_W);
  assert.ok(r.diagnostics.tablePlaneFit!.bandAdmitted < r.diagnostics.tablePlaneFit!.bandPoints, 'the raised object was not admitted');

  // Card touching the edge + low confidence.
  const edge = await runCalibration({
    imageBytes: await solidJpeg(CAL_W, CAL_H),
    knownAreaCm2: 46.21,
    referenceLabel: 'card',
    gateway: calGemini({ ...CARD_BOX, box_2d: [700, 0, 1000, 220], confidence: 'low', fully_visible: false }),
    sam: fixedSam(rect(CAL_W, CAL_H, 0, 150, 40, 200), CAL_W, CAL_H),
    renderOverlay: false,
  });
  assert.ok(edge.ok);
  assert.deepEqual(edge.calibration.flags.sort(), ['reference_low_confidence', 'reference_touches_edge']);
});

test('calibration failures: not found, invalid area, depth worker down ⇒ depth_unavailable (still succeeds)', async () => {
  const img = await solidJpeg(CAL_W, CAL_H);
  const card = rect(CAL_W, CAL_H, 62, 125, 112, 165);
  const nf = await runCalibration({ imageBytes: img, knownAreaCm2: 46.21, referenceLabel: 'card', gateway: calGemini({ found: false, box_2d: [0, 0, 0, 0], confidence: 'low', fully_visible: false }), sam: fixedSam(card, CAL_W, CAL_H) });
  assert.ok(!nf.ok);
  assert.equal(nf.error.code, 'REFERENCE_NOT_FOUND');
  assert.deepEqual(nf.flags, ['reference_not_found']);
  const bad = await runCalibration({ imageBytes: img, knownAreaCm2: 0, referenceLabel: 'card', gateway: calGemini(CARD_BOX), sam: fixedSam(card, CAL_W, CAL_H) });
  assert.ok(!bad.ok);
  assert.equal(bad.error.code, 'CALIBRATION_INVALID_AREA');
  const down: DepthEstimator = { estimate: async () => Promise.reject(new Error('ECONNREFUSED')) };
  const r = await runCalibration({ imageBytes: img, knownAreaCm2: 46.21, referenceLabel: 'card', gateway: calGemini(CARD_BOX), sam: fixedSam(card, CAL_W, CAL_H), depth: down, renderOverlay: false });
  assert.ok(r.ok);
  assert.equal(r.calibration.depth, null);
  assert.deepEqual(r.calibration.flags, ['depth_unavailable']);
});

test('fillHoles fills interior holes only', () => {
  const W = 5;
  const b = Uint8Array.from([0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
  const f = fillHoles(b, W, 5);
  assert.equal(f[12], 1);
  assert.equal(f[0], 0);
});

test('reference-mask-v1: a card split by a fork and punched by glare is one convex region; specks outside the box dropped', () => {
  const W = 100;
  const H = 80;
  const b = rect(W, H, 20, 20, 70, 60); // 50 × 40 = 2000
  for (let y = 20; y < 60; y++) for (let x = 44; x < 47; x++) b[y * W + x] = 0; // fork gap
  b[30 * W + 30] = 0; // glare hole
  b[2 * W + 95] = 1; // speck outside the box
  assert.equal(cleanReferenceMask(b, W, H, [20, 20, 70, 60]).pixels, 2000);
});

// ---------------------------------------------------------------------------
// Depth PNG + worker clients
// ---------------------------------------------------------------------------

test('depth PNG (16-bit, 0.1 mm) round trip; invalid ⇒ 0 ⇒ NaN; clamp at 6.5535 m; readable by sharp', async () => {
  const W = 37;
  const H = 23;
  const d = new Float32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = 0.3 + ((i * 7919) % 1000) / 600; // 0.3-1.97 m, noisy
  d[0] = Number.NaN;
  d[1] = -1;
  d[2] = 9;
  const png = encodeDepthPng16(d, W, H);
  const back = decodeDepthPng16(png);
  assert.equal(back.widthPx, W);
  assert.equal(back.heightPx, H);
  assert.ok(Number.isNaN(back.depthM[0]!));
  assert.ok(Number.isNaN(back.depthM[1]!));
  assert.equal(back.units[2], 65535);
  for (let i = 3; i < d.length; i++) assert.ok(Math.abs(back.depthM[i]! - d[i]!) <= 0.00005 + 1e-7, `pixel ${i}`);
  const meta = await sharp(Buffer.from(png)).metadata();
  assert.equal(meta.depth, 'ushort');
  assert.equal(meta.channels, 1);
});

test('depth response validation: dims, length, expected size', () => {
  const body = (W: number, H: number, n = W * H) => {
    const b = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) b.writeFloatLE(0.5 + i / 100, i * 4);
    return { widthPx: W, heightPx: H, model: 'm', checkpoint: 'c', device: 'cpu', settingsVersion: 's', depthF32B64: b.toString('base64') };
  };
  const ok: DepthMap = decodeDepthResponse(body(3, 2));
  assert.equal(ok.depthM.length, 6);
  near(ok.depthM[5]!, 0.55, 1e-6);
  assert.throws(() => decodeDepthResponse(body(3, 2, 5)), (e: unknown) => e instanceof GatewayError && e.apiError.code === 'DEPTH_INVALID');
  assert.throws(() => decodeDepthResponse(body(3, 2), { widthPx: 2, heightPx: 3 }), (e: unknown) => e instanceof GatewayError && e.apiError.code === 'DEPTH_MISALIGNED');
});

async function withServer(handler: (path: string, headers: IncomingHttpHeaders) => { status: number; body: object }, fn: (url: string, seen: IncomingHttpHeaders[]) => Promise<void>) {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.headers);
      const out = handler(req.url ?? '', req.headers);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.close();
  }
}

test('worker clients send X-Worker-Token when configured; 401 maps to *_UNAUTHORIZED', async () => {
  const f32 = Buffer.alloc(4);
  f32.writeFloatLE(0.7, 0);
  const handler = (path: string, h: IncomingHttpHeaders) =>
    h['x-worker-token'] !== 'sekret'
      ? { status: 401, body: { error: 'missing or wrong X-Worker-Token' } }
      : path === '/depth'
        ? { status: 200, body: { widthPx: 1, heightPx: 1, model: 'm', checkpoint: 'c', device: 'cpu', settingsVersion: 's', depthF32B64: f32.toString('base64') } }
        : { status: 200, body: { widthPx: 1, heightPx: 1, model: 'm', checkpoint: 'c', codeRevision: 'r', device: 'cpu', settingsVersion: 's', results: [] } };
  await withServer(handler, async (url, seen) => {
    const depth = await createDepthWorkerClient({ url, token: 'sekret' }).estimate(new Uint8Array([1]));
    near(depth.depthM[0]!, 0.7, 1e-6);
    await assert.rejects(createDepthWorkerClient({ url, token: '' }).estimate(new Uint8Array([1])), (e: unknown) => e instanceof GatewayError && e.apiError.code === 'DEPTH_UNAUTHORIZED');
    const seg = await createSamWorkerClient(url, 5000, 'sekret').segment(new Uint8Array([1]), [[0, 0, 1, 1]]);
    assert.equal(seg.model, 'm');
    await assert.rejects(createSamWorkerClient(url, 5000, '').segment(new Uint8Array([1]), [[0, 0, 1, 1]]), (e: unknown) => e instanceof GatewayError && e.apiError.code === 'SEGMENTATION_UNAUTHORIZED');
    assert.deepEqual(seen.map((h) => h['x-worker-token'] ?? null), ['sekret', null, 'sekret', null]);
  });
  await assert.rejects(createDepthWorkerClient({ url: 'http://127.0.0.1:9', timeoutMs: 2000 }).estimate(new Uint8Array([1])), (e: unknown) => e instanceof GatewayError && e.apiError.code === 'DEPTH_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// Overlay legend suffix (I8)
// ---------------------------------------------------------------------------

const bucket = (label: string, pixels: number): OverlayBucket => ({ itemId: label, label, pixels, bitmap: new Uint8Array(0), color: [200, 0, 0] });

test('legend suffix: text after the pixels, sanitized; a throwing callback is ignored', () => {
  const rows = legendRows({
    buckets: [bucket('Ancho Flank Steak', 12345), bucket('Rice', 10)],
    labelSuffix: (b) => (b.label === 'Rice' ? null : '38 g · 1.1 kg CO2e · 18 L water\u0007'),
  });
  assert.equal(rows[1]!.text, 'Ancho Flank Steak: 12,345 px · 38 g · 1.1 kg CO2e · 18 L water');
  assert.equal(rows[2]!.text, 'Rice: 10 px');
  const safe = legendRows({ buckets: [bucket('Rice', 10)], labelSuffix: () => { throw new Error('boom'); } });
  assert.equal(safe[1]!.text, 'Rice: 10 px');
});

test('legend truncation keeps the numbers: the food name is shortened first', () => {
  const row = { text: 'A Very Long Seasonal Roasted Vegetable Medley: 1,234 px · 38 g · 1.1 kg CO2e · 18 L water', head: 'A Very Long Seasonal Roasted Vegetable Medley', tail: ': 1,234 px · 38 g · 1.1 kg CO2e · 18 L water' };
  const fit = fitLegendText(row, 60);
  assert.ok(fit.length <= 60, fit);
  assert.ok(fit.endsWith(row.tail), fit);
  assert.equal(fit, "A Very Long Sea…: 1,234 px · 38 g · 1.1 kg CO2e · 18 L water");
  const tiny = fitLegendText(row, 20);
  assert.ok(tiny.length <= 20 && tiny.endsWith('…'), tiny);
  // Layout: on a narrow overlay every drawn line fits its estimated width budget.
  const rows = legendRows({ buckets: [bucket('A Very Long Seasonal Roasted Vegetable Medley With Herbs', 1234)], labelSuffix: () => '38 g · 1.1 kg CO2e · 18 L water' });
  const lay = layoutLegend(rows, 480);
  for (const line of lay.drawn) assert.ok(line.length * 12 * 0.56 <= 480, `${line} (${line.length})`);
  for (const line of layoutLegend(rows, 320).drawn) assert.ok(line.length * 12 * 0.56 <= 320, `narrow: ${line}`);
  assert.ok(lay.drawn[1]!.endsWith('18 L water'));
});

test('overlay renders with suffixes (real JPEG, legend below the image)', async () => {
  const W = 160;
  const H = 120;
  const img = new Uint8Array(await sharp({ create: { width: W, height: H, channels: 3, background: '#556677' } }).jpeg().toBuffer());
  const bm = rect(W, H, 10, 10, 50, 50);
  const r = await renderOverlay({
    image: { bytes: img },
    widthPx: W,
    heightPx: H,
    buckets: [{ itemId: 'steak', label: 'Ancho Flank Steak', pixels: 1600, bitmap: bm, color: [220, 40, 40] }],
    labelSuffix: () => '38 g · 1.1 kg CO2e · 18 L water',
  });
  assert.ok(r.ok);
  const meta = await sharp(Buffer.from(r.overlay.jpeg)).metadata();
  assert.equal(meta.width, W);
  assert.equal(meta.height, r.overlay.heightPx);
});

// ---------------------------------------------------------------------------
// Pipeline physical stage
// ---------------------------------------------------------------------------

const PW = 100;
const PH = 100;
const pipeInput: MaskAnalysisInput = {
  eventId: 'cap_p',
  attemptId: 'att_p',
  image: { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mimeType: 'image/jpeg' },
  geometry: { widthPx: PW, heightPx: PH, coordinateSpace: 'topdown-normalized-v1' },
  menu: { menuId: 'm', menuVersion: 1, items: [{ itemId: 'steak', menuId: 'm', displayName: 'Steak' }] },
  renderOverlay: false,
};
/** Dish box x/y 10-90, food box x/y 40-60 (400 px). */
const PIPE_ANSWER = {
  target_dish: { dish_type: 'plate', box_2d: [100, 100, 900, 900], fully_visible: true },
  pieces: [{ ingredient: 'steak', menu_id: 1, box_2d: [400, 400, 600, 600], on_target_dish: true }],
};
function boxSam(): Segmenter {
  return {
    async segment(_img, boxes) {
      return {
        model: 'fake-sam',
        checkpoint: 'fake',
        codeRevision: 't',
        device: 'cpu',
        settingsVersion: 'sam2-box-v1',
        widthPx: PW,
        heightPx: PH,
        results: boxes.map(([x0, y0, x1, y1]) => {
          const bm = rect(PW, PH, Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1));
          let px = 0;
          for (const v of bm) px += v;
          return { maskPng: maskPngOf(bm, PW, PH), score: 0.9, foregroundPx: px };
        }),
      };
    },
  };
}
const pipeGemini = () => createGeminiGateway({ env: {}, mockTransport: () => JSON.stringify(PIPE_ANSWER) });
/** Plate at 50 cm, food top at 48 cm; f = 96 ⇒ footprint (48/96)² = 0.25 cm² ⇒ 400 px × 2 cm × 0.25 = 200 cm³. */
function pipeDepth(): Float32Array {
  const d = new Float32Array(PW * PH).fill(0.5);
  for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) d[y * PW + x] = 0.48;
  return d;
}
const CAL: PhysicalCalibration = {
  calibrationId: 'cal_p',
  widthPx: PW,
  heightPx: PH,
  cm2PerPx: 0.25,
  intrinsics: { fxPx: 96, fyPx: 96 },
  depth: { scale: 1, tablePlane: { a: 0, b: 0, c: 51.5 }, settingsVersion: 'dav2-metric-small-v1' },
};

test('pipeline physical: volume with depth on; depth PNG exposed; attempt snapshots calibration + method', async () => {
  const r = await analyzeCaptureWithMasks(pipeGemini(), boxSam(), {
    ...pipeInput,
    physical: { calibration: CAL, depthEnabled: true, depthClient: fakeDepth(pipeDepth(), PW, PH) },
  });
  assert.equal(r.attempt.status, 'succeeded');
  assert.equal(r.measurements.length, 1);
  const m = r.measurements[0]!;
  assert.equal(m.remainingAreaPx, 400, 'pixels unchanged');
  assert.equal(m.physical!.method, 'volume-dav2-v1');
  near(m.physical!.volumeCm3!, 200, 0.01);
  assert.equal(m.physical!.plateReference, 'dish-ring-fit');
  assert.equal(r.physical.status, 'applied');
  assert.equal(r.physical.method, 'volume-dav2-v1');
  assert.equal(r.attempt.calibrationId, 'cal_p');
  assert.equal(r.attempt.physicalMethod, 'volume-dav2-v1');
  assert.ok(r.physical.depth);
  assert.equal(decodeDepthPng16(r.physical.depth.png).units[0], 5000);
});

test('pipeline physical: depth off ⇒ area; depth worker down ⇒ area + depth_unavailable; bowl ⇒ flagged', async () => {
  const area = await analyzeCaptureWithMasks(pipeGemini(), boxSam(), { ...pipeInput, physical: { calibration: CAL, depthEnabled: false } });
  assert.deepEqual(area.measurements[0]!.physical, computeAreaEstimate(400, CAL));
  assert.equal(area.attempt.physicalMethod, 'area-calibrated-v1');
  assert.equal(area.physical.depth, null);

  const down: DepthEstimator = { estimate: async () => { throw new GatewayError({ code: 'DEPTH_UNAVAILABLE', message: 'x', retryable: true }); } };
  const r = await analyzeCaptureWithMasks(pipeGemini(), boxSam(), { ...pipeInput, physical: { calibration: CAL, depthEnabled: true, depthClient: down } });
  assert.equal(r.measurements[0]!.physical!.method, 'area-calibrated-v1');
  assert.deepEqual(r.measurements[0]!.physical!.flags, ['depth_unavailable']);
  assert.equal(r.physical.depthError!.code, 'DEPTH_UNAVAILABLE');
  assert.equal(r.measurements[0]!.physical!.areaCm2, 100, 'never zero');

  const bowlAnswer = { ...PIPE_ANSWER, target_dish: { ...PIPE_ANSWER.target_dish, dish_type: 'bowl' } };
  const bowl = await analyzeCaptureWithMasks(createGeminiGateway({ env: {}, mockTransport: () => JSON.stringify(bowlAnswer) }), boxSam(), {
    ...pipeInput,
    physical: { calibration: CAL, depthEnabled: true, depthClient: fakeDepth(pipeDepth(), PW, PH) },
  });
  assert.deepEqual(bowl.measurements[0]!.physical!.flags, ['bowl_volume_unreliable']);
  assert.deepEqual(bowl.physical.bowl, { capture: true, liquidItemIds: [] });
});

test('pipeline physical: resolution mismatch ⇒ no physical, reason incompatible_geometry; no calibration ⇒ no_calibration', async () => {
  let depthCalls = 0;
  const counting: DepthEstimator = { estimate: async () => { depthCalls++; throw new Error('unused'); } };
  const r = await analyzeCaptureWithMasks(pipeGemini(), boxSam(), {
    ...pipeInput,
    physical: { calibration: { ...CAL, widthPx: 1024, heightPx: 1024 }, depthEnabled: true, depthClient: counting },
  });
  assert.equal(r.measurements[0]!.remainingAreaPx, 400);
  assert.equal(r.measurements[0]!.physical, undefined);
  assert.deepEqual([r.physical.status, r.physical.reason], ['unavailable', 'incompatible_geometry']);
  assert.equal(r.attempt.calibrationId, undefined);
  assert.equal(depthCalls, 0, 'no depth request for an incompatible calibration');
  const none = await analyzeCaptureWithMasks(pipeGemini(), boxSam(), { ...pipeInput, physical: { calibration: null, depthEnabled: true } });
  assert.deepEqual([none.physical.status, none.physical.reason], ['unavailable', 'no_calibration']);
  const omitted = await analyzeCaptureWithMasks(pipeGemini(), boxSam(), pipeInput);
  assert.equal(omitted.physical.status, 'not_requested');
});
