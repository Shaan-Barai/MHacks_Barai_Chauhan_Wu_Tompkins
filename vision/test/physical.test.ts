/**
 * IT_4: calibrated area, calibration math, worker token headers, legend
 * suffixes. Fakes only (the token test uses a loopback HTTP server, no
 * external network).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { createGeminiGateway } from '../src/gateway.js';
import { analyzeCaptureWithMasks, type MaskAnalysisInput, type PhysicalCalibration } from '../src/maskPipeline.js';
import { computeAreaEstimate } from '../src/area.js';
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
// area.ts
// ---------------------------------------------------------------------------

test('area method: area = pixels × k', () => {
  assert.deepEqual(computeAreaEstimate(1234, { calibrationId: 'c', cm2PerPx: 0.01 }), {
    calibrationId: 'c',
    method: 'area-calibrated-v1',
    areaCm2: 12.34,
  });
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
  assert.equal('depth' in c, false, 'no depth fields');
  assert.deepEqual(c.flags, []);
  assert.equal(c.method, 'reference-area-v1');
  assert.ok(r.overlay && r.overlay.jpeg.length > 0, r.diagnostics.overlayError);
  const meta = await sharp(Buffer.from(r.overlay.jpeg)).metadata();
  assert.equal(meta.width, CAL_W);
  assert.ok(meta.height! > CAL_H);
  assert.equal('depthPng' in r, false);
  assert.match(calibrationLegendRows(c).map((l) => l.text).join('\n'), /k = 0\.02311 cm²\/px[\s\S]*Camera height \(geometric/);
});

test('calibration failures: not found, invalid area', async () => {
  const img = await solidJpeg(CAL_W, CAL_H);
  const card = rect(CAL_W, CAL_H, 62, 125, 112, 165);
  const nf = await runCalibration({ imageBytes: img, knownAreaCm2: 46.21, referenceLabel: 'card', gateway: calGemini({ found: false, box_2d: [0, 0, 0, 0], confidence: 'low', fully_visible: false }), sam: fixedSam(card, CAL_W, CAL_H) });
  assert.ok(!nf.ok);
  assert.equal(nf.error.code, 'REFERENCE_NOT_FOUND');
  assert.deepEqual(nf.flags, ['reference_not_found']);
  const bad = await runCalibration({ imageBytes: img, knownAreaCm2: 0, referenceLabel: 'card', gateway: calGemini(CARD_BOX), sam: fixedSam(card, CAL_W, CAL_H) });
  assert.ok(!bad.ok);
  assert.equal(bad.error.code, 'CALIBRATION_INVALID_AREA');
});

test('calibration flags: card touching the edge + low confidence', async () => {
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
// Worker clients
// ---------------------------------------------------------------------------

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
  const handler = (_path: string, h: IncomingHttpHeaders) =>
    h['x-worker-token'] !== 'sekret'
      ? { status: 401, body: { error: 'missing or wrong X-Worker-Token' } }
      : { status: 200, body: { widthPx: 1, heightPx: 1, model: 'm', checkpoint: 'c', codeRevision: 'r', device: 'cpu', settingsVersion: 's', results: [] } };
  await withServer(handler, async (url, seen) => {
    const seg = await createSamWorkerClient(url, 5000, 'sekret').segment(new Uint8Array([1]), [[0, 0, 1, 1]]);
    assert.equal(seg.model, 'm');
    await assert.rejects(createSamWorkerClient(url, 5000, '').segment(new Uint8Array([1]), [[0, 0, 1, 1]]), (e: unknown) => e instanceof GatewayError && e.apiError.code === 'SEGMENTATION_UNAUTHORIZED');
    assert.deepEqual(seen.map((h) => h['x-worker-token'] ?? null), ['sekret', null]);
  });
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
const CAL: PhysicalCalibration = {
  calibrationId: 'cal_p',
  widthPx: PW,
  heightPx: PH,
  cm2PerPx: 0.25,
};

test('pipeline physical: calibrated area per food; attempt snapshots calibration + method; pixels unchanged', async () => {
  const r = await analyzeCaptureWithMasks(pipeGemini(), boxSam(), { ...pipeInput, physical: { calibration: CAL } });
  assert.equal(r.attempt.status, 'succeeded');
  assert.equal(r.measurements.length, 1);
  const m = r.measurements[0]!;
  assert.equal(m.remainingAreaPx, 400, 'pixels unchanged');
  assert.deepEqual(m.physical, computeAreaEstimate(400, CAL));
  assert.deepEqual(m.physical, { calibrationId: 'cal_p', method: 'area-calibrated-v1', areaCm2: 100 });
  assert.equal(r.physical.status, 'applied');
  assert.equal(r.physical.method, 'area-calibrated-v1');
  assert.equal(r.attempt.calibrationId, 'cal_p');
  assert.equal(r.attempt.physicalMethod, 'area-calibrated-v1');
  assert.equal('depth' in r.physical, false, 'no depth output');
  assert.equal('depthObjectId' in r.attempt, false);

  // A bowl is measured the same way (no bowl special case without depth).
  const bowlAnswer = { ...PIPE_ANSWER, target_dish: { ...PIPE_ANSWER.target_dish, dish_type: 'bowl' } };
  const bowl = await analyzeCaptureWithMasks(createGeminiGateway({ env: {}, mockTransport: () => JSON.stringify(bowlAnswer) }), boxSam(), {
    ...pipeInput,
    physical: { calibration: CAL },
  });
  assert.deepEqual(bowl.measurements[0]!.physical, computeAreaEstimate(400, CAL));
});

test('pipeline physical: resolution mismatch ⇒ no physical, reason incompatible_geometry; no calibration ⇒ no_calibration', async () => {
  const r = await analyzeCaptureWithMasks(pipeGemini(), boxSam(), {
    ...pipeInput,
    physical: { calibration: { ...CAL, widthPx: 1024, heightPx: 1024 } },
  });
  assert.equal(r.measurements[0]!.remainingAreaPx, 400);
  assert.equal(r.measurements[0]!.physical, undefined);
  assert.deepEqual([r.physical.status, r.physical.reason], ['unavailable', 'incompatible_geometry']);
  assert.equal(r.attempt.calibrationId, undefined);
  const none = await analyzeCaptureWithMasks(pipeGemini(), boxSam(), { ...pipeInput, physical: { calibration: null } });
  assert.deepEqual([none.physical.status, none.physical.reason], ['unavailable', 'no_calibration']);
  const omitted = await analyzeCaptureWithMasks(pipeGemini(), boxSam(), pipeInput);
  assert.equal(omitted.physical.status, 'not_requested');
});
