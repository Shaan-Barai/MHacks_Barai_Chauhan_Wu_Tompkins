/**
 * Capture -> MaskAnalyzer (scripted Gemini + fake SAM) -> stored masks ->
 * Pixels wasted on the dashboard. Offline; contracts/measurement.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { createGeminiGateway, type Segmenter } from '@scrap/vision';
import { MaskAnalyzer } from '../src/analysis/maskAnalyzer.js';
import { HALL, startTestServer } from './helpers.js';

const W = 1024;
const H = 1024;

function rectMask(x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const png = new PNG({ width: W, height: H, colorType: 0, inputColorType: 0, inputHasAlpha: false });
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const v = x >= x0 && x < x1 && y >= y0 && y < y1 ? 255 : 0;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = v;
      png.data[i + 3] = 255;
    }
  return new Uint8Array(PNG.sync.write(png, { colorType: 0 }));
}

const segmenter: Segmenter = {
  async segment(_image, boxes) {
    return {
      model: 'sam2.1-hiera-small',
      checkpoint: 'facebook/sam2.1-hiera-small',
      codeRevision: 'test',
      device: 'cpu',
      settingsVersion: 'sam2-box-v1',
      widthPx: W,
      heightPx: H,
      results: boxes.map(([x0, y0, x1, y1]) => ({
        maskPng: rectMask(x0, y0, x1, y1),
        score: 0.95,
        foregroundPx: (Math.ceil(x1) - Math.ceil(x0)) * (Math.ceil(y1) - Math.ceil(y0)),
      })),
    };
  },
};

// Eggs box 0-100 x 0-100 (gemini 0..~97.66/1000) — use exact multiples of 1024/1000 via pixel math:
// gemini [0, 0, 250, 250] -> px [0, 0, 256, 256] = 65,536 px; toast [0, 250, 250, 500] -> px [256, 0, 512, 256] = 65,536 px.
const gemini = createGeminiGateway({
  env: {},
  mockTransport: () =>
    JSON.stringify({
      plateEmpty: false,
      ambiguous: false,
      regions: [
        { itemId: 'item_eggs', visualLabel: 'scrambled eggs', box_2d: [0, 0, 250, 250] },
        { itemId: 'item_toast', visualLabel: 'toast crust', box_2d: [0, 250, 250, 500] },
      ],
    }),
});

test('capture -> masks stored in object storage -> Pixels wasted on the dashboard, once', async (t) => {
  const s = await startTestServer(new MaskAnalyzer(gemini, segmenter));
  t.after(() => s.close());
  await s.seedMenuAndBaselines();

  const imageId = await s.uploadImage('cap_mask_1');
  const first = await s.submitCapture('cap_mask_1', imageId);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.event.state, 'succeeded');
  const seg = first.json.attempt.segmentation;
  assert.equal(seg.countStatus, 'complete');
  assert.equal(seg.capturePixelsWasted, 2 * 65536);
  assert.equal(seg.model, 'sam2.1-hiera-small');
  for (const region of seg.regions) {
    assert.equal(region.segmentationStatus, 'succeeded');
    const access = await s.api('GET', `/api/images/${region.maskObjectId}/access`);
    assert.equal(access.status, 200, 'mask is a finalized object in storage');
    const png = PNG.sync.read(Buffer.from(await (await fetch(`${s.baseUrl}${access.json.url}`)).arrayBuffer()));
    assert.deepEqual([png.width, png.height], [W, H]);
  }

  const again = await s.submitCapture('cap_mask_1', imageId);
  assert.equal(again.json.deduplicated, true);

  const meal = await s.api('GET', `/api/dashboard/meal?hallId=${HALL}&date=2026-10-03&meal=lunch`);
  assert.equal(meal.status, 200, JSON.stringify(meal.json));
  const summary = meal.json.summary;
  assert.equal(summary.pixelsWasted, 131072);
  assert.equal(summary.countedCaptureCount, 1);
  assert.deepEqual(
    summary.items.map((i: { itemId: string; pixelsWasted: number; shareOfMealPixelsPercent: number }) => [i.itemId, i.pixelsWasted, i.shareOfMealPixelsPercent]),
    [
      ['item_eggs', 65536, 50],
      ['item_toast', 65536, 50],
    ],
  );
  assert.equal(summary.labels.pixelsWasted, 'Pixels wasted');
  assert.equal(meal.json.attendance.source, 'simulated');
  assert.equal(meal.json.insight.source, 'fallback_rules', 'mock gateway text is never shown as an AI tip');

  const daily = await s.api('GET', `/api/dashboard/daily?hallId=${HALL}&start=2026-10-03&end=2026-10-03`);
  assert.deepEqual(daily.json.days[0], { date: '2026-10-03', pixelsWasted: 131072, capturedDishes: 1, countedDishes: 1 });
});

test('segmentation worker down: capture fails retryably and nothing is counted', async (t) => {
  const down: Segmenter = {
    async segment() {
      throw new Error('connect ECONNREFUSED');
    },
  };
  const s = await startTestServer(new MaskAnalyzer(gemini, down));
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  const res = await s.submitCapture('cap_down', await s.uploadImage('cap_down'));
  assert.equal(res.json.event.state, 'failed');
  assert.equal(res.json.attempt.error.code, 'SEGMENTATION_FAILED');
  assert.equal(res.json.attempt.error.retryable, true);
  const meal = await s.api('GET', `/api/dashboard/meal?hallId=${HALL}&date=2026-10-03&meal=lunch`);
  assert.equal(meal.json.summary.pixelsWasted, 0);
  assert.equal(meal.json.summary.exclusionReasons.analysis_failed, 1);
  assert.equal(meal.json.insight, null);
});
