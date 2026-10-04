/**
 * The single ingest path (ingestPhoto): raw original + normalized image,
 * scan details, checksum guard, and retries that never duplicate a scan.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import sharp from 'sharp';

import { ReplayCaptureAdapter, type IngestPhotoInput } from '../src/adapter.js';
import { InMemoryIngestionSink } from '../src/ingestion.js';
import { InMemoryUploader } from '../src/uploader.js';
import { HALL, SERVICE, makeFixtureDir, makeJpeg } from './helpers.js';

async function setup() {
  const dir = await makeFixtureDir();
  const photoPath = await makeJpeg(dir, 'IMG_0001.jpeg', 1600, 1200, [180, 120, 60]);
  const uploader = new InMemoryUploader();
  const sink = new InMemoryIngestionSink();
  const adapter = new ReplayCaptureAdapter(uploader, sink);
  const input: IngestPhotoInput = {
    photoPath,
    captureKey: 'run-1:IMG_0001.jpeg',
    capturedAt: '2026-10-04T16:00:00.000Z',
    timestampBasis: 'laptop_ingest',
    hallId: HALL,
    serviceId: SERVICE,
    source: 'replay',
    deviceId: 'simulated:test2',
    sourceName: 'IMG_0001.jpeg',
  };
  return { photoPath, uploader, sink, adapter, input };
}

test('one photo: raw original kept byte for byte, normalized image analyzed, scan details sent', async () => {
  const { photoPath, uploader, sink, adapter, input } = await setup();
  const raw = await readFile(photoPath);
  const result = await adapter.ingestPhoto(input);
  assert.ok(result.ok);

  const [original] = uploader.finalizedOfKind('original');
  const [normalized] = uploader.finalizedOfKind('capture');
  assert.ok(original && normalized);
  assert.equal(original.associationId, result.event.eventId);
  assert.deepEqual(Buffer.from(original.bytes), raw, 'the original is the untouched file');
  const meta = await sharp(normalized.bytes).metadata();
  assert.deepEqual([meta.width, meta.height], [1024, 1024]);
  assert.equal(result.event.imageObjectId, normalized.objectId);
  assert.equal(result.event.source, 'replay');
  assert.equal(result.event.capturedAt, input.capturedAt);

  assert.deepEqual(sink.scans.get(result.event.eventId), {
    deviceId: 'simulated:test2',
    timestampBasis: 'laptop_ingest',
    sourceName: 'IMG_0001.jpeg',
    originalImageObjectId: original.objectId,
    originalSha256: createHash('sha256').update(raw).digest('hex'),
  });
});

test('a photo that fails its checksum uploads nothing', async () => {
  const { uploader, sink, adapter, input } = await setup();
  const result = await adapter.ingestPhoto({ ...input, expectedSha256: '0'.repeat(64) });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'CHECKSUM_MISMATCH');
  assert.equal(uploader.finalizedCount(), 0);
  assert.equal(sink.submissionCount, 0);
});

test('retries never duplicate a scan: same key, same eventId, same objects', async () => {
  const { uploader, sink, adapter, input } = await setup();
  uploader.failNextUpload(1); // the first upload attempt fails mid-way
  const failed = await adapter.ingestPhoto(input);
  assert.equal(failed.ok, false);
  const retried = await adapter.ingestPhoto(input);
  assert.ok(retried.ok && !retried.alreadyIngested);
  const again = await adapter.ingestPhoto(input);
  assert.ok(again.ok && again.alreadyIngested);
  assert.equal(again.event.eventId, retried.event.eventId);
  assert.equal(uploader.finalizedOfKind('original').length, 1);
  assert.equal(uploader.finalizedOfKind('capture').length, 1);
  assert.equal(sink.events().length, 1);

  // A different key is a different scan, even for the same file.
  const other = await adapter.ingestPhoto({ ...input, captureKey: 'run-2:IMG_0001.jpeg' });
  assert.ok(other.ok && other.event.eventId !== retried.event.eventId);
});
