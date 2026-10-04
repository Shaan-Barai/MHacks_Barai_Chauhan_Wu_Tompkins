/**
 * Scan records (contracts ScanInfo): the raw original must be a finalized
 * 'original' upload for the same capture; the scan row is stored before
 * analysis and the gallery endpoint signs the raw photo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { GEOMETRY, HALL, SERVICE, startTestServer, type TestServer } from './helpers.js';

const SHA = 'a'.repeat(64);

async function uploadOriginal(s: TestServer, eventId: string, finalize = true): Promise<string> {
  const req = await s.api('POST', '/api/images/uploads', {
    associationKind: 'original',
    associationId: eventId,
    mimeType: 'image/jpeg',
    sizeBytes: 32,
  });
  assert.equal(req.status, 201, JSON.stringify(req.json));
  const put = await fetch(`${s.baseUrl}${req.json.uploadUrl}`, {
    method: 'PUT',
    headers: { 'content-type': 'image/jpeg' },
    body: Buffer.alloc(32, 7),
  });
  assert.equal(put.status, 204);
  if (finalize) assert.equal((await s.api('POST', `/api/images/${req.json.objectId}/finalize`)).status, 200);
  return req.json.objectId as string;
}

function submit(s: TestServer, eventId: string, imageObjectId: string, scan: unknown) {
  return s.api('POST', '/api/captures', {
    eventId,
    hallId: HALL,
    serviceId: SERVICE,
    capturedAt: '2026-10-04T16:42:09Z',
    imageObjectId,
    geometry: GEOMETRY,
    source: 'camera',
    scan,
  });
}

test('a scan with its raw original is stored and the raw photo is signed', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  const imageObjectId = await s.uploadImage('cap_scan_1');
  const originalImageObjectId = await uploadOriginal(s, 'cap_scan_1');

  const res = await submit(s, 'cap_scan_1', imageObjectId, {
    deviceId: 'uno-q-c920',
    timestampBasis: 'laptop_trigger',
    originalImageObjectId,
    originalSha256: SHA,
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.deepEqual(await s.repo.getScanInfo('cap_scan_1'), {
    eventId: 'cap_scan_1',
    deviceId: 'uno-q-c920',
    timestampBasis: 'laptop_trigger',
    originalImageObjectId,
    originalSha256: SHA,
    demo: false,
  });

  const images = await s.api('GET', '/api/captures/cap_scan_1/images');
  assert.equal(images.status, 200);
  assert.equal(images.json.raw.objectId, originalImageObjectId);
  assert.notEqual(images.json.original.objectId, originalImageObjectId);
  assert.equal(images.json.scan.deviceId, 'uno-q-c920');
});

test('a raw original that is unfinished or belongs to another capture is rejected', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();

  const imageA = await s.uploadImage('cap_scan_a');
  const unfinished = await uploadOriginal(s, 'cap_scan_a', false);
  const r1 = await submit(s, 'cap_scan_a', imageA, { deviceId: 'd', timestampBasis: 'laptop_trigger', originalImageObjectId: unfinished });
  assert.equal(r1.status, 400);
  assert.equal(r1.json.error.code, 'ORIGINAL_NOT_FINALIZED');

  const otherOriginal = await uploadOriginal(s, 'cap_scan_other');
  const r2 = await submit(s, 'cap_scan_a', imageA, { deviceId: 'd', timestampBasis: 'laptop_trigger', originalImageObjectId: otherOriginal });
  assert.equal(r2.status, 400);
  assert.equal(r2.json.error.code, 'IMAGE_ASSOCIATION_MISMATCH');
  assert.equal(await s.repo.getScanInfo('cap_scan_a'), undefined);
});

test('bad scan fields and client-sent demo scans are rejected', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  const imageObjectId = await s.uploadImage('cap_scan_bad');
  for (const scan of [
    { timestampBasis: 'laptop_trigger' },
    { deviceId: 'd', timestampBasis: 'board_frame_received' },
    { deviceId: 'd', timestampBasis: 'laptop_trigger', originalSha256: 'xyz' },
  ]) {
    const r = await submit(s, 'cap_scan_bad', imageObjectId, scan);
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'INVALID_SCAN');
  }
  const demo = await s.api('POST', '/api/captures', {
    eventId: 'cap_scan_bad', hallId: HALL, serviceId: SERVICE, capturedAt: '2026-10-04T16:42:09Z',
    imageObjectId, geometry: GEOMETRY, source: 'demo',
  });
  assert.equal(demo.status, 400);
  assert.equal(demo.json.error.code, 'INVALID_CAPTURE');
});
