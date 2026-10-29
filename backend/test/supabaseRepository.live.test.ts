/**
 * Live Supabase check of SupabaseRepository + the Postgres write functions:
 * the same round trip as spacetimeRepository.live.test.ts, through Postgres.
 * OPT-IN: skipped unless SCRAP_LIVE_REPO_TEST=1, SUPABASE_URL (the API
 * address) and SUPABASE_SERVICE_ROLE_KEY are set. It writes throwaway
 * `hall-t…` rows with a per-run prefix and deletes them at the end.
 *
 *   SCRAP_LIVE_REPO_TEST=1 npm test        (with SUPABASE_* in the environment)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { SupabaseRepository } from '../src/repo/supabaseRepository.js';
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
  PlateCalibration,
} from '../src/types.js';

const URL_OK = /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(process.env.SUPABASE_URL ?? '');
const ENABLED = process.env.SCRAP_LIVE_REPO_TEST === '1' && URL_OK && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const config = { url: process.env.SUPABASE_URL ?? '', serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '' };
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

test('Supabase repository round-trips every entity through Postgres', { skip: ENABLED ? false : 'opt-in: set SCRAP_LIVE_REPO_TEST=1, SUPABASE_URL (https://<ref>.supabase.co) and SUPABASE_SERVICE_ROLE_KEY' }, async (t) => {
  const repo = new SupabaseRepository(config);
  t.after(cleanup);

  await t.test('menu: upsert, read by service / hall+date+meal, re-upload replaces items', async () => {
    await repo.upsertMenu(menu);
    assert.deepEqual(await repo.getMenuByService(menu.service.serviceId), menu);
    assert.deepEqual(await repo.findMenus(hall, '2026-10-03', 'lunch'), [menu]);
    assert.deepEqual(await repo.findMenus(hall, '2026-10-04'), []);
    const revised = { service: { ...menu.service, menuVersion: 2 }, items: menu.items.slice(0, 1) };
    await repo.upsertMenu(revised);
    assert.deepEqual(await repo.getMenuByService(menu.service.serviceId), revised);
    assert.equal((await repo.listServices(hall)).length, 1);
    // Revisions only move forward: re-sending the older version is a conflict, not a rollback.
    await assert.rejects(repo.upsertMenu(menu), /newer version of this menu/);
    assert.deepEqual(await repo.getMenuItem(`item_${run}_fries`), menu.items[1], 'the dropped item resolves from the revision archive');
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
      countingRuleVersion: 'smallest-first-v1',
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
    // The pipeline registers each mask image (ImageService.storeMask) before recording the analysis.
    for (const regionId of ['mask', 'mask2']) {
      await repo.upsertImageObject({ ...image, objectId: `img_${run}_${regionId}`, objectKey: `masks/2026-10-03/${run}_${regionId}.png`, mimeType: 'image/png', association: { kind: 'mask', id: `${run}_${regionId}` }, state: 'finalized' });
    }
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

  await t.test('calibration + overlay reference round-trip with their attempt (BIG-PLAN D2/D7)', async () => {
    const overlay: ImageObject = {
      ...image,
      objectId: `img_${run}_overlay`,
      objectKey: `overlays/2026-10-03/${event.eventId}_att_${run}_cal.jpg`,
      mimeType: 'image/jpeg',
      association: { kind: 'overlay', id: event.eventId },
      state: 'finalized',
      uploadedAt: '2026-10-03T16:20:01.000Z',
    };
    await repo.upsertImageObject(overlay);
    assert.deepEqual(await repo.getImageObject(overlay.objectId), overlay);
    const calibration: PlateCalibration = {
      method: 'plate-fit-v1',
      plateDiameterCm: 26.7,
      plateDiameterPx: 812.5,
      cm2PerPx: (26.7 / 812.5) ** 2,
      dishType: 'plate',
      fullyVisible: false,
      flags: ['plate_cut_off'],
    };
    const calAttempt: AnalysisAttempt = {
      ...attempt,
      attemptId: `att_${run}_cal`,
      createdAt: '2026-10-03T16:20:00.000Z',
      calibration,
      overlayObjectId: overlay.objectId,
    };
    await repo.recordAnalysis(calAttempt, []);
    const stored = (await repo.listAnalysisAttempts(event.eventId)).find((a) => a.attemptId === calAttempt.attemptId);
    assert.deepEqual(stored, calAttempt);

    const defAttempt: AnalysisAttempt = {
      ...attempt,
      attemptId: `att_${run}_def`,
      createdAt: '2026-10-03T16:21:00.000Z',
      calibration: { method: 'configured-default', plateDiameterCm: 26.7, plateDiameterPx: 700, cm2PerPx: (26.7 / 700) ** 2, flags: ['calibration_default'] },
    };
    await repo.recordAnalysis(defAttempt, []);
    const def = (await repo.listAnalysisAttempts(event.eventId)).find((a) => a.attemptId === defAttempt.attemptId);
    assert.deepEqual(def, defAttempt, 'calibration without an overlay round-trips');

    await assert.rejects(
      repo.recordAnalysis({ ...calAttempt, attemptId: `att_${run}_cal_bad`, calibration: { ...calibration, cm2PerPx: 1 } }, []),
      /cm2PerPx/,
    );
    await assert.rejects(
      repo.recordAnalysis({ ...calAttempt, attemptId: `att_${run}_cal_bad2`, overlayObjectId: image.objectId }, []),
      /not a registered overlay/,
    );
    await assert.rejects(
      repo.recordAnalysis({ ...defAttempt, attemptId: `att_${run}_def_bad`, calibration: { ...defAttempt.calibration!, flags: [] } }, []),
      /calibration_default/,
    );
    assert.equal(
      (await repo.listAnalysisAttempts(event.eventId)).filter((a) => a.attemptId.includes('_bad')).length,
      0,
      'rejected attempts stored nothing',
    );
  });

  await t.test('everything persists for a fresh connection', async () => {
    const fresh = new SupabaseRepository(config);
    assert.deepEqual(await fresh.getMenuByService(menu.service.serviceId), { service: { ...menu.service, menuVersion: 2 }, items: menu.items.slice(0, 1) });
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

/** Remove every row this run created (children cascade from capture_event / meal_service). */
async function cleanup(): Promise<void> {
  const db = createClient(config.url, config.serviceRoleKey, { auth: { persistSession: false } });
  const del = async (table: string, column: string, pattern: string) => {
    const { error } = await db.from(table).delete().like(column, pattern);
    if (error) throw new Error(`cleanup ${table}: ${error.message}`);
  };
  await del('capture_event', 'hall_id', `${hall}%`);
  await del('reference_portion', 'baseline_id', `%${run}%`);
  await del('image_object', 'object_id', `%${run}%`);
  await del('insight', 'hall_id', `${hall}%`);
  await del('simulated_attendance', 'hall_id', `${hall}%`);
  await del('meal_service', 'hall_id', `${hall}%`);
  await del('menu_item', 'item_id', `%${run}%`);
  await del('menu_item_revision', 'item_id', `%${run}%`);
  await del('hall', 'hall_id', `${hall}%`);
}
