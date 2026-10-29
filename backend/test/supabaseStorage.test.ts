/**
 * Supabase Storage adapter, offline: storage calls go to a fake client. The
 * real bucket is exercised by the live storage test
 * (tests/system/supabase-storage.test.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseStorage } from '../src/storage/supabaseStorage.js';
import { HttpError } from '../src/errors.js';

const NOW = Date.parse('2026-10-03T18:00:00Z');

type Result = { data: unknown; error: unknown };
type Calls = { method: string; args: unknown[] }[];

function makeStorage(handlers: Record<string, (...args: unknown[]) => Result>, calls: Calls = []) {
  const bucketApi = new Proxy(
    {},
    {
      get: (_t, method: string) => async (...args: unknown[]) => {
        calls.push({ method, args });
        const h = handlers[method];
        if (!h) throw new Error(`unexpected storage call ${method}`);
        return h(...args);
      },
    },
  );
  const client = { storage: { from: (bucket: string) => (assert.equal(bucket, 'scrap-images'), bucketApi) } };
  return new SupabaseStorage({
    url: 'https://example.supabase.co',
    serviceRoleKey: 'sb_secret_example',
    bucket: 'scrap-images',
    allowedMimeTypes: ['image/jpeg', 'image/png'],
    maxUploadBytes: 1_000_000,
    readUrlTtlMs: 600_000,
    now: () => NOW,
    client: client as never,
  });
}

const notFoundError = { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' };

test('authorizeUpload keeps the R2 key naming and returns a signed upload URL that overwrites on retry', async () => {
  const calls: Calls = [];
  const storage = makeStorage(
    {
      createSignedUploadUrl: (key) => ({
        data: { signedUrl: `https://example.supabase.co/storage/v1/object/upload/sign/scrap-images/${key}?token=t`, token: 't', path: key },
        error: null,
      }),
    },
    calls,
  );
  const auth = await storage.authorizeUpload({
    associationKind: 'capture',
    associationId: 'cap_01',
    mimeType: 'image/jpeg',
    declaredSizeBytes: 1234,
  });
  assert.equal(auth.objectKey, 'captures/2026-10-03/cap_01.jpg');
  assert.deepEqual(calls[0], { method: 'createSignedUploadUrl', args: ['captures/2026-10-03/cap_01.jpg', { upsert: true }] });
  assert.match(auth.uploadUrl, /\/object\/upload\/sign\/scrap-images\/captures\/2026-10-03\/cap_01\.jpg\?token=/);
  assert.deepEqual(auth.uploadHeaders, { 'Content-Type': 'image/jpeg' });
  assert.equal(auth.expiresAt, '2026-10-03T20:00:00.000Z');
  assert.equal(storage.provider, 'supabase');
  assert.equal(storage.container, 'scrap-images');
});

test('authorizeUpload rejects a disallowed type or size before calling Supabase', async () => {
  const storage = makeStorage({});
  await assert.rejects(
    storage.authorizeUpload({ associationKind: 'capture', associationId: 'c', mimeType: 'image/gif', declaredSizeBytes: 10 }),
    (e: unknown) => e instanceof HttpError && e.status === 400,
  );
  await assert.rejects(
    storage.authorizeUpload({ associationKind: 'capture', associationId: 'c', mimeType: 'image/jpeg', declaredSizeBytes: 2_000_000 }),
    (e: unknown) => e instanceof HttpError && e.status === 400,
  );
});

test('statObject reports size, treats "not found" as missing, and surfaces other failures as retryable 502', async () => {
  assert.deepEqual(await makeStorage({ info: () => ({ data: { size: 4321 }, error: null }) }).statObject('k'), {
    exists: true,
    sizeBytes: 4321,
  });
  assert.deepEqual(await makeStorage({ info: () => ({ data: null, error: notFoundError }) }).statObject('k'), { exists: false });
  await assert.rejects(
    makeStorage({ info: () => ({ data: null, error: { name: 'StorageUnknownError', message: 'fetch failed' } }) }).statObject('k'),
    (e: unknown) => e instanceof HttpError && e.status === 502 && e.apiError.code === 'STORAGE_UNAVAILABLE' && e.apiError.retryable === true,
  );
});

test('getReadAccess issues a short-lived signed URL, and 404s a missing object', async () => {
  const calls: Calls = [];
  const storage = makeStorage(
    {
      info: () => ({ data: { size: 1 }, error: null }),
      createSignedUrl: (key, ttl) => ({ data: { signedUrl: `https://example.supabase.co/storage/v1/object/sign/scrap-images/${key}?token=r&ttl=${ttl}` }, error: null }),
    },
    calls,
  );
  const access = await storage.getReadAccess('masks/2026-10-03/r1.png');
  assert.deepEqual(calls[1], { method: 'createSignedUrl', args: ['masks/2026-10-03/r1.png', 600] });
  assert.equal(access.expiresAt, '2026-10-03T18:10:00.000Z');
  await assert.rejects(
    makeStorage({ info: () => ({ data: null, error: notFoundError }) }).getReadAccess('gone.jpg'),
    (e: unknown) => e instanceof HttpError && e.status === 404 && e.apiError.code === 'OBJECT_MISSING',
  );
});

test('getObjectBytes, putBytes and deleteObject go through the service-role client', async () => {
  const calls: Calls = [];
  const storage = makeStorage(
    {
      download: () => ({ data: new Blob([Buffer.from('abc')], { type: 'image/png' }), error: null }),
      upload: () => ({ data: { path: 'p' }, error: null }),
      remove: () => ({ data: [], error: null }),
    },
    calls,
  );
  const got = await storage.getObjectBytes('masks/x.png');
  assert.equal(got.bytes.toString(), 'abc');
  assert.equal(got.mimeType, 'image/png');
  assert.deepEqual(await storage.putBytes('overlays/x.jpg', new Uint8Array([1, 2, 3]), 'image/jpeg'), { sizeBytes: 3 });
  assert.deepEqual(calls[1]!.args.slice(0, 1), ['overlays/x.jpg']);
  assert.deepEqual(calls[1]!.args[2], { contentType: 'image/jpeg', upsert: true });
  await storage.deleteObject('overlays/x.jpg');
  assert.deepEqual(calls[2], { method: 'remove', args: [['overlays/x.jpg']] });
  await assert.rejects(
    makeStorage({ download: () => ({ data: null, error: notFoundError }) }).getObjectBytes('gone'),
    (e: unknown) => e instanceof HttpError && e.status === 404,
  );
});

test('signed URLs and the service role key never appear in errors', async () => {
  const storage = makeStorage({ createSignedUploadUrl: () => ({ data: null, error: { name: 'StorageApiError', message: 'boom', status: 500 } }) });
  await assert.rejects(
    storage.authorizeUpload({ associationKind: 'capture', associationId: 'c', mimeType: 'image/jpeg', declaredSizeBytes: 10 }),
    (e: unknown) => {
      const text = JSON.stringify((e as HttpError).apiError);
      return !text.includes('sb_secret_example') && !text.includes('token=') && (e as HttpError).status === 502;
    },
  );
});
