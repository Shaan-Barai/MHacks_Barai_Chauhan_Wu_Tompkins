/** Run 3 plate-scale-v1: the plate's pixel diameter from the target-dish box, only for a fully visible round plate. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiGateway, measurePlate, measureTargetPlate, PLATE_SCALE_VERSION } from '../src/index.js';

const box = (x0: number, y0: number, x1: number, y1: number) => ({ pixelXyxy: [x0, y0, x1, y1] as [number, number, number, number] });

test('a fully visible round plate: diameter = mean of box width and height', () => {
  const r = measurePlate({ dishType: 'plate', fullyVisible: true, box: box(100, 120, 980, 1020) }); // 880 × 900
  assert.deepEqual(r, { ok: true, version: PLATE_SCALE_VERSION, diameterPx: 890, boxWidthPx: 880, boxHeightPx: 900 });
});

test('no scale for bowls, cut-off or oval plates, tiny boxes, or no dish', () => {
  assert.equal(measurePlate(null).ok, false);
  const reason = (d: Parameters<typeof measurePlate>[0]) => {
    const r = measurePlate(d);
    return r.ok ? 'ok' : r.reason;
  };
  assert.equal(reason({ dishType: 'bowl', fullyVisible: true, box: box(0, 0, 500, 500) }), 'not_a_plate');
  assert.equal(reason({ dishType: 'plate', fullyVisible: false, box: box(0, 0, 500, 500) }), 'not_fully_visible');
  assert.equal(reason({ dishType: 'plate', box: box(0, 0, 500, 500) }), 'not_fully_visible');
  assert.equal(reason({ dishType: 'plate', fullyVisible: true, box: box(0, 0, 700, 500) }), 'not_round'); // 1.4 > 1.25
  assert.equal(reason({ dishType: 'plate', fullyVisible: true, box: box(0, 0, 40, 40) }), 'too_small');
  assert.equal(reason({ dishType: 'plate', fullyVisible: true }), 'no_dish');
});

// Run 4 backfill: one Gemini call (pass 1 only), then measurePlate; no segmentation.
const plateInput = {
  image: { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mimeType: 'image/jpeg' },
  geometry: { widthPx: 1000, heightPx: 1000, coordinateSpace: 'topdown-normalized-v1' as const },
  menu: { menuId: 'm', menuVersion: 1, items: [{ itemId: 'rice', menuId: 'm', displayName: 'Rice' }] },
};
const plateAnswer = (target: unknown) => JSON.stringify({ target_dish: target, pieces: [{ ingredient: 'rice', menu_id: 1, box_2d: [400, 400, 500, 500], on_target_dish: true }] });

test('measureTargetPlate: one base-prompt call; a fully visible round plate gives its box diameter', async () => {
  const prompts: string[] = [];
  const gw = createGeminiGateway({
    env: {},
    mockTransport: (req) => {
      prompts.push(req.parts.filter((p): p is { text: string } => 'text' in p).map((p) => p.text).join(''));
      return plateAnswer({ dish_type: 'plate', box_2d: [100, 120, 900, 900], fully_visible: true });
    },
  });
  const r = await measureTargetPlate(gw, plateInput);
  assert.equal(gw.callCount, 1);
  assert.ok(!prompts[0]!.includes('Look especially closely'), 'pass 1 = the unchanged base prompt');
  assert.equal(r.promptVersion, 'scrap-localize-v4');
  assert.deepEqual(r.plate, { ok: true, version: 'plate-scale-v1', diameterPx: 790, boxWidthPx: 780, boxHeightPx: 800 });
});

test('measureTargetPlate: bowls, cut-off plates and missing dishes give no plate, never a guess', async () => {
  const run = async (target: unknown) => (await measureTargetPlate(createGeminiGateway({ env: {}, mockTransport: () => plateAnswer(target) }), plateInput)).plate;
  assert.deepEqual(await run({ dish_type: 'bowl', box_2d: [100, 100, 900, 900], fully_visible: true }), { ok: false, version: 'plate-scale-v1', reason: 'not_a_plate' });
  assert.deepEqual(await run({ dish_type: 'plate', box_2d: [100, 100, 900, 900], fully_visible: false }), { ok: false, version: 'plate-scale-v1', reason: 'not_fully_visible' });
  assert.deepEqual(await run(null), { ok: false, version: 'plate-scale-v1', reason: 'no_dish' });
});
