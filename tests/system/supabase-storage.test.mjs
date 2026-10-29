/**
 * Integration: Supabase Storage upload and download round trip through the
 * real backend storage path, under a test/ key prefix that is deleted
 * afterwards. Also checks the bucket is private to the anon key.
 * Skipped (with a message) when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not in ../.env.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { cleanSupabasePrefix, listSupabase, startBackend, supabaseAvailable, supabaseObjectStorage, REPO } from '../support/stack.mjs';

const PREFIX = `test/it-${Date.now()}-${randomBytes(3).toString('hex')}/`;
const skip = supabaseAvailable() ? false : 'SUPABASE_URL (https://<ref>.supabase.co) and SUPABASE_SERVICE_ROLE_KEY are not set in .env';

describe('Supabase Storage round trip under a test/ prefix', { skip }, () => {
  let s;
  after(async () => {
    await s?.close();
    if (!skip) {
      await cleanSupabasePrefix(PREFIX);
      assert.deepEqual(await listSupabase(PREFIX), [], 'the test/ prefix is empty after cleanup');
    }
  });

  it('upload via signed PUT, finalize (verified in Storage), read back via signed GET, idempotent retry', async () => {
    s = await startBackend({ objectStorage: supabaseObjectStorage(PREFIX) });
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(4096), Buffer.from([0xff, 0xd9])]);
    const req = { associationKind: 'original', associationId: 'cap_sb_roundtrip', mimeType: 'image/jpeg', sizeBytes: bytes.length };
    const auth = await s.api('POST', '/api/images/uploads', req);
    assert.equal(auth.status, 201, JSON.stringify(auth.json));
    assert.ok(auth.json.objectKey.startsWith(`${PREFIX}originals/`), auth.json.objectKey);
    assert.match(auth.json.uploadUrl, /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/upload\/sign\//);

    // Finalizing before the bytes arrive is refused: the backend checks Storage itself.
    assert.equal((await s.api('POST', `/api/images/${auth.json.objectId}/finalize`)).json.error.code, 'UPLOAD_NOT_COMPLETED');

    const put = await fetch(auth.json.uploadUrl, { method: 'PUT', headers: auth.json.uploadHeaders, body: bytes });
    assert.equal(put.status, 200, await put.text());
    const fin = await s.api('POST', `/api/images/${auth.json.objectId}/finalize`);
    assert.equal(fin.status, 200, JSON.stringify(fin.json));
    assert.equal(fin.json.imageObject.sizeBytes, bytes.length, 'size as stored in Supabase Storage');
    assert.equal(fin.json.imageObject.state, 'finalized');
    assert.equal(fin.json.imageObject.provider, 'supabase');
    assert.equal(fin.json.imageObject.objectKey, auth.json.objectKey, 'the record keeps the path, not a URL');

    const access = await s.api('GET', `/api/images/${auth.json.objectId}/access`);
    assert.equal(access.status, 200);
    const ttlMs = Date.parse(access.json.expiresAt) - Date.now();
    assert.ok(ttlMs > 0 && ttlMs <= 10 * 60_000 + 5_000, 'short-lived link (10 minutes by default)');
    const got = Buffer.from(await (await fetch(access.json.url)).arrayBuffer());
    assert.equal(createHash('sha256').update(got).digest('hex'), createHash('sha256').update(bytes).digest('hex'));

    // Retrying the same upload reuses the object; Storage holds exactly one copy.
    const again = await s.api('POST', '/api/images/uploads', req);
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { objectId: auth.json.objectId, objectKey: auth.json.objectKey, alreadyFinalized: true });
    assert.deepEqual(await listSupabase(PREFIX), [auth.json.objectKey]);

    // Server-side bytes read (what the analyzer uses) and a stored overlay land under the same prefix.
    const { bytes: server } = await s.storage.getObjectBytes(auth.json.objectKey);
    assert.equal(server.length, bytes.length);
    const overlay = await s.images.storeOverlay('cap_sb_roundtrip', 'att_1', bytes, 8, 8);
    assert.ok(overlay.objectKey.startsWith(`${PREFIX}overlays/`));
    assert.equal((await listSupabase(PREFIX)).length, 2);

    // The bucket is private: the anon key can neither read nor write objects directly.
    if (process.env.SUPABASE_ANON_KEY) {
      const { createClient } = createRequire(`${REPO}backend/package.json`)('@supabase/supabase-js');
      const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } }).storage.from('scrap-images');
      assert.equal((await anon.download(auth.json.objectKey)).data, null, 'anon cannot download');
      assert.ok((await anon.upload(`${PREFIX}anon.jpg`, bytes, { contentType: 'image/jpeg' })).error, 'anon cannot upload');
    }
  });
});
