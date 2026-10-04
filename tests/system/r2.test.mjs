/**
 * Integration: Cloudflare R2 upload and download round trip through the real
 * backend storage path, under a test/ key prefix that is deleted afterwards.
 * Skipped (with a message) when R2 credentials are not in ../.env.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { cleanR2Prefix, listR2, r2Available, r2ObjectStorage, startBackend } from '../support/stack.mjs';

const PREFIX = `test/it-${Date.now()}-${randomBytes(3).toString('hex')}/`;
const skip = r2Available() ? false : 'R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, OBJECT_STORAGE_CONTAINER) are not set in .env';

describe('R2 round trip under a test/ prefix', { skip }, () => {
  let s;
  after(async () => {
    await s?.close();
    if (!skip) {
      await cleanR2Prefix(PREFIX);
      assert.deepEqual(await listR2(PREFIX), [], 'the test/ prefix is empty after cleanup');
    }
  });

  it('upload via presigned PUT, finalize (verified in R2), read back via presigned GET, idempotent retry', async () => {
    s = await startBackend({ objectStorage: r2ObjectStorage(PREFIX) });
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(4096), Buffer.from([0xff, 0xd9])]);
    const req = { associationKind: 'original', associationId: 'cap_r2_roundtrip', mimeType: 'image/jpeg', sizeBytes: bytes.length };
    const auth = await s.api('POST', '/api/images/uploads', req);
    assert.equal(auth.status, 201, JSON.stringify(auth.json));
    assert.ok(auth.json.objectKey.startsWith(`${PREFIX}originals/`), auth.json.objectKey);
    assert.ok(auth.json.uploadUrl.startsWith('https://'), 'a presigned R2 URL');

    // Finalizing before the bytes arrive is refused: the backend checks R2 itself.
    assert.equal((await s.api('POST', `/api/images/${auth.json.objectId}/finalize`)).json.error.code, 'UPLOAD_NOT_COMPLETED');

    const put = await fetch(auth.json.uploadUrl, { method: 'PUT', headers: auth.json.uploadHeaders, body: bytes });
    assert.equal(put.status, 200, await put.text());
    const fin = await s.api('POST', `/api/images/${auth.json.objectId}/finalize`);
    assert.equal(fin.status, 200, JSON.stringify(fin.json));
    assert.equal(fin.json.imageObject.sizeBytes, bytes.length, 'size as stored in R2');
    assert.equal(fin.json.imageObject.state, 'finalized');

    const access = await s.api('GET', `/api/images/${auth.json.objectId}/access`);
    assert.equal(access.status, 200);
    assert.ok(Date.parse(access.json.expiresAt) > Date.now(), 'short-lived link with an expiry');
    const got = Buffer.from(await (await fetch(access.json.url)).arrayBuffer());
    assert.equal(createHash('sha256').update(got).digest('hex'), createHash('sha256').update(bytes).digest('hex'));

    // Retrying the same upload reuses the object; R2 holds exactly one copy.
    const again = await s.api('POST', '/api/images/uploads', req);
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { objectId: auth.json.objectId, objectKey: auth.json.objectKey, alreadyFinalized: true });
    assert.deepEqual(await listR2(PREFIX), [auth.json.objectKey]);

    // Server-side bytes read (what the analyzer uses) and a stored overlay land under the same prefix.
    const { bytes: server } = await s.storage.getObjectBytes(auth.json.objectKey);
    assert.equal(server.length, bytes.length);
    const overlay = await s.images.storeOverlay('cap_r2_roundtrip', 'att_1', bytes, 8, 8);
    assert.ok(overlay.objectKey.startsWith(`${PREFIX}overlays/`));
    assert.equal((await listR2(PREFIX)).length, 2);
  });
});
