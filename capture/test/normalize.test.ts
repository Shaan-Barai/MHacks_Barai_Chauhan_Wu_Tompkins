import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import sharp from 'sharp';

import { CaptureError, CaptureErrorCodes } from '../src/errors.js';
import { assertValidDimensions, normalizeImage } from '../src/normalize.js';
import { makeFixtureDir, makeJpeg } from './helpers.js';

test('normalization center-crops to square and resizes to 1024x1024 JPEG', async () => {
  const dir = await makeFixtureDir();
  const file = await makeJpeg(dir, 'wide.jpg', 800, 300);
  const input = await readFile(file);

  const normalized = await normalizeImage(input);
  assert.equal(normalized.sourceWidthPx, 800);
  assert.equal(normalized.sourceHeightPx, 300);
  assert.deepEqual(normalized.geometry, {
    widthPx: 1024,
    heightPx: 1024,
    coordinateSpace: 'topdown-normalized-v1',
  });
  assert.equal(normalized.mimeType, 'image/jpeg');

  const meta = await sharp(Buffer.from(normalized.bytes)).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 1024);
  assert.equal(meta.height, 1024);
});

test('normalization is deterministic for identical input bytes', async () => {
  const dir = await makeFixtureDir();
  const file = await makeJpeg(dir, 'a.jpg', 500, 400);
  const input = await readFile(file);

  const first = await normalizeImage(input);
  const second = await normalizeImage(input);
  assert.deepEqual(Buffer.from(first.bytes), Buffer.from(second.bytes));
});

test('plate geometry hints are recorded on the normalized geometry', async () => {
  const dir = await makeFixtureDir();
  const file = await makeJpeg(dir, 'a.jpg');
  const input = await readFile(file);

  const normalized = await normalizeImage(input, { plateShape: 'tray', plateDiameterPx: 700 });
  assert.equal(normalized.geometry.plateShape, 'tray');
  assert.equal(normalized.geometry.plateDiameterPx, 700);
});

test('non-image bytes are rejected as unsupported, garbage as unreadable', async () => {
  await assert.rejects(
    () => normalizeImage(new TextEncoder().encode('hello, not an image')),
    (err: unknown) =>
      err instanceof CaptureError &&
      err.apiError.code === CaptureErrorCodes.UNSUPPORTED_IMAGE_TYPE,
  );

  // Starts like a JPEG but is truncated garbage.
  await assert.rejects(
    () => normalizeImage(new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01])),
    (err: unknown) => err instanceof CaptureError,
  );
});

test('zero or missing dimensions fail with INVALID_IMAGE_DIMENSIONS', () => {
  for (const [w, h] of [
    [0, 100],
    [100, 0],
    [undefined, 100],
    [Number.NaN, 100],
  ] as const) {
    assert.throws(
      () => assertValidDimensions(w as number | undefined, h as number | undefined, {}),
      (err: unknown) =>
        err instanceof CaptureError &&
        err.apiError.code === CaptureErrorCodes.INVALID_IMAGE_DIMENSIONS &&
        err.apiError.retryable === false,
    );
  }
  assert.doesNotThrow(() => assertValidDimensions(100, 100, {}));
});
