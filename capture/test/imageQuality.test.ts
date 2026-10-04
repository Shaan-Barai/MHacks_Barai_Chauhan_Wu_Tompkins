/** Camera photo checks: valid JPEG, expected size, not black, not blurry. */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { checkCameraPhoto, measureImageQuality } from '../src/imageQuality.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', '..', 'fixtures', 'replay', 'images', 'dinner-1003-salmon-rice.jpg');

async function solid(width: number, height: number, v: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: v, g: v, b: v } } }).jpeg().toBuffer();
}

test('a real plate photo passes; brightness and sharpness are measured', async () => {
  const photo = await readFile(FIXTURE);
  const meta = await sharp(photo).metadata();
  const verdict = await checkCameraPhoto(photo, { widthPx: meta.width!, heightPx: meta.height! });
  assert.deepEqual(verdict.problems, []);
  assert.ok(verdict.quality.brightness > 40 && verdict.quality.sharpness > 15, JSON.stringify(verdict.quality));
});

test('black, blurry, wrong-size and non-JPEG photos are rejected with the reason', async () => {
  const black = await checkCameraPhoto(await solid(1920, 1080, 3), { widthPx: 1920, heightPx: 1080 });
  assert.ok(black.problems.some((p) => p.startsWith('too dark')));
  const blurred = await sharp(await readFile(FIXTURE)).resize(1920, 1080).blur(40).jpeg().toBuffer();
  const blurry = await checkCameraPhoto(blurred, { widthPx: 1920, heightPx: 1080 });
  assert.ok(blurry.problems.some((p) => p.startsWith('blurry')), JSON.stringify(blurry));
  const small = await checkCameraPhoto(await sharp(await readFile(FIXTURE)).resize(1280, 720).jpeg().toBuffer(), { widthPx: 1920, heightPx: 1080 });
  assert.ok(small.problems.includes('size is 1280x720, expected 1920x1080'));
  const png = await checkCameraPhoto(await sharp(await solid(64, 64, 128)).png().toBuffer(), { widthPx: 64, heightPx: 64 });
  assert.ok(png.problems.includes('not a JPEG (no start-of-image marker)'));
  const garbage = await checkCameraPhoto(Buffer.from([0xff, 0xd8, 1, 2, 3]), { widthPx: 1, heightPx: 1 });
  assert.equal(garbage.ok, false);
  assert.match(garbage.problems.at(-1)!, /cannot be decoded/);
  // Sharpness does not depend on resolution (measured at 512 px wide).
  const big = await measureImageQuality(await sharp(await readFile(FIXTURE)).resize(2048).jpeg().toBuffer());
  const same = await measureImageQuality(await sharp(await readFile(FIXTURE)).resize(1024).jpeg().toBuffer());
  assert.ok(Math.abs(big.sharpness - same.sharpness) / same.sharpness < 0.5);
});
