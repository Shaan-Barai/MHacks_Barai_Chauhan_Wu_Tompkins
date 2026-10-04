import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type CaptureResult, ReplayCaptureAdapter } from '../src/adapter.js';
import { CaptureErrorCodes } from '../src/errors.js';
import { InMemoryIngestionSink } from '../src/ingestion.js';
import { InMemoryUploader } from '../src/uploader.js';
import { HALL, SERVICE, makeFixtureDir, makeFile, makeJpeg, writeManifest } from './helpers.js';

function newAdapter() {
  const uploader = new InMemoryUploader();
  const sink = new InMemoryIngestionSink();
  const adapter = new ReplayCaptureAdapter(uploader, sink);
  return { uploader, sink, adapter };
}

test('each manifest entry is ingested exactly once, even when re-run', async () => {
  const dir = await makeFixtureDir();
  await makeJpeg(dir, 'a.jpg');
  await makeJpeg(dir, 'b.jpg', 400, 400, [40, 160, 90]);
  const manifestPath = await writeManifest(dir, {
    manifestVersion: 1,
    hallId: HALL,
    serviceId: SERVICE,
    entries: [
      { entryId: 'dish-1', imagePath: 'a.jpg' },
      { entryId: 'dish-2', imagePath: 'b.jpg' },
    ],
  });

  const { uploader, sink, adapter } = newAdapter();

  const first = await adapter.ingestManifestFile(manifestPath);
  assert.equal(first.length, 2);
  assert.ok(first.every((r) => r.ok), 'all entries ingest successfully');
  assert.equal(sink.events().length, 2, 'one event per dish');
  assert.equal(sink.submissionCount, 2);
  assert.equal(uploader.finalizedOfKind('capture').length, 2, 'one normalized image per dish');
  assert.equal(uploader.finalizedOfKind('original').length, 2, 'one raw original per dish');

  // Re-run the same manifest: no new dishes, no new uploads, no re-submission.
  const second = await adapter.ingestManifestFile(manifestPath);
  assert.ok(second.every((r) => r.ok && r.alreadyIngested));
  assert.equal(sink.events().length, 2, 'still one event per dish');
  assert.equal(sink.submissionCount, 2, 'no duplicate submissions');
  assert.equal(uploader.finalizedCount(), 4, 'no duplicate uploads (raw + normalized per dish)');

  // Same event IDs on both runs.
  const ids = (rs: CaptureResult[]) => rs.map((r) => (r.ok ? r.event.eventId : '')).sort();
  assert.deepEqual(ids(second), ids(first));
});

test('identical image bytes under different entry IDs are two dishes', async () => {
  const dir = await makeFixtureDir();
  await makeJpeg(dir, 'same.jpg');
  const manifestPath = await writeManifest(dir, {
    manifestVersion: 1,
    hallId: HALL,
    serviceId: SERVICE,
    entries: [
      { entryId: 'dish-1', imagePath: 'same.jpg' },
      { entryId: 'dish-2', imagePath: 'same.jpg' },
    ],
  });

  const { sink, adapter } = newAdapter();
  const results = await adapter.ingestManifestFile(manifestPath);
  assert.ok(results.every((r) => r.ok));
  assert.equal(sink.events().length, 2, 'identical bytes do not collapse two declared dishes');
  const [a, b] = results;
  assert.ok(a?.ok && b?.ok);
  assert.notEqual(a.event.eventId, b.event.eventId);
});

test('a retried entry keeps the same event ID after a transient upload failure', async () => {
  const dir = await makeFixtureDir();
  await makeJpeg(dir, 'a.jpg');
  const manifestPath = await writeManifest(dir, {
    manifestVersion: 1,
    hallId: HALL,
    serviceId: SERVICE,
    entries: [{ entryId: 'dish-1', imagePath: 'a.jpg' }],
  });

  const { uploader, sink, adapter } = newAdapter();
  uploader.failNextUpload(1);

  const [failed] = await adapter.ingestManifestFile(manifestPath);
  assert.ok(failed && !failed.ok, 'first attempt fails');
  assert.equal(failed.error.retryable, true);
  const mintedEventId = failed.error.details?.eventId;
  assert.ok(typeof mintedEventId === 'string' && mintedEventId.startsWith('cap_'));
  assert.equal(sink.events().length, 0, 'no event submitted for the failed attempt');

  const [retried] = await adapter.ingestManifestFile(manifestPath);
  assert.ok(retried?.ok, 'retry succeeds');
  assert.equal(retried.event.eventId, mintedEventId, 'retry re-uses the minted event ID');
  assert.equal(retried.alreadyIngested, false);
  assert.equal(sink.events().length, 1, 'exactly one event after the retry');
});

test('events carry normalized geometry, UTC timestamps, context, and source label', async () => {
  const dir = await makeFixtureDir();
  await makeJpeg(dir, 'a.jpg', 640, 480);
  const manifestPath = await writeManifest(dir, {
    manifestVersion: 1,
    hallId: HALL,
    serviceId: SERVICE,
    entries: [
      {
        entryId: 'dish-1',
        imagePath: 'a.jpg',
        capturedAt: '2026-10-03T12:42:09-04:00',
        plateShape: 'round',
        plateDiameterPx: 900,
      },
    ],
  });

  const { uploader, sink, adapter } = newAdapter();
  const [result] = await adapter.ingestManifestFile(manifestPath);
  assert.ok(result?.ok);
  const event = result.event;

  assert.deepEqual(event.geometry, {
    widthPx: 1024,
    heightPx: 1024,
    coordinateSpace: 'topdown-normalized-v1',
    plateShape: 'round',
    plateDiameterPx: 900,
  });
  assert.equal(event.capturedAt, '2026-10-03T16:42:09.000Z', 'stored as UTC ISO');
  assert.equal(event.hallId, HALL);
  assert.equal(event.serviceId, SERVICE);
  assert.equal(event.source, 'replay');
  assert.equal(event.state, 'pending');
  assert.ok(event.eventId.startsWith('cap_'));
  assert.equal(sink.get(event.eventId)?.imageObjectId, event.imageObjectId);
  assert.ok(uploader.getObjectBytes(event.imageObjectId), 'normalized bytes reached storage');
});

test('declared quality flags propagate to the capture event', async () => {
  const dir = await makeFixtureDir();
  await makeJpeg(dir, 'a.jpg');
  const manifestPath = await writeManifest(dir, {
    manifestVersion: 1,
    hallId: HALL,
    serviceId: SERVICE,
    entries: [
      { entryId: 'dish-1', imagePath: 'a.jpg', declaredFlags: ['blurred', 'multiple_dishes'] },
    ],
  });

  const { adapter } = newAdapter();
  const [result] = await adapter.ingestManifestFile(manifestPath);
  assert.ok(result?.ok);
  assert.deepEqual(result.event.qualityFlags, ['blurred', 'multiple_dishes']);
});

test('unusable inputs produce actionable per-entry errors, never silent drops', async () => {
  const dir = await makeFixtureDir();
  await makeJpeg(dir, 'good.jpg');
  await makeFile(dir, 'notes.txt', 'this is not an image');
  await makeFile(dir, 'corrupt.jpg', new Uint8Array([0xff, 0xd8, 0x00, 0x01, 0x02])); // truncated JPEG
  const manifestPath = await writeManifest(dir, {
    manifestVersion: 1,
    hallId: HALL,
    serviceId: SERVICE,
    entries: [
      { entryId: 'ok', imagePath: 'good.jpg' },
      { entryId: 'wrong-type', imagePath: 'notes.txt' },
      { entryId: 'corrupt', imagePath: 'corrupt.jpg' },
      { entryId: 'missing', imagePath: 'nope.jpg' },
    ],
  });

  const { sink, adapter } = newAdapter();
  const results = await adapter.ingestManifestFile(manifestPath);
  assert.equal(results.length, 4, 'every entry gets a result');

  const byId = new Map(results.map((r) => [r.entryId, r]));
  assert.ok(byId.get('ok')?.ok);

  const wrongType = byId.get('wrong-type');
  assert.ok(wrongType && !wrongType.ok);
  assert.equal(wrongType.error.code, CaptureErrorCodes.UNSUPPORTED_IMAGE_TYPE);
  assert.equal(wrongType.error.retryable, false);

  const corrupt = byId.get('corrupt');
  assert.ok(corrupt && !corrupt.ok);
  assert.equal(corrupt.error.code, CaptureErrorCodes.IMAGE_UNREADABLE);

  const missing = byId.get('missing');
  assert.ok(missing && !missing.ok);
  assert.equal(missing.error.code, CaptureErrorCodes.IMAGE_FILE_MISSING);
  assert.ok(missing.error.message.length > 0, 'actionable message present');

  assert.equal(sink.events().length, 1, 'only the usable capture was ingested');
});

test('manual upload: same entryId retries the dish; no entryId means a new dish', async () => {
  const dir = await makeFixtureDir();
  const img = await makeJpeg(dir, 'tray.jpg');

  const { sink, adapter } = newAdapter();

  const first = await adapter.ingestFile({
    imagePath: img,
    hallId: HALL,
    serviceId: SERVICE,
    entryId: 'upload-1',
  });
  const retry = await adapter.ingestFile({
    imagePath: img,
    hallId: HALL,
    serviceId: SERVICE,
    entryId: 'upload-1',
  });
  assert.ok(first.ok && retry.ok);
  assert.equal(retry.event.eventId, first.event.eventId);
  assert.equal(retry.alreadyIngested, true);
  assert.equal(first.event.source, 'manual_upload');
  assert.equal(sink.events().length, 1);

  const fresh = await adapter.ingestFile({ imagePath: img, hallId: HALL, serviceId: SERVICE });
  assert.ok(fresh.ok);
  assert.notEqual(fresh.event.eventId, first.event.eventId);
  assert.equal(sink.events().length, 2, 'identical bytes alone are not a duplicate dish');
});
