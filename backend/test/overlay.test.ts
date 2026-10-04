/**
 * BIG-PLAN D7 persistence: the segmented overlay JPEG. BIG-PLAN v2: there is no
 * plate calibration; a stale analyzer's calibration is never persisted, while
 * legacy rows that carry one still parse. Offline (mock analyzer, local-dev
 * storage, in-memory repo).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonFileRepository } from '../src/repo/jsonFileRepository.js';
import { MockAnalyzer, type MockFixture } from '../src/analysis/mockAnalyzer.js';
import type { Analyzer } from '../src/analysis/analyzer.js';
import { startTestServer } from './helpers.js';
import type { PlateCalibration } from '../src/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A legacy (pre-v2) calibration, as old rows may still carry. */
const FIT: PlateCalibration = {
  method: 'plate-fit-v1',
  plateDiameterCm: 26.7,
  plateDiameterPx: 800,
  cm2PerPx: (26.7 / 800) ** 2,
  dishType: 'plate',
  fullyVisible: true,
  flags: [],
};

/** A tiny byte string with a JPEG SOI marker: enough for storage + the type check. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

test('ingestion stores the overlay JPEG in object storage; no calibration on the attempt', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  const eventId = 'cap_overlay_1';
  s.fixtures[eventId] = {
    measurements: [
      { itemId: 'item_eggs', remainingAreaPx: 12000 },
      { itemId: null, remainingAreaPx: 500 },
    ],
    overlay: { jpeg: JPEG, widthPx: 1024, heightPx: 1024 },
  };
  const imageId = await s.uploadImage(eventId);
  const res = await s.submitCapture(eventId, imageId);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const attempt = res.json.attempt;
  assert.equal(attempt.calibration, undefined);
  assert.match(attempt.overlayObjectId, /^img_/);

  const overlay = await s.repo.getImageObject(attempt.overlayObjectId);
  assert.ok(overlay);
  assert.deepEqual(overlay.association, { kind: 'overlay', id: eventId });
  assert.equal(overlay.mimeType, 'image/jpeg');
  assert.equal(overlay.state, 'finalized');
  assert.match(overlay.objectKey, new RegExp(`^overlays/\\d{4}-\\d{2}-\\d{2}/${eventId}_${attempt.attemptId}\\.jpg$`));
  assert.equal(overlay.sizeBytes, JPEG.length);

  // Round-trip through the repository read path used by every endpoint.
  const [stored] = await s.repo.listAnalysisAttempts(eventId);
  assert.equal(stored?.calibration, undefined);
  assert.equal(stored?.overlayObjectId, attempt.overlayObjectId);

  // Images endpoint: original + overlay + one mask per food, all short-lived URLs.
  const images = await s.api('GET', `/api/captures/${eventId}/images`);
  assert.equal(images.status, 200, JSON.stringify(images.json));
  assert.equal(images.json.eventId, eventId);
  assert.equal(images.json.original.objectId, imageId);
  assert.equal(images.json.overlay.objectId, attempt.overlayObjectId);
  for (const img of [images.json.original, images.json.overlay, ...images.json.masks]) {
    assert.equal(typeof img.url, 'string');
    assert.ok(Date.parse(img.expiresAt) > Date.now(), 'URL expiry is in the future');
  }
  assert.deepEqual(
    images.json.masks.map((m: any) => [m.itemId, m.displayName]).sort(),
    [['item_eggs', 'Scrambled Eggs'], [null, 'Food not on the menu']].sort(),
  );
  const bytes = new Uint8Array(await (await fetch(`${s.baseUrl}${images.json.overlay.url}`)).arrayBuffer());
  assert.deepEqual([...bytes], [...JPEG], 'the overlay URL serves the stored JPEG');

  // Idempotent re-ingestion: no new attempt, no second overlay object.
  const again = await s.submitCapture(eventId, imageId);
  assert.equal(again.status, 200);
  assert.equal(again.json.deduplicated, true);
  const overlays = (await s.repo.listImageObjects()).filter((o) => o.association.kind === 'overlay');
  assert.equal(overlays.length, 1);
  assert.equal((await s.repo.listAnalysisAttempts(eventId)).length, 1);
});

test('missing overlay: counts still stored, images endpoint returns overlay null', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  const eventId = 'cap_no_overlay';
  s.fixtures[eventId] = { measurements: [{ itemId: 'item_toast', remainingAreaPx: 3000 }], overlay: null };
  const res = await s.submitCapture(eventId, await s.uploadImage(eventId));
  assert.equal(res.status, 201);
  assert.equal(res.json.event.state, 'succeeded');
  assert.equal(res.json.attempt.calibration, undefined);
  assert.equal(res.json.attempt.overlayObjectId, undefined);
  assert.equal(res.json.measurements[0].remainingAreaPx, 3000);
  const images = await s.api('GET', `/api/captures/${eventId}/images`);
  assert.equal(images.status, 200);
  assert.equal(images.json.overlay, null);
  assert.ok(images.json.original);
  assert.equal(images.json.masks.length, 1);

  const missing = await s.api('GET', '/api/captures/cap_does_not_exist/images');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'CAPTURE_NOT_FOUND');
});

/** A pre-v2 analyzer that still reports a plate calibration on its attempt. */
function staleCalibrationAnalyzer(fixtures: Record<string, MockFixture>): Analyzer {
  const mock = new MockAnalyzer(fixtures);
  return {
    async analyze(input) {
      const result = await mock.analyze(input);
      return { ...result, attempt: { ...result.attempt, calibration: FIT } };
    },
  };
}

test('a malformed overlay never fails a valid count; a stale calibration is ignored, not persisted', async (t) => {
  const fixtures: Record<string, MockFixture> = {};
  const s = await startTestServer(staleCalibrationAnalyzer(fixtures));
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  const eventId = 'cap_bad_overlay';
  fixtures[eventId] = {
    measurements: [{ itemId: 'item_eggs', remainingAreaPx: 100 }],
    overlay: { jpeg: new Uint8Array([1, 2, 3, 4]), widthPx: 1024, heightPx: 1024 }, // not a JPEG
  };
  const res = await s.submitCapture(eventId, await s.uploadImage(eventId));
  assert.equal(res.status, 201);
  assert.equal(res.json.event.state, 'succeeded');
  assert.equal(res.json.measurements[0].remainingAreaPx, 100);
  assert.equal(res.json.attempt.calibration, undefined, 'v2 never persists a calibration');
  assert.equal((await s.repo.listAnalysisAttempts(eventId))[0]?.calibration, undefined);
  assert.equal(res.json.attempt.overlayObjectId, undefined);
  assert.equal((await s.repo.listImageObjects()).filter((o) => o.association.kind === 'overlay').length, 0);
});

test('JSON snapshot repository round-trips overlayObjectId and a legacy calibration', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'scrap-json-')), 'db.json');
  const repo = new JsonFileRepository(file);
  const attempt = {
    eventId: 'cap_json',
    attemptId: 'att_json',
    menuId: 'menu_x',
    menuVersion: 1,
    baselineVersions: {},
    model: 'm',
    promptVersion: 'p',
    status: 'succeeded' as const,
    qualityFlags: [],
    createdAt: '2026-10-03T16:00:00.000Z',
    calibration: FIT,
    overlayObjectId: 'img_overlay',
  };
  await repo.recordAnalysis(attempt, []);
  const reloaded = new JsonFileRepository(file);
  assert.deepEqual(await reloaded.listAnalysisAttempts('cap_json'), [attempt]);
});
