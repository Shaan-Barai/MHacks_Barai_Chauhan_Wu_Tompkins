/**
 * Real @scrap/vision pipeline (scripted Gemini + fake SAM) on a real PNG: the
 * counted masks are stored, no plate calibration is persisted (BIG-PLAN v2),
 * and the rendered overlay JPEG lands in object storage as an `overlay`
 * image object.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { createGeminiGateway, type Segmenter } from '@scrap/vision';
import { MaskAnalyzer } from '../src/analysis/maskAnalyzer.js';
import { loadConfig } from '../src/config.js';
import { GEOMETRY, HALL, SERVICE, startTestServer, type TestServer } from './helpers.js';

const W = 1024;
const H = 1024;

function png(fill: (x: number, y: number) => number): Buffer {
  const img = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const v = fill(x, y);
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  return PNG.sync.write(img);
}

function binaryMask(x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const img = new PNG({ width: W, height: H, colorType: 0, inputColorType: 0, inputHasAlpha: false });
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const v = x >= x0 && x < x1 && y >= y0 && y < y1 ? 255 : 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  return new Uint8Array(PNG.sync.write(img, { colorType: 0 }));
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
        maskPng: binaryMask(x0, y0, x1, y1),
        score: 0.95,
        foregroundPx: (Math.ceil(x1) - Math.ceil(x0)) * (Math.ceil(y1) - Math.ceil(y0)),
      })),
    };
  },
};

// Every Gemini call gets the same scripted food list.
const gemini = createGeminiGateway({
  env: {},
  mockTransport: () => JSON.stringify([{ ingredient: 'scrambled eggs', menu_id: 1, box_2d: [0, 0, 250, 250] }]),
});

async function uploadPng(s: TestServer, eventId: string, bytes: Buffer): Promise<string> {
  const req = await s.api('POST', '/api/images/uploads', {
    associationKind: 'capture',
    associationId: eventId,
    mimeType: 'image/png',
    sizeBytes: bytes.length,
    widthPx: W,
    heightPx: H,
  });
  assert.equal(req.status, 201, JSON.stringify(req.json));
  const put = await fetch(`${s.baseUrl}${req.json.uploadUrl}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes });
  assert.equal(put.status, 204);
  const fin = await s.api('POST', `/api/images/${req.json.objectId}/finalize`);
  assert.equal(fin.status, 200);
  return req.json.objectId;
}

test('vision pipeline: masks counted, no calibration persisted, overlay JPEG stored and served', async (t) => {
  const s = await startTestServer(new MaskAnalyzer(gemini, segmenter));
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  const eventId = 'cap_vision_overlay';
  const imageId = await uploadPng(s, eventId, png((x, y) => ((x >> 6) + (y >> 6)) % 2 ? 200 : 60));
  const res = await s.api('POST', '/api/captures', {
    eventId,
    hallId: HALL,
    serviceId: SERVICE,
    capturedAt: '2026-10-03T17:00:00Z',
    imageObjectId: imageId,
    geometry: GEOMETRY,
    source: 'replay',
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.event.state, 'succeeded');
  assert.equal(res.json.attempt.calibration, undefined, 'v2: no plate calibration');
  assert.ok(res.json.attempt.segmentation.capturePixelsWasted > 0, 'pixels were counted');

  const overlayId = res.json.attempt.overlayObjectId;
  assert.match(overlayId, /^img_/, 'the rendered overlay was stored');
  const obj = await s.repo.getImageObject(overlayId);
  assert.deepEqual(obj?.association, { kind: 'overlay', id: eventId });
  assert.equal(obj?.mimeType, 'image/jpeg');

  const images = await s.api('GET', `/api/captures/${eventId}/images`);
  const jpeg = Buffer.from(await (await fetch(`${s.baseUrl}${images.json.overlay.url}`)).arrayBuffer());
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8], 'serves a JPEG');
  assert.equal(images.json.masks.length, 1);
  assert.equal(images.json.masks[0].displayName, 'Scrambled Eggs');
});

test('PLATE_DIAMETER_PX is no longer read (BIG-PLAN v2: no plate calibration)', () => {
  const config = loadConfig({ PLATE_DIAMETER_PX: '0' });
  assert.equal('plateDiameterPx' in config, false);
});

// Target-dish answer (vision localize v4): eggs on the scanned plate, toast on a neighboring plate.
const targetDishGemini = createGeminiGateway({
  env: {},
  mockTransport: () =>
    JSON.stringify({
      target_dish: { dish_type: 'plate', box_2d: [0, 0, 600, 600], fully_visible: true },
      pieces: [
        { ingredient: 'scrambled eggs', menu_id: 1, box_2d: [0, 0, 250, 250], on_target_dish: true },
        { ingredient: 'toast', menu_id: 2, box_2d: [700, 700, 900, 900], on_target_dish: false },
      ],
    }),
});

test('target-dish counting: neighbor food is not counted and shows up in impact coverage', async (t) => {
  const s = await startTestServer(new MaskAnalyzer(targetDishGemini, segmenter));
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  const eventId = 'cap_target_dish';
  const imageId = await uploadPng(s, eventId, png((x, y) => ((x >> 6) + (y >> 6)) % 2 ? 200 : 60));
  const res = await s.api('POST', '/api/captures', {
    eventId, hallId: HALL, serviceId: SERVICE, capturedAt: '2026-10-03T17:00:00Z', imageObjectId: imageId, geometry: GEOMETRY, source: 'replay',
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.event.state, 'succeeded');
  assert.ok(res.json.attempt.qualityFlags.includes('neighbor_food_excluded'), JSON.stringify(res.json.attempt.qualityFlags));
  const counted = res.json.measurements.map((m: any) => m.itemId);
  assert.deepEqual(counted, ['item_eggs'], 'only the target dish food is counted');

  const d = await s.api('GET', `/api/dashboard/impact?start=2026-10-03&end=2026-10-03&hallId=${HALL}`);
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal(d.json.coverage.capturesWithNeighborFoodExcluded, 1);
  assert.equal(d.json.totals.pixels, res.json.attempt.segmentation.capturePixelsWasted);
});
