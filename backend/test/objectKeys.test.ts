/**
 * R2 key naming and upload idempotency (end-to-end pipeline): one normalized
 * image and one raw original per capture event, deterministic keys under an
 * optional prefix, and retries that reuse the same object instead of
 * registering a duplicate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { keyPrefix } from '../src/config.js';
import { makeObjectKey } from '../src/storage/objectStorage.js';
import { startTestServer } from './helpers.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');

test('keys: one folder per kind, deterministic for captures and originals', () => {
  const base = { associationId: 'cap_01', mimeType: 'image/jpeg', declaredSizeBytes: 10 };
  assert.equal(makeObjectKey({ ...base, associationKind: 'capture' }, NOW), 'captures/2026-10-04/cap_01.jpg');
  assert.equal(makeObjectKey({ ...base, associationKind: 'original' }, NOW), 'originals/2026-10-04/cap_01.jpg');
  // Same request, same key: a retried upload overwrites, never duplicates.
  assert.equal(
    makeObjectKey({ ...base, associationKind: 'original' }, NOW),
    makeObjectKey({ ...base, associationKind: 'original' }, NOW),
  );
  // References may be re-photographed, so they keep a random suffix.
  assert.match(makeObjectKey({ ...base, associationKind: 'reference' }, NOW), /^references\/2026-10-04\/cap_01_[0-9a-f]{12}\.jpg$/);
  assert.equal(
    makeObjectKey({ ...base, associationKind: 'capture', mimeType: 'image/png', keyPrefix: 'test/' }, NOW),
    'test/captures/2026-10-04/cap_01.png',
  );
});

test('R2_KEY_PREFIX: empty, normalized to end in "/", or rejected', () => {
  assert.equal(keyPrefix(undefined), '');
  assert.equal(keyPrefix(''), '');
  assert.equal(keyPrefix('test'), 'test/');
  assert.equal(keyPrefix('test/run-1/'), 'test/run-1/');
  for (const bad of ['../x', '/test', 'te st', 'a//b']) assert.throws(() => keyPrefix(bad), /R2_KEY_PREFIX/);
});

test('uploads are idempotent per capture and kind; originals are their own kind', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const body = { associationKind: 'original', associationId: 'cap_idem', mimeType: 'image/jpeg', sizeBytes: 16 };

  const first = await s.api('POST', '/api/images/uploads', body);
  assert.equal(first.status, 201);
  assert.match(first.json.objectKey, /^originals\/\d{4}-\d{2}-\d{2}\/cap_idem\.jpg$/);

  // Retry before the bytes arrive: same record, fresh upload URL.
  const retry = await s.api('POST', '/api/images/uploads', body);
  assert.equal(retry.status, 201);
  assert.equal(retry.json.objectId, first.json.objectId);
  assert.equal(retry.json.objectKey, first.json.objectKey);

  const put = await fetch(`${s.baseUrl}${retry.json.uploadUrl}`, {
    method: 'PUT',
    headers: { 'content-type': 'image/jpeg' },
    body: Buffer.alloc(16, 1),
  });
  assert.equal(put.status, 204);
  assert.equal((await s.api('POST', `/api/images/${first.json.objectId}/finalize`)).status, 200);

  // Retry after it finished: nothing to upload, same object, no new record.
  const after = await s.api('POST', '/api/images/uploads', body);
  assert.equal(after.status, 200);
  assert.deepEqual(after.json, { objectId: first.json.objectId, objectKey: first.json.objectKey, alreadyFinalized: true });
  const originals = await s.repo.findImageObjectsByAssociation('original', 'cap_idem');
  assert.equal(originals.length, 1);

  // The normalized image for the same event is a separate object.
  const normalized = await s.api('POST', '/api/images/uploads', { ...body, associationKind: 'capture' });
  assert.notEqual(normalized.json.objectId, first.json.objectId);
  assert.match(normalized.json.objectKey, /^captures\//);
});
