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
import { buildNumberedMenu, validateLocalizeText } from '../src/localize.js';
import type { Segmenter, SegmentResponse } from '../src/samClient.js';
import { PLATE_SYSTEM_INSTRUCTION } from '../src/calibration.js';

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
const friesBox = [0, 100, 200, 300]; // x 10-30, y 0-10 = 200 px -> overlaps burger at x 10-20, y 0-10 (100 px)
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

test('counting smallest-first-v1: where masks overlap the smaller mask wins; each pixel counted once', () => {
  const a = new Uint8Array(10).fill(1, 0, 6); // item a, pixels 0-5 (6 px)
  const b = new Uint8Array(10).fill(1, 4, 8); // item b, pixels 4-7 (4 px)
  const c = new Uint8Array(10).fill(1, 0, 2); // item a again, pixels 0-1 (2 px)
  const u = new Uint8Array(10).fill(1, 7, 10); // unclassified, pixels 7-9 (3 px)
  const counts = countPixels(
    [
      { regionId: 'r1', itemId: 'a', bitmap: a },
      { regionId: 'r2', itemId: 'b', bitmap: b },
      { regionId: 'r3', itemId: 'a', bitmap: c },
      { regionId: 'r4', itemId: null, bitmap: u },
    ],
    10,
  );
  // Claim order by size: c(2) -> 0,1 ; u(3) -> 7,8,9 ; b(4) -> 4,5,6 ; a(6) -> 2,3.
  assert.equal(counts.perItem.get('a'), 4); // 0,1 (via c) + 2,3
  assert.equal(counts.perItem.get('b'), 3); // 4,5,6 — b beats a on 4,5 (smaller), loses 7 to u
  assert.equal(counts.unclassifiedPx, 3); // 7,8,9
  assert.equal(counts.overlapPx, 5); // 0,1,4,5,7
  assert.equal(counts.capturePx, 10);
  assert.equal(counts.capturePx, 4 + 3 + counts.unclassifiedPx, 'capture union = items + unclassified');
  assert.deepEqual(counts.regionsPerItem.get('a'), ['r1', 'r3']);
});

test('full pipeline: classify -> segment -> count; smaller fries mask wins its overlap with the burger', async () => {
  const sam = boxFiller();
  const { attempt, measurements, masks, itemMasks } = await analyzeCaptureWithMasks(
    gemini([
        { ingredient: 'bitten burger', menu_id: 1, box_2d: burgerBox },
        { ingredient: 'fries', menu_id: 2, box_2d: friesBox },
        { ingredient: 'stray fries', menu_id: 2, box_2d: friesBox2 },
      ]),
    sam,
    { ...input, baselines: [{ baselineId: 'b1', baselineVersion: 1, itemId: 'burger', expectedAreaPx: 400, geometry: input.geometry, source: 'manual_area' }] },
  );
  assert.deepEqual(sam.calls, [[[0, 0, 20, 20], [10, 0, 30, 10], [80, 30, 100, 50]]]);
  assert.equal(attempt.status, 'succeeded');
  const seg = attempt.segmentation!;
  assert.equal(seg.countStatus, 'complete');
  assert.equal(seg.capturePixelsWasted, 400 + 200 + 400 - 100); // union
  const by = Object.fromEntries(measurements.map((m) => [m.itemId ?? 'unclassified', m]));
  assert.equal(by.burger!.remainingAreaPx, 400 - 100, 'burger loses the overlap to the smaller fries mask');
  assert.equal(by.fries!.remainingAreaPx, 200 + 400);
  assert.equal(by.unclassified, undefined, 'overlaps no longer go to the unclassified bucket');
  assert.deepEqual(by.fries!.regionIds, ['att_1_r2', 'att_1_r3']);
  assert.ok(attempt.qualityFlags.includes('overlapping_masks'));
  assert.ok(measurements.every((m) => m.method === 'mask_pixel_count' && Number.isInteger(m.remainingAreaPx)));
  assert.equal(by.burger!.displayWastePercent, 75, 'optional baseline adds an auxiliary percent');
  assert.equal(by.fries!.unavailableReason, 'no_baseline_auxiliary_only', 'missing baseline never blocks the count');
  assert.equal(masks.length, 3);
  // One exclusive mask per measurement: disjoint, each counting to its own pixels.
  assert.equal(itemMasks.length, measurements.length);
  const owned = new Uint8Array(input.geometry.widthPx * input.geometry.heightPx);
  for (const mask of itemMasks) {
    const m = measurements.find((x) => x.measurementId === mask.measurementId)!;
    const decoded = decodeBinaryMask(mask.png, input.geometry.widthPx, input.geometry.heightPx);
    assert.ok(decoded.ok);
    assert.equal(decoded.pixels, m.remainingAreaPx);
    assert.equal(mask.count.pixelsWasted, m.remainingAreaPx);
    assert.equal(mask.count.assignment, 'exclusive');
    assert.equal(mask.count.processingVersion, 'smallest-first-v1');
    decoded.bitmap.forEach((v, i) => {
      if (!v) return;
      assert.equal(owned[i], 0, 'no pixel belongs to two measurements');
      owned[i] = 1;
    });
  }
  assert.equal(owned.reduce((a, b) => a + b, 0), seg.capturePixelsWasted);
});

test('explicit empty plate is a valid zero; segmentation is not called', async () => {
  const sam = boxFiller();
  const { attempt, measurements } = await analyzeCaptureWithMasks(gemini([]), sam, input);
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
    gemini([{ ingredient: 'burger', menu_id: 1, box_2d: burgerBox }]),
    down,
    input,
  );
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.error?.code, 'SEGMENTATION_FAILED');
  assert.equal(attempt.error?.retryable, true);
  assert.equal(attempt.segmentation!.countStatus, 'unavailable');
  assert.deepEqual(measurements, []);
});

test('partial (single pass): one malformed mask and one invalid box -> lower-bound count, needs review', async () => {
  const sam = boxFiller((k) => (k === 1 ? { maskPng: maskPng(W, H, () => 128) } : {}));
  const { attempt, measurements } = await analyzeCaptureWithMasks(
    gemini([
      { ingredient: 'burger', menu_id: 1, box_2d: burgerBox },
      { ingredient: 'fries', menu_id: 2, box_2d: friesBox2 },
      { ingredient: 'fries', menu_id: 2, box_2d: [500, 500, 400, 600] },
    ]),
    sam,
    { ...input, geminiPasses: 1 },
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
    gemini([{ ingredient: 'b', menu_id: 1, box_2d: burgerBox }]),
    wrong,
    input,
  );
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.segmentation!.regions[0]!.error?.code, 'MASK_MISALIGNED');
  assert.ok(attempt.qualityFlags.includes('incompatible_geometry'));
});

test('menu_id 0 goes to the unclassified bucket; menu_id outside the numbered menu is rejected', async () => {
  const { measurements, attempt } = await analyzeCaptureWithMasks(
    gemini([{ ingredient: 'mystery stew', menu_id: 0, box_2d: burgerBox }]),
    boxFiller(),
    input,
  );
  assert.equal(attempt.segmentation!.capturePixelsWasted, 400);
  assert.deepEqual(measurements.map((m) => [m.itemId, m.remainingAreaPx]), [[null, 400]]);

  const invented = await analyzeCaptureWithMasks(
    gemini([{ ingredient: 'pizza', menu_id: 3, box_2d: burgerBox }]),
    boxFiller(),
    input,
  );
  assert.equal(invented.attempt.status, 'failed');
  assert.equal(invented.attempt.error?.details?.reason, 'menu_id_out_of_range');
});

test('localize v2: numbered menu from name + description; menu_id must be an integer in 0..N', () => {
  const items = [
    { itemId: 'stir', menuId: 'm', displayName: 'Vegetable Stir Fry Blend', description: 'carrot coins, pepper strips' },
    { itemId: 'rice', menuId: 'm', displayName: 'Sticky Rice' },
  ];
  assert.equal(buildNumberedMenu(items), '1. Vegetable Stir Fry Blend — carrot coins, pepper strips\n2. Sticky Rice');
  const ok = validateLocalizeText(
    JSON.stringify([
      { ingredient: 'carrot slice', menu_id: 1, box_2d: [1, 2, 3, 4] },
      { ingredient: 'rice clump', menu_id: 2, box_2d: [5, 6, 7, 8] },
      { ingredient: 'melon', menu_id: 0, box_2d: [9, 9, 10, 10] },
    ]),
    ['stir', 'rice'],
  );
  assert.ok(ok.ok);
  assert.deepEqual(ok.regions.map((r) => [r.itemId, r.menuId, r.visualLabel]), [['stir', 1, 'carrot slice'], ['rice', 2, 'rice clump'], [null, 0, 'melon']]);
  assert.deepEqual(validateLocalizeText('[]', ['stir']), { ok: true, plateEmpty: true, ambiguous: false, regions: [] });
  for (const bad of [3, -1, 1.5, '1']) {
    assert.deepEqual(validateLocalizeText(JSON.stringify([{ ingredient: 'x', menu_id: bad, box_2d: [1, 2, 3, 4] }]), ['stir', 'rice']), { ok: false, reason: 'menu_id_out_of_range' });
  }
  assert.deepEqual(validateLocalizeText('{"regions":[]}', ['stir']), { ok: false, reason: 'not_an_array' });
});

/** Gateway whose answer depends on the pass (pass 2's prompt carries CLOSEUP_LINE). */
function twoPass(pass1: unknown, pass2: unknown) {
  return createGeminiGateway({
    env: {},
    mockTransport: (req) => {
      const closeup = req.parts.some((p) => 'text' in p && p.text.includes('Look especially closely'));
      const answer = closeup ? pass2 : pass1;
      if (answer instanceof Error) throw answer;
      return typeof answer === 'string' ? answer : JSON.stringify(answer);
    },
  });
}

test('two passes: union of boxes; heavy overlaps (IoU > 0.5) keep the smaller box, same or different menu_id', async () => {
  const sam = boxFiller();
  const rice = { ingredient: 'rice pile', menu_id: 1, box_2d: [0, 0, 600, 600] }; // x0-60, y0-30 = 1800 px
  const carrotA = { ingredient: 'carrot coin', menu_id: 2, box_2d: [0, 0, 500, 500] }; // x0-50,y0-25: IoU with rice 0.69 -> wins
  const carrotDup = { ingredient: 'carrot', menu_id: 2, box_2d: [0, 0, 480, 480] }; // same piece in pass 2, smaller -> kept, A dropped
  const pepper = { ingredient: 'pepper strip', menu_id: 2, box_2d: [800, 800, 1000, 1000] }; // only pass 2 finds it
  const { attempt, localization } = await analyzeCaptureWithMasks(twoPass([rice, carrotA], [carrotDup, pepper]), sam, input);
  assert.deepEqual(localization, { passes: 2, passBoxes: [2, 2], failedPasses: [], mergedBoxes: 2 });
  assert.deepEqual(attempt.segmentation!.regions.map((r) => r.visualLabel), ['carrot', 'pepper strip']);
  assert.equal(attempt.promptVersion, 'scrap-localize-v3+closeup');
  assert.equal(sam.calls.length, 1, 'SAM still runs once per plate on the merged boxes');
});

test('two passes: a failed or invalid pass falls back to the other; [] loses to a pass with pieces', async () => {
  const burger = [{ ingredient: 'burger', menu_id: 1, box_2d: burgerBox }];
  const failed = await analyzeCaptureWithMasks(twoPass(new Error('timeout'), burger), boxFiller(), input);
  assert.equal(failed.attempt.status, 'succeeded');
  assert.deepEqual(failed.localization.passBoxes, [null, 1]);
  assert.equal(failed.localization.failedPasses.length, 1);

  const invalid = await analyzeCaptureWithMasks(twoPass(burger, 'not json'), boxFiller(), input);
  assert.equal(invalid.attempt.status, 'succeeded');
  assert.deepEqual(invalid.localization.failedPasses, ['invalid:invalid_json']);

  const emptyVsPieces = await analyzeCaptureWithMasks(twoPass([], burger), boxFiller(), input);
  assert.equal(emptyVsPieces.attempt.segmentation!.countStatus, 'complete');
  assert.equal(emptyVsPieces.attempt.segmentation!.capturePixelsWasted, 400);

  const bothEmpty = await analyzeCaptureWithMasks(twoPass([], []), boxFiller(), input);
  assert.equal(bothEmpty.attempt.segmentation!.countStatus, 'empty');

  const bothFail = await analyzeCaptureWithMasks(twoPass('nope', new Error('down')), boxFiller(), input);
  assert.equal(bothFail.attempt.status, 'failed');
  assert.equal(bothFail.attempt.segmentation!.countStatus, 'unavailable');
});

test('GEMINI_PASSES=1 makes a single localization call with the unchanged base prompt', async () => {
  const seen: string[] = [];
  const gw = createGeminiGateway({
    env: {},
    mockTransport: (req) => {
      // The concurrent plate-calibration request (calibration.ts) is not a localization pass.
      if (req.systemInstruction === PLATE_SYSTEM_INSTRUCTION) return '{}';
      seen.push(req.parts.filter((p): p is { text: string } => 'text' in p).map((p) => p.text).join(''));
      return JSON.stringify([{ ingredient: 'burger', menu_id: 1, box_2d: burgerBox }]);
    },
  });
  const { attempt, localization } = await analyzeCaptureWithMasks(gw, boxFiller(), { ...input, geminiPasses: 1 });
  assert.equal(seen.length, 1);
  assert.ok(!seen[0]!.includes('Look especially closely'));
  assert.equal(attempt.promptVersion, 'scrap-localize-v3');
  assert.deepEqual(localization.passBoxes, [1]);
});
