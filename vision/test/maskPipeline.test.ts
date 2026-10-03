/**
 * Classification -> segmentation -> Pixels wasted, offline. A fake segmenter
 * fills each box exactly, so every expected count is hand-computable.
 * Covers contracts/measurement.md "Required verification".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { createGeminiGateway } from '../src/gateway.js';
import { analyzeCaptureWithMasks, type MaskAnalysisInput } from '../src/maskPipeline.js';
import { countPixels, decodeBinaryMask, geminiBoxToPixels } from '../src/masks.js';
import type { Segmenter, SegmentResponse } from '../src/samClient.js';

const W = 100;
const H = 50;
const INFO = { model: 'fake-sam', checkpoint: 'fake', codeRevision: 'test', device: 'cpu', settingsVersion: 'sam2-box-v1' };

function maskPng(width: number, height: number, fill: (x: number, y: number) => number): Uint8Array {
  const png = new PNG({ width, height, colorType: 0, inputColorType: 0, inputHasAlpha: false, bitDepth: 8 });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = fill(x, y);
      const i = (y * width + x) * 4;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = v;
      png.data[i + 3] = 255;
    }
  return new Uint8Array(PNG.sync.write(png, { colorType: 0 }));
}

/** Segmenter whose mask is exactly the (integer-snapped) box. */
function boxFiller(override?: (k: number) => Partial<SegmentResponse['results'][number]>): Segmenter & { calls: number[][][] } {
  const calls: number[][][] = [];
  return {
    calls,
    async segment(_image, boxes) {
      calls.push(boxes);
      return {
        ...INFO,
        widthPx: W,
        heightPx: H,
        results: boxes.map(([x0, y0, x1, y1], k) => {
          const png = maskPng(W, H, (x, y) => (x >= x0 && x < x1 && y >= y0 && y < y1 ? 255 : 0));
          const px = (Math.ceil(x1) - Math.ceil(x0)) * (Math.ceil(y1) - Math.ceil(y0));
          return { maskPng: png, score: 0.9, foregroundPx: px, ...override?.(k) };
        }),
      };
    },
  };
}

function gemini(answer: unknown) {
  return createGeminiGateway({ env: {}, mockTransport: () => (typeof answer === 'string' ? answer : JSON.stringify(answer)) });
}

const input: MaskAnalysisInput = {
  eventId: 'cap_1',
  attemptId: 'att_1',
  image: { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mimeType: 'image/jpeg' },
  geometry: { widthPx: W, heightPx: H, coordinateSpace: 'topdown-normalized-v1' },
  menu: {
    menuId: 'menu_1',
    menuVersion: 1,
    items: [
      { itemId: 'burger', menuId: 'menu_1', displayName: 'Burger' },
      { itemId: 'fries', menuId: 'menu_1', displayName: 'Fries' },
    ],
  },
};

// Boxes in Gemini [ymin, xmin, ymax, xmax] 0-1000. On 100x50: x = v/10, y = v/20.
const burgerBox = [0, 0, 400, 200]; // x 0-20, y 0-20  -> 400 px
const friesBox = [0, 100, 400, 300]; // x 10-30, y 0-20 -> overlaps burger at x 10-20 (200 px)
const friesBox2 = [600, 800, 1000, 1000]; // x 80-100, y 30-50 -> 400 px

test('box conversion: Gemini [ymin,xmin,ymax,xmax]/1000 -> pixel [x0,y0,x1,y1] (no XY/YX swap)', () => {
  const r = geminiBoxToPixels([100, 200, 300, 400], 1000, 500);
  assert.ok(r.ok);
  assert.deepEqual(r.box.pixelXyxy, [200, 50, 400, 150]);
  for (const [box, reason] of [
    [[300, 200, 100, 400], 'box_reversed_or_empty'],
    [[0, 0, 0, 0], 'box_reversed_or_empty'],
    [[0, 0, 1200, 400], 'box_out_of_range'],
    [[0, Number.NaN, 10, 10], 'box_nonfinite'],
    [[1, 2, 3], 'box_not_4_numbers'],
  ] as const) {
    assert.deepEqual(geminiBoxToPixels(box, 1000, 500), { ok: false, reason });
  }
});

test('mask decoding: known foreground count; misaligned, soft, and non-PNG masks rejected', () => {
  const ok = decodeBinaryMask(maskPng(W, H, (x) => (x < 7 ? 255 : 0)), W, H);
  assert.ok(ok.ok);
  assert.equal(ok.pixels, 7 * H);
  assert.deepEqual(decodeBinaryMask(maskPng(W + 1, H, () => 0), W, H), { ok: false, reason: 'mask_dimension_mismatch' });
  assert.deepEqual(decodeBinaryMask(maskPng(W, H, () => 128), W, H), { ok: false, reason: 'mask_not_binary' });
  assert.deepEqual(decodeBinaryMask(new Uint8Array([1, 2, 3]), W, H), { ok: false, reason: 'mask_not_png' });
});

test('counting: overlap between foods is counted once and attributed to neither item', () => {
  const a = new Uint8Array(10).fill(1, 0, 6); // pixels 0-5
  const b = new Uint8Array(10).fill(1, 4, 8); // pixels 4-7 (overlap 4-5)
  const c = new Uint8Array(10).fill(1, 0, 2); // second region of item a (inside a)
  const u = new Uint8Array(10).fill(1, 7, 10); // unknown food 7-9 (7 also in b)
  const counts = countPixels(
    [
      { regionId: 'r1', itemId: 'a', bitmap: a },
      { regionId: 'r2', itemId: 'b', bitmap: b },
      { regionId: 'r3', itemId: 'a', bitmap: c },
      { regionId: 'r4', itemId: null, bitmap: u },
    ],
    10,
  );
  assert.equal(counts.perItem.get('a'), 4); // 0-3
  assert.equal(counts.perItem.get('b'), 2); // 6-7
  assert.equal(counts.contestedPx, 2); // 4-5
  assert.equal(counts.unclassifiedPx, 4); // 4-5 contested + 8-9 unknown
  assert.equal(counts.capturePx, 10);
  assert.equal(counts.capturePx, 4 + 2 + counts.unclassifiedPx, 'capture union = items + unclassified');
});

test('full pipeline: classify -> segment -> count, with union across regions and overlap flag', async () => {
  const sam = boxFiller();
  const { attempt, measurements, masks } = await analyzeCaptureWithMasks(
    gemini({
      plateEmpty: false,
      ambiguous: false,
      regions: [
        { itemId: 'burger', visualLabel: 'bitten burger', box_2d: burgerBox },
        { itemId: 'fries', visualLabel: 'fries', box_2d: friesBox },
        { itemId: 'fries', visualLabel: 'stray fries', box_2d: friesBox2 },
      ],
    }),
    sam,
    { ...input, baselines: [{ baselineId: 'b1', baselineVersion: 1, itemId: 'burger', expectedAreaPx: 400, geometry: input.geometry, source: 'manual_area' }] },
  );
  assert.deepEqual(sam.calls, [[[0, 0, 20, 20], [10, 0, 30, 20], [80, 30, 100, 50]]]);
  assert.equal(attempt.status, 'succeeded');
  const seg = attempt.segmentation!;
  assert.equal(seg.countStatus, 'complete');
  assert.equal(seg.capturePixelsWasted, 400 + 400 + 400 - 200); // union
  const by = Object.fromEntries(measurements.map((m) => [m.itemId ?? 'unclassified', m]));
  assert.equal(by.burger!.remainingAreaPx, 200);
  assert.equal(by.fries!.remainingAreaPx, 200 + 400);
  assert.equal(by.unclassified!.remainingAreaPx, 200);
  assert.deepEqual(by.fries!.regionIds, ['att_1_r2', 'att_1_r3']);
  assert.ok(attempt.qualityFlags.includes('overlapping_masks'));
  assert.ok(measurements.every((m) => m.method === 'sam2_mask_pixel_count' && Number.isInteger(m.remainingAreaPx)));
  assert.equal(by.burger!.displayWastePercent, 50, 'optional baseline adds an auxiliary percent');
  assert.equal(by.fries!.unavailableReason, 'no_baseline_auxiliary_only', 'missing baseline never blocks the count');
  assert.equal(masks.length, 3);
});

test('explicit empty plate is a valid zero; segmentation is not called', async () => {
  const sam = boxFiller();
  const { attempt, measurements } = await analyzeCaptureWithMasks(gemini({ plateEmpty: true, ambiguous: false, regions: [] }), sam, input);
  assert.equal(attempt.status, 'succeeded');
  assert.equal(attempt.segmentation!.countStatus, 'empty');
  assert.equal(attempt.segmentation!.capturePixelsWasted, 0);
  assert.deepEqual(measurements, []);
  assert.equal(sam.calls.length, 0);
});

test('classification failure: nothing counted, segmentation skipped', async () => {
  const { attempt } = await analyzeCaptureWithMasks(gemini('not json'), boxFiller(), input);
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.segmentation!.status, 'skipped');
  assert.equal(attempt.segmentation!.countStatus, 'unavailable');
  assert.equal(attempt.segmentation!.capturePixelsWasted, undefined);
});

test('segmentation unavailable: retryable failure, never zero pixels', async () => {
  const down: Segmenter = {
    async segment() {
      throw new Error('ECONNREFUSED');
    },
  };
  const { attempt, measurements } = await analyzeCaptureWithMasks(
    gemini({ plateEmpty: false, ambiguous: false, regions: [{ itemId: 'burger', visualLabel: 'burger', box_2d: burgerBox }] }),
    down,
    input,
  );
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.error?.code, 'SEGMENTATION_FAILED');
  assert.equal(attempt.error?.retryable, true);
  assert.equal(attempt.segmentation!.countStatus, 'unavailable');
  assert.deepEqual(measurements, []);
});

test('partial: one malformed mask and one invalid box -> lower-bound count, needs review', async () => {
  const sam = boxFiller((k) => (k === 1 ? { maskPng: maskPng(W, H, () => 128) } : {}));
  const { attempt, measurements } = await analyzeCaptureWithMasks(
    gemini({
      plateEmpty: false,
      ambiguous: false,
      regions: [
        { itemId: 'burger', visualLabel: 'burger', box_2d: burgerBox },
        { itemId: 'fries', visualLabel: 'fries', box_2d: friesBox2 },
        { itemId: 'fries', visualLabel: 'fries', box_2d: [500, 500, 400, 600] },
      ],
    }),
    sam,
    input,
  );
  assert.equal(attempt.status, 'needs_review');
  const seg = attempt.segmentation!;
  assert.equal(seg.countStatus, 'partial');
  assert.equal(seg.capturePixelsWasted, 400);
  assert.deepEqual(seg.regions.map((r) => r.segmentationStatus), ['succeeded', 'failed', 'failed']);
  assert.equal(seg.regions[1]!.error?.details?.reason, 'mask_not_binary');
  assert.equal(seg.regions[2]!.error?.code, 'INVALID_BOX');
  assert.deepEqual(measurements.map((m) => m.itemId), ['burger']);
  assert.ok(attempt.qualityFlags.includes('segmentation_failed'));
});

test('a segmenter answering at the wrong resolution is rejected as misaligned', async () => {
  const sam = boxFiller();
  const wrong: Segmenter = { segment: async (img, boxes) => ({ ...(await sam.segment(img, boxes)), widthPx: 2 * W }) };
  const { attempt } = await analyzeCaptureWithMasks(
    gemini({ plateEmpty: false, ambiguous: false, regions: [{ itemId: 'burger', visualLabel: 'b', box_2d: burgerBox }] }),
    wrong,
    input,
  );
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.segmentation!.regions[0]!.error?.code, 'MASK_MISALIGNED');
  assert.ok(attempt.qualityFlags.includes('incompatible_geometry'));
});

test('unknown food goes to the unclassified bucket; invented item IDs are rejected', async () => {
  const { measurements, attempt } = await analyzeCaptureWithMasks(
    gemini({ plateEmpty: false, ambiguous: false, regions: [{ itemId: 'unknown', visualLabel: 'mystery stew', box_2d: burgerBox }] }),
    boxFiller(),
    input,
  );
  assert.equal(attempt.segmentation!.capturePixelsWasted, 400);
  assert.deepEqual(measurements.map((m) => [m.itemId, m.remainingAreaPx]), [[null, 400]]);

  const invented = await analyzeCaptureWithMasks(
    gemini({ plateEmpty: false, ambiguous: false, regions: [{ itemId: 'pizza', visualLabel: 'pizza', box_2d: burgerBox }] }),
    boxFiller(),
    input,
  );
  assert.equal(invented.attempt.status, 'failed');
  assert.equal(invented.attempt.error?.details?.reason, 'item_not_on_menu');
});
