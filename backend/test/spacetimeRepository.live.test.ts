/**
 * Live SpacetimeDB check of SpacetimeRepository + the module's reducers.
 * Skipped unless SPACETIMEDB_URI is set (CI has no database):
 *
 *   SPACETIMEDB_URI=http://127.0.0.1:3000 SPACETIMEDB_TOKEN=… npm test
 *
 * Every record uses a per-run prefix, so the demo hall's data is untouched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpacetimeRepository } from '../src/repo/spacetimeRepository.js';
import type {
  AnalysisAttempt,
  Attendance,
  CaptureEvent,
  FoodMeasurement,
  ImageObject,
  Insight,
  MenuBundle,
  ReferencePortion,
  SegmentationResult,
} from '../src/types.js';

const URI = process.env.SPACETIMEDB_URI;
const config = { uri: URI ?? '', module: process.env.SPACETIMEDB_MODULE || 'scrap', token: process.env.SPACETIMEDB_TOKEN };
const run = `t${Date.now().toString(36)}`;
const hall = `hall-${run}`;
const geometry = { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' as const, plateShape: 'round' as const };

const menu: MenuBundle = {
  service: {
    serviceId: `svc_${hall}_2026-10-03_lunch`,
    hallId: hall,
    hallTimezone: 'America/Detroit',
    serviceDate: '2026-10-03',
    mealLabel: 'lunch',
    menuId: `menu_${hall}_2026-10-03_lunch`,
    menuVersion: 1,
  },
  items: [
    { itemId: `item_${run}_burger`, menuId: `menu_${hall}_2026-10-03_lunch`, displayName: 'Burger', category: 'entree' },
    { itemId: `item_${run}_fries`, menuId: `menu_${hall}_2026-10-03_lunch`, displayName: 'Fries' },
  ],
};
const ref: ReferencePortion = {
  baselineId: `base_${run}_burger_v1`,
  baselineVersion: 1,
  itemId: `item_${run}_burger`,
  expectedAreaPx: 50000,
  geometry,
  source: 'manual_area',
};
const image: ImageObject = {
  objectId: `img_${run}`,
  provider: 'r2',
  container: 'scrap-images',
  objectKey: `test/${run}.jpg`,
  mimeType: 'image/jpeg',
  sizeBytes: 23182,
  widthPx: 800,
  heightPx: 536,
  association: { kind: 'capture', id: `cap_${run}` },
  state: 'pending_upload',
};
const event: CaptureEvent = {
  eventId: `cap_${run}`,
  hallId: hall,
  serviceId: menu.service.serviceId,
  capturedAt: '2026-10-03T16:00:00.000Z',
  imageObjectId: image.objectId,
  geometry,
  source: 'replay',
  qualityFlags: [],
  state: 'processing',
};
const attempt: AnalysisAttempt = {
  eventId: event.eventId,
  attemptId: `att_${run}`,
  menuId: menu.service.menuId,
  menuVersion: 1,
  baselineVersions: { [ref.itemId]: 1 },
  model: 'gemini-3.8-flash',
  promptVersion: 'v-test',
  status: 'succeeded',
  qualityFlags: ['ai_estimate'],
  createdAt: '2026-10-03T16:00:05.000Z',
};
const measurements: FoodMeasurement[] = [
  {
    measurementId: `meas_${run}_1`,
    eventId: event.eventId,
    attemptId: attempt.attemptId,
    itemId: ref.itemId,
    remainingAreaPx: 40000,
    baselineId: ref.baselineId,
    baselineAreaPx: 50000,
    rawWasteFraction: 0.8,
    displayWastePercent: 80,
    method: 'gemini_area_estimate',
    qualityFlags: ['ai_estimate'],
  },
  {
    measurementId: `meas_${run}_2`,
    eventId: event.eventId,
    attemptId: attempt.attemptId,
    itemId: null,
    remainingAreaPx: 1200,
    unavailableReason: 'unknown_item',
    method: 'gemini_area_estimate',
    qualityFlags: ['ai_estimate'],
  },
];

test('SpacetimeDB repository round-trips every entity through the reducers', { skip: !URI }, async (t) => {
  const repo = new SpacetimeRepository(config);

  await t.test('menu: upsert, read by service / hall+date+meal, re-upload replaces items', async () => {
    await repo.upsertMenu(menu);
    assert.deepEqual(await repo.getMenuByService(menu.service.serviceId), menu);
    assert.deepEqual(await repo.findMenus(hall, '2026-10-03', 'lunch'), [menu]);
    assert.deepEqual(await repo.findMenus(hall, '2026-10-04'), []);
    const revised = { service: { ...menu.service, menuVersion: 2 }, items: menu.items.slice(0, 1) };
    await repo.upsertMenu(revised);
    assert.deepEqual(await repo.getMenuByService(menu.service.serviceId), revised);
    assert.equal((await repo.listServices(hall)).length, 1);
    await repo.upsertMenu(menu);
  });

  await t.test('reference portion: upsert, list by item, delete', async () => {
    await repo.upsertReferencePortion(ref);
    assert.deepEqual(await repo.getReferencePortion(ref.baselineId), ref);
    assert.deepEqual(await repo.listReferencePortions(ref.itemId), [ref]);
    const temp = { ...ref, baselineId: `${ref.baselineId}_tmp`, baselineVersion: 2 };
    await repo.upsertReferencePortion(temp);
    assert.equal(await repo.deleteReferencePortion(temp.baselineId), true);
    assert.equal(await repo.deleteReferencePortion(temp.baselineId), false);
  });

  await t.test('image object: reference + metadata only, state transitions', async () => {
    await repo.upsertImageObject(image);
    assert.deepEqual(await repo.getImageObject(image.objectId), image);
    const finalized = { ...image, state: 'finalized' as const, uploadedAt: '2026-10-03T16:00:01.000Z' };
    await repo.upsertImageObject(finalized);
    assert.deepEqual(await repo.getImageObject(image.objectId), finalized);
    assert.ok((await repo.listImageObjects('finalized')).some((o) => o.objectId === image.objectId));
  });

  await t.test('capture event: idempotent by eventId', async () => {
    await repo.upsertCaptureEvent(event);
    await repo.upsertCaptureEvent({ ...event, state: 'succeeded' });
    const events = await repo.listCaptureEvents({ serviceId: event.serviceId });
    assert.equal(events.length, 1, 'a retry updates the same dish');
    assert.equal(events[0]?.state, 'succeeded');
  });

  await t.test('analysis: attempt + measurements saved together, unknown food keeps itemId null', async () => {
    await repo.recordAnalysis(attempt, measurements);
    assert.deepEqual(await repo.listAnalysisAttempts(event.eventId), [attempt]);
    const stored = await repo.listMeasurementsByAttempt(attempt.attemptId);
    assert.deepEqual(
      stored.sort((a, b) => a.measurementId.localeCompare(b.measurementId)),
      measurements,
    );
    assert.equal((await repo.listMeasurementsByEvent(event.eventId)).length, 2);
  });

  await t.test('analysis is atomic: one bad measurement stores nothing', async () => {
    const badAttempt = { ...attempt, attemptId: `att_${run}_bad` };
    const bad: FoodMeasurement = {
      ...measurements[0]!,
      measurementId: `meas_${run}_bad`,
      attemptId: badAttempt.attemptId,
      rawWasteFraction: 1.4, // > 1 without the above_baseline flag (§7.2)
    };
    await assert.rejects(repo.recordAnalysis(badAttempt, [bad]), /above_baseline/);
    assert.deepEqual(await repo.listMeasurementsByAttempt(badAttempt.attemptId), []);
    assert.equal((await repo.listAnalysisAttempts(event.eventId)).length, 1, 'the attempt rolled back too');
    await assert.rejects(repo.recordAnalysis(attempt, []), /already recorded/, 'attempts are append-only');
  });

  await t.test('reducers enforce the contract rules themselves', async () => {
    await assert.rejects(repo.upsertReferencePortion({ ...ref, baselineId: `base_${run}_zero`, expectedAreaPx: 0 }), /expectedAreaPx/);
    const real = { ...attendanceRow(), source: 'swipes' } as unknown as Attendance;
    await assert.rejects(repo.upsertAttendance(real), /simulated/);
  });

  await t.test('attendance (simulated) and insights', async () => {
    await repo.upsertAttendance(attendanceRow());
    assert.deepEqual(await repo.getAttendance(menu.service.serviceId), attendanceRow());
    const insight: Insight = {
      insightId: `ins_${run}`,
      hallId: hall,
      windowStart: '2026-10-03T16:00:00.000Z',
      windowEnd: '2026-10-03T16:00:00.000Z',
      metrics: { topItemName: 'Burger', topItemShareOfMealWastePercent: 97.1, analyzedCaptures: 1 },
      dataVersion: `agg-${run}`,
      recommendation: 'Try a smaller burger portion.',
      source: 'gemini',
      generatedAt: '2026-10-03T16:01:00.000Z',
    };
    await repo.upsertInsight(insight);
    assert.deepEqual(await repo.listInsights(hall), [insight]);
  });

  await t.test('mask pipeline: segmentation result + regions round-trip; the database enforces the pixel union', async () => {
    const seg: SegmentationResult = {
      model: 'sam2.1-hiera-small',
      checkpoint: 'facebook/sam2.1-hiera-small',
      codeRevision: 'sam2@test',
      promptSource: 'gemini_box',
      settingsVersion: 'sam2-box-v1',
      countingRuleVersion: 'union-v1',
      status: 'succeeded',
      countStatus: 'complete',
      capturePixelsWasted: 900,
      widthPx: 1024,
      heightPx: 1024,
      regions: [
        {
          regionId: `${run}_mask_r1`,
          eventId: event.eventId,
          attemptId: `att_${run}_mask`,
          itemId: ref.itemId,
          visualLabel: 'bitten burger',
          box: { gemini: [100, 200, 300, 400], pixelXyxy: [204.8, 102.4, 409.6, 307.2], convention: 'gemini-yxyx-1000_to_xyxy-px_v1' },
          segmentationStatus: 'succeeded',
          maskObjectId: `img_${run}_mask`,
          maskPixels: 700,
          score: 0.97,
        },
        {
          regionId: `${run}_mask_r2`,
          eventId: event.eventId,
          attemptId: `att_${run}_mask`,
          itemId: null,
          visualLabel: 'unknown crumbs',
          box: { gemini: [500, 500, 600, 600], pixelXyxy: [512, 512, 614.4, 614.4], convention: 'gemini-yxyx-1000_to_xyxy-px_v1' },
          segmentationStatus: 'succeeded',
          maskObjectId: `img_${run}_mask2`,
          maskPixels: 200,
        },
      ],
    };
    const maskAttempt: AnalysisAttempt = { ...attempt, attemptId: `att_${run}_mask`, createdAt: '2026-10-03T16:10:00.000Z', segmentation: seg };
    const maskMeasurements: FoodMeasurement[] = [
      { measurementId: `meas_${run}_m1`, eventId: event.eventId, attemptId: maskAttempt.attemptId, itemId: ref.itemId, remainingAreaPx: 700, regionIds: [`${run}_mask_r1`], unavailableReason: 'no_baseline_auxiliary_only', method: 'mask_pixel_count', qualityFlags: ['ai_estimate'] },
      { measurementId: `meas_${run}_m2`, eventId: event.eventId, attemptId: maskAttempt.attemptId, itemId: null, remainingAreaPx: 200, regionIds: [`${run}_mask_r2`], unavailableReason: 'unclassified_food', method: 'mask_pixel_count', qualityFlags: ['ai_estimate'] },
    ];
    await repo.recordAnalysis(maskAttempt, maskMeasurements);
    const stored = (await repo.listAnalysisAttempts(event.eventId)).find((a) => a.attemptId === maskAttempt.attemptId);
    assert.deepEqual(stored, maskAttempt);
    const storedMeasurements = (await repo.listMeasurementsByAttempt(maskAttempt.attemptId)).sort((a, b) => a.measurementId.localeCompare(b.measurementId));
    assert.deepEqual(storedMeasurements, maskMeasurements);

    const bad = { ...maskAttempt, attemptId: `att_${run}_mask_bad`, segmentation: { ...seg, capturePixelsWasted: 901, regions: [] } };
    const badMeasurements = maskMeasurements.map((m) => ({ ...m, measurementId: `${m.measurementId}_bad`, attemptId: bad.attemptId }));
    await assert.rejects(repo.recordAnalysis(bad, badMeasurements), /capture union 901 != sum of measured pixels 900/);
    assert.deepEqual(await repo.listMeasurementsByAttempt(bad.attemptId), [], 'the rejected attempt stored nothing');
  });

  await t.test('everything persists for a fresh connection', async () => {
    const fresh = new SpacetimeRepository(config);
    assert.deepEqual(await fresh.getMenuByService(menu.service.serviceId), menu);
    assert.equal((await fresh.listCaptureEvents({ hallId: hall })).length, 1);
    assert.equal((await fresh.listMeasurementsByEvent(event.eventId)).length, 4);
    assert.equal((await fresh.getAttendance(menu.service.serviceId))?.source, 'simulated');
  });

  await t.test('no table holds image bytes: the image row is a key + metadata', async () => {
    const row = await repo.getImageObject(image.objectId);
    const json = JSON.stringify(row);
    assert.ok(json.length < 600, 'image rows stay small');
    assert.ok(!/base64|data:image/.test(json));
  });
});

function attendanceRow(): Attendance {
  return {
    hallId: hall,
    serviceId: menu.service.serviceId,
    serviceDate: '2026-10-03',
    count: 742,
    source: 'simulated',
    configuredMin: 300,
    configuredMax: 1200,
    seed: 'demo-seed-1',
    generatorVersion: 'attendance-gen-v1',
  };
}
