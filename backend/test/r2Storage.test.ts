/**
 * Cloudflare R2 adapter, offline: presigning is local crypto (dummy
 * credentials), and S3 calls go to a fake client. A real bucket is exercised
 * by the live stack only (docs/verification-report.md).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { R2Storage } from '../src/storage/r2Storage.js';
import { HttpError } from '../src/errors.js';

const NOW = Date.parse('2026-10-03T18:00:00Z');

function makeStorage(send?: (command: { constructor: { name: string }; input: Record<string, unknown> }) => unknown) {
  // Without `send`, the adapter builds its own client (real endpoint config); presigning needs no network.
  let client: S3Client | undefined;
  if (send) {
    client = new S3Client({
      region: 'auto',
      endpoint: 'https://acct123.r2.cloudflarestorage.com',
      forcePathStyle: true,
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-example' },
    });
    (client as unknown as { send: unknown }).send = async (c: never) => send(c);
  }
  return new R2Storage({
    accountId: 'acct123',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret-example',
    bucket: 'scrap-images',
    allowedMimeTypes: ['image/jpeg', 'image/png'],
    maxUploadBytes: 1_000_000,
    uploadUrlTtlMs: 900_000,
    readUrlTtlMs: 600_000,
    now: () => NOW,
    ...(client ? { client } : {}),
  });
}

test('authorizeUpload presigns a PUT on the R2 endpoint, signed over type and size', async () => {
  const storage = makeStorage();
  const auth = await storage.authorizeUpload({
    associationKind: 'capture',
    associationId: 'cap_01',
    mimeType: 'image/jpeg',
    declaredSizeBytes: 1234,
  });
  assert.equal(auth.objectKey, 'captures/2026-10-03/cap_01.jpg');
  const url = new URL(auth.uploadUrl);
  assert.equal(url.host, 'acct123.r2.cloudflarestorage.com');
  assert.equal(url.pathname, `/scrap-images/${auth.objectKey}`);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '900');
  const signed = url.searchParams.get('X-Amz-SignedHeaders') ?? '';
  assert.ok(signed.includes('content-type') && signed.includes('content-length'), signed);
  assert.deepEqual(auth.uploadHeaders, { 'Content-Type': 'image/jpeg' });
  assert.equal(auth.expiresAt, '2026-10-03T18:15:00.000Z');
  assert.equal(storage.provider, 'r2');
  assert.equal(storage.container, 'scrap-images');
});

test('authorizeUpload enforces the MIME and size policy before signing', async () => {
  const storage = makeStorage();
  await assert.rejects(
    storage.authorizeUpload({ associationKind: 'capture', associationId: 'c', mimeType: 'image/gif', declaredSizeBytes: 10 }),
    (err: unknown) => err instanceof HttpError && err.apiError.code === 'UNSUPPORTED_MEDIA_TYPE',
  );
  await assert.rejects(
    storage.authorizeUpload({ associationKind: 'capture', associationId: 'c', mimeType: 'image/png', declaredSizeBytes: 2_000_000 }),
    (err: unknown) => err instanceof HttpError && err.apiError.code === 'UPLOAD_TOO_LARGE',
  );
});

test('statObject verifies with HeadObject; a missing key is "not uploaded yet", not an error', async () => {
  const seen: string[] = [];
  const storage = makeStorage((c) => {
    seen.push(`${c.constructor.name}:${String(c.input.Key)}`);
    if (c.input.Key === 'present.jpg') return { ContentLength: 4321 };
    throw Object.assign(new Error('not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
  });
  assert.deepEqual(await storage.statObject('present.jpg'), { exists: true, sizeBytes: 4321 });
  assert.deepEqual(await storage.statObject('missing.jpg'), { exists: false });
  assert.deepEqual(seen, ['HeadObjectCommand:present.jpg', 'HeadObjectCommand:missing.jpg']);
});

test('provider outages surface as retryable STORAGE_UNAVAILABLE without leaking details', async () => {
  const storage = makeStorage(() => {
    throw Object.assign(new Error('boom secret-example'), { name: 'InternalError', $metadata: { httpStatusCode: 500 } });
  });
  await assert.rejects(storage.statObject('x.jpg'), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.apiError.code, 'STORAGE_UNAVAILABLE');
    assert.equal(err.apiError.retryable, true);
    assert.ok(!JSON.stringify(err.apiError).includes('secret-example'));
    return true;
  });
});

test('getReadAccess presigns a temporary GET only for objects that exist', async () => {
  const storage = makeStorage((c) => {
    if (c.input.Key === 'captures/a.jpg') return { ContentLength: 10 };
    throw Object.assign(new Error('nf'), { name: 'NotFound' });
  });
  const access = await storage.getReadAccess('captures/a.jpg');
  const url = new URL(access.url);
  assert.equal(url.pathname, '/scrap-images/captures/a.jpg');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '600');
  assert.equal(access.expiresAt, '2026-10-03T18:10:00.000Z');
  await assert.rejects(
    storage.getReadAccess('captures/gone.jpg'),
    (err: unknown) => err instanceof HttpError && err.apiError.code === 'OBJECT_MISSING',
  );
});

test('getObjectBytes reads the body server-side for analysis', async () => {
  const storage = makeStorage(() => ({
    ContentType: 'image/jpeg',
    Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
  }));
  const { bytes, mimeType } = await storage.getObjectBytes('captures/a.jpg');
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.equal(mimeType, 'image/jpeg');
});
