/**
 * Two-step upload flow (AGENTS.md 5.7/5.8): object-store write and DB
 * registration are separate operations; finalization is retryable and
 * idempotent; never-finalized uploads are tracked as orphans and cleanable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('finalize before upload fails retryably, succeeds after upload, and is idempotent', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  const req = await s.api('POST', '/api/images/uploads', {
    associationKind: 'capture',
    associationId: 'cap_two_step',
    mimeType: 'image/png',
    sizeBytes: 64,
  });
  assert.equal(req.status, 201);
  assert.ok(req.json.objectId);
  assert.ok(req.json.uploadUrl);

  // Step 2 (finalize) before the bytes exist: explicit, retryable error.
  const early = await s.api('POST', `/api/images/${req.json.objectId}/finalize`);
  assert.equal(early.status, 409);
  assert.equal(early.json.error.code, 'UPLOAD_NOT_COMPLETED');
  assert.equal(early.json.error.retryable, true);

  // Upload the bytes, then retry finalization — now it verifies and registers.
  const put = await fetch(`${s.baseUrl}${req.json.uploadUrl}`, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: Buffer.from('fake-png-bytes'),
  });
  assert.equal(put.status, 204);

  const fin = await s.api('POST', `/api/images/${req.json.objectId}/finalize`);
  assert.equal(fin.status, 200);
  assert.equal(fin.json.imageObject.state, 'finalized');
  assert.ok(fin.json.imageObject.uploadedAt);
  assert.equal(fin.json.imageObject.objectKey, req.json.objectKey);

  // Finalizing again is a no-op success (retry-safe).
  const again = await s.api('POST', `/api/images/${req.json.objectId}/finalize`);
  assert.equal(again.status, 200);
  assert.equal(again.json.imageObject.state, 'finalized');

  // Read access is temporary and carries expiry metadata.
  const access = await s.api('GET', `/api/images/${req.json.objectId}/access`);
  assert.equal(access.status, 200);
  assert.ok(access.json.url);
  assert.ok(access.json.expiresAt);
  const read = await fetch(`${s.baseUrl}${access.json.url}`);
  assert.equal(read.status, 200);
});

test('uploads never finalized are tracked as orphans and cleaned up', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  // Orphan A: authorized but bytes never uploaded.
  const a = await s.api('POST', '/api/images/uploads', {
    associationKind: 'capture',
    associationId: 'cap_orphan_a',
    mimeType: 'image/png',
    sizeBytes: 64,
  });
  // Orphan B: bytes uploaded but never finalized.
  const b = await s.api('POST', '/api/images/uploads', {
    associationKind: 'capture',
    associationId: 'cap_orphan_b',
    mimeType: 'image/png',
    sizeBytes: 64,
  });
  await fetch(`${s.baseUrl}${b.json.uploadUrl}`, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: Buffer.from('fake-png-bytes'),
  });
  // Control: a completed upload must never appear as an orphan.
  const done = await s.uploadImage('cap_completed');

  const orphans = await s.api('GET', '/api/images/orphans?maxAgeSeconds=0');
  assert.equal(orphans.status, 200);
  const ids = orphans.json.orphans.map((o: { objectId: string }) => o.objectId).sort();
  assert.deepEqual(ids, [a.json.objectId, b.json.objectId].sort());
  assert.ok(!ids.includes(done));

  const cleanup = await s.api('POST', '/api/images/cleanup-orphans', { maxAgeSeconds: 0 });
  assert.equal(cleanup.status, 200);
  assert.deepEqual(cleanup.json.cleaned.sort(), ids);

  // Cleaned orphans can never be finalized afterwards.
  const late = await s.api('POST', `/api/images/${b.json.objectId}/finalize`);
  assert.equal(late.status, 409);
  assert.equal(late.json.error.code, 'IMAGE_OBJECT_ORPHANED');

  // And nothing is orphaned anymore.
  const after = await s.api('GET', '/api/images/orphans?maxAgeSeconds=0');
  assert.deepEqual(after.json.orphans, []);
});

test('upload validation: MIME type and size limits are enforced with ApiError envelopes', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  const badMime = await s.api('POST', '/api/images/uploads', {
    associationKind: 'capture',
    associationId: 'cap_x',
    mimeType: 'application/pdf',
    sizeBytes: 64,
  });
  assert.equal(badMime.status, 400);
  assert.equal(badMime.json.error.code, 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(badMime.json.error.retryable, false);

  const tooBig = await s.api('POST', '/api/images/uploads', {
    associationKind: 'capture',
    associationId: 'cap_x',
    mimeType: 'image/png',
    sizeBytes: 100 * 1024 * 1024,
  });
  assert.equal(tooBig.status, 400);
  assert.equal(tooBig.json.error.code, 'UPLOAD_TOO_LARGE');
});
