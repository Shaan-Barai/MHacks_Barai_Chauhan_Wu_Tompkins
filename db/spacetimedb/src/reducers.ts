/**
 * Scrap SpacetimeDB module — REDUCERS (Agent 5).
 *
 * One reducer per mutation in backend/src/repo/repository.ts (db/README.md
 * "Swap plan"). Each takes the contract entity as a JSON string — the backend
 * already validated it with the data/ helpers — maps it onto the row shape
 * documented in schema.ts, and re-checks the invariants a bad write would
 * break (§7.1 baseline > 0, finite non-negative areas, no image bytes).
 *
 * No network I/O here: Gemini calls and object-storage operations stay in the
 * backend service layer (AGENTS.md 5.1). Reducers only receive verified
 * object references and validated analysis results.
 *
 * No caller auth: hackathon prototype on a trusted network (backend/README.md
 * assumptions). The backend is the only intended caller.
 */

import { t, SenderError } from 'spacetimedb/server';
import spacetimedb from './schema';

type Json = Record<string, any>;

function parse(json: string, what: string): Json {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new SenderError(`${what}: invalid JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SenderError(`${what}: expected a JSON object`);
  }
  return value as Json;
}

function str(o: Json, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) throw new SenderError(`${what}.${key} must be a non-empty string`);
  return v;
}

function optStr(o: Json, key: string): string | undefined {
  return typeof o[key] === 'string' ? o[key] : undefined;
}

function num(o: Json, key: string, what: string, { min = 0, exclusive = false } = {}): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || (exclusive ? v <= min : v < min)) {
    throw new SenderError(`${what}.${key} must be a finite number ${exclusive ? '>' : '>='} ${min}`);
  }
  return v;
}

function optNum(o: Json, key: string): number | undefined {
  return typeof o[key] === 'number' && Number.isFinite(o[key]) ? o[key] : undefined;
}

function strArray(o: Json, key: string): string[] {
  const v = o[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function geometry(o: Json, what: string) {
  const g = o.geometry;
  if (typeof g !== 'object' || g === null) throw new SenderError(`${what}.geometry is required`);
  return {
    widthPx: num(g, 'widthPx', `${what}.geometry`, { exclusive: true }),
    heightPx: num(g, 'heightPx', `${what}.geometry`, { exclusive: true }),
    coordinateSpace: str(g, 'coordinateSpace', `${what}.geometry`),
    plateShape: optStr(g, 'plateShape'),
    plateDiameterPx: optNum(g, 'plateDiameterPx'),
  };
}

// --- menus -----------------------------------------------------------------

/** Upsert the meal_service row and replace its menu_item rows. */
export const upsert_menu = spacetimedb.reducer({ menuJson: t.string() }, (ctx, { menuJson }) => {
  const bundle = parse(menuJson, 'menu');
  const s = bundle.service;
  if (typeof s !== 'object' || s === null) throw new SenderError('menu.service is required');
  const service = {
    serviceId: str(s, 'serviceId', 'service'),
    hallId: str(s, 'hallId', 'service'),
    hallTimezone: str(s, 'hallTimezone', 'service'),
    serviceDate: str(s, 'serviceDate', 'service'),
    mealLabel: str(s, 'mealLabel', 'service'),
    menuId: str(s, 'menuId', 'service'),
    menuVersion: num(s, 'menuVersion', 'service', { min: 1 }),
  };
  if (!Array.isArray(bundle.items)) throw new SenderError('menu.items must be an array');

  const existing = ctx.db.mealService.serviceId.find(service.serviceId);
  if (existing) {
    // Revisions only move forward (data/ planMenuRevision bumps the version);
    // re-sending an older version would silently roll the menu back.
    if (service.menuVersion < existing.menuVersion) {
      throw new SenderError(
        `menu ${service.menuId} version ${service.menuVersion} is older than the stored version ${existing.menuVersion}; plan a revision instead`,
      );
    }
    // A new version: archive the outgoing items so analyses that froze the
    // older version keep resolving their itemIds (menu_item_revision).
    if (service.menuVersion > existing.menuVersion) {
      const supersededAt = ctx.timestamp.toDate().toISOString();
      for (const old of ctx.db.menuItem.menuId.filter(existing.menuId)) {
        const revisionItemId = `${old.itemId}@v${existing.menuVersion}`;
        if (ctx.db.menuItemRevision.revisionItemId.find(revisionItemId)) continue;
        ctx.db.menuItemRevision.insert({
          revisionItemId,
          itemId: old.itemId,
          menuId: old.menuId,
          menuVersion: existing.menuVersion,
          displayName: old.displayName,
          category: old.category,
          description: old.description,
          supersededAt,
        });
      }
    }
    ctx.db.menuItem.menuId.delete(existing.menuId);
    ctx.db.mealService.serviceId.update(service);
  } else {
    ctx.db.mealService.insert(service);
  }
  ctx.db.menuItem.menuId.delete(service.menuId);
  for (const raw of bundle.items as Json[]) {
    const itemMenuId = str(raw, 'menuId', 'item');
    if (itemMenuId !== service.menuId) throw new SenderError(`item ${raw.itemId} belongs to menu ${itemMenuId}`);
    ctx.db.menuItem.insert({
      itemId: str(raw, 'itemId', 'item'),
      menuId: itemMenuId,
      displayName: str(raw, 'displayName', 'item'),
      category: optStr(raw, 'category'),
      description: optStr(raw, 'description'),
    });
  }
});

// --- reference portions ----------------------------------------------------

export const upsert_reference_portion = spacetimedb.reducer({ refJson: t.string() }, (ctx, { refJson }) => {
  const r = parse(refJson, 'reference');
  const row = {
    baselineId: str(r, 'baselineId', 'reference'),
    baselineVersion: num(r, 'baselineVersion', 'reference', { min: 1 }),
    itemId: str(r, 'itemId', 'reference'),
    // §7.1: the denominator must be finite and > 0; a missing baseline is the absence of a row.
    expectedAreaPx: num(r, 'expectedAreaPx', 'reference', { exclusive: true }),
    geometry: geometry(r, 'reference'),
    source: str(r, 'source', 'reference'),
    referenceImageObjectId: optStr(r, 'referenceImageObjectId'),
  };
  if (ctx.db.referencePortion.baselineId.find(row.baselineId)) ctx.db.referencePortion.baselineId.update(row);
  else ctx.db.referencePortion.insert(row);
});

export const delete_reference_portion = spacetimedb.reducer({ baselineId: t.string() }, (ctx, { baselineId }) => {
  ctx.db.referencePortion.baselineId.delete(baselineId);
});

// --- image objects (references + metadata only) ----------------------------

export const upsert_image_object = spacetimedb.reducer({ objectJson: t.string() }, (ctx, { objectJson }) => {
  const o = parse(objectJson, 'imageObject');
  const association = o.association;
  if (typeof association !== 'object' || association === null) {
    throw new SenderError('imageObject.association is required');
  }
  const row = {
    objectId: str(o, 'objectId', 'imageObject'),
    provider: str(o, 'provider', 'imageObject'),
    container: str(o, 'container', 'imageObject'),
    objectKey: str(o, 'objectKey', 'imageObject'),
    publicUrl: optStr(o, 'publicUrl'),
    mimeType: str(o, 'mimeType', 'imageObject'),
    sizeBytes: BigInt(Math.trunc(num(o, 'sizeBytes', 'imageObject'))),
    widthPx: optNum(o, 'widthPx'),
    heightPx: optNum(o, 'heightPx'),
    uploadedAt: optStr(o, 'uploadedAt'),
    associationKind: str(association, 'kind', 'imageObject.association'),
    associationId: str(association, 'id', 'imageObject.association'),
    state: str(o, 'state', 'imageObject'),
  };
  if (ctx.db.imageObject.objectId.find(row.objectId)) ctx.db.imageObject.objectId.update(row);
  else ctx.db.imageObject.insert(row);
});

export const delete_image_object = spacetimedb.reducer({ objectId: t.string() }, (ctx, { objectId }) => {
  ctx.db.imageObject.objectId.delete(objectId);
});

// --- capture events (idempotency key: eventId) -----------------------------

export const upsert_capture_event = spacetimedb.reducer({ eventJson: t.string() }, (ctx, { eventJson }) => {
  const e = parse(eventJson, 'captureEvent');
  const row = {
    eventId: str(e, 'eventId', 'captureEvent'),
    hallId: str(e, 'hallId', 'captureEvent'),
    serviceId: str(e, 'serviceId', 'captureEvent'),
    capturedAt: str(e, 'capturedAt', 'captureEvent'),
    imageObjectId: str(e, 'imageObjectId', 'captureEvent'),
    geometry: geometry(e, 'captureEvent'),
    source: str(e, 'source', 'captureEvent'),
    qualityFlags: strArray(e, 'qualityFlags'),
    state: str(e, 'state', 'captureEvent'),
  };
  // Retries update the same event; they never create another dish.
  if (ctx.db.captureEvent.eventId.find(row.eventId)) ctx.db.captureEvent.eventId.update(row);
  else ctx.db.captureEvent.insert(row);
});

// --- admin curation: hide/show captures on the dashboard --------------------

/** Set `hidden` for many capture events at once (one transaction). Unknown event ids are rejected. */
export const set_capture_visibility = spacetimedb.reducer(
  { eventIdsJson: t.string(), hidden: t.bool(), updatedAt: t.string() },
  (ctx, { eventIdsJson, hidden, updatedAt }) => {
    const ids = JSON.parse(eventIdsJson);
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new SenderError('eventIdsJson must be a JSON array of non-empty strings');
    }
    for (const eventId of ids as string[]) {
      if (!ctx.db.captureEvent.eventId.find(eventId)) throw new SenderError(`capture event ${eventId} does not exist`);
      const row = { eventId, hidden, updatedAt };
      if (ctx.db.captureVisibility.eventId.find(eventId)) ctx.db.captureVisibility.eventId.update(row);
      else ctx.db.captureVisibility.insert(row);
    }
  },
);

// --- analysis attempts + measurements --------------------------------------

function attemptRow(a: Json) {
  const versions = typeof a.baselineVersions === 'object' && a.baselineVersions !== null ? a.baselineVersions : {};
  const error = typeof a.error === 'object' && a.error !== null ? a.error : undefined;
  return {
    attemptId: str(a, 'attemptId', 'attempt'),
    eventId: str(a, 'eventId', 'attempt'),
    menuId: str(a, 'menuId', 'attempt'),
    menuVersion: num(a, 'menuVersion', 'attempt'),
    baselineVersions: Object.entries(versions)
      .filter(([, v]) => typeof v === 'number')
      .map(([itemId, v]) => ({ itemId, baselineVersion: v as number })),
    model: str(a, 'model', 'attempt'),
    promptVersion: str(a, 'promptVersion', 'attempt'),
    status: str(a, 'status', 'attempt'),
    error: error
      ? {
          code: str(error, 'code', 'attempt.error'),
          message: str(error, 'message', 'attempt.error'),
          detailsJson: error.details === undefined ? undefined : JSON.stringify(error.details),
          retryable: error.retryable === true,
        }
      : undefined,
    qualityFlags: strArray(a, 'qualityFlags'),
    createdAt: str(a, 'createdAt', 'attempt'),
    calibrationId: optStr(a, 'calibrationId'),
    physicalMethod: physicalMethod(a.physicalMethod, 'attempt.physicalMethod'),
    // Unused legacy column (Depth Anything V2 removed 2026-10-04): always none.
    depthObjectId: undefined,
  };
}

// --- IT_4: physical estimates -------------------------------------------------

// Depth Anything V2 was removed (2026-10-04): the only physical method is the
// calibrated area. A client that still sends the legacy 'volume-dav2-v1'
// (e.g. a backend built before the removal) is accepted and stored as the area
// method; readers recompute areaCm2 = pixels × the calibration's k anyway.
const AREA_METHOD = 'area-calibrated-v1';
const LEGACY_PHYSICAL_METHODS = new Set([AREA_METHOD, 'volume-dav2-v1']);

function physicalMethod(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !LEGACY_PHYSICAL_METHODS.has(v)) throw new SenderError(`${what} '${String(v)}' is not allowed`);
  return AREA_METHOD;
}

/**
 * contracts PhysicalEstimate {calibrationId, method, areaCm2}: a finite,
 * non-negative calibrated area. Unavailable is the absence of the field,
 * never a placeholder zero. The legacy depth columns of the stored
 * PhysicalEstimate (volume, heights, depth settings, plate reference, flags)
 * are unused and always written empty; incoming values are ignored.
 */
function physicalRow(raw: unknown, what: string) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new SenderError(`${what} must be an object`);
  const p = raw as Json;
  const method = physicalMethod(p.method, `${what}.method`);
  if (method === undefined) throw new SenderError(`${what}.method is required`);
  return {
    calibrationId: str(p, 'calibrationId', what),
    method,
    areaCm2: num(p, 'areaCm2', what),
    volumeCm3: undefined,
    meanHeightMm: undefined,
    maxHeightMm: undefined,
    depthSettingsVersion: undefined,
    plateReference: undefined,
    flags: [] as string[],
  };
}

function measurementRow(m: Json) {
  const flags = strArray(m, 'qualityFlags');
  const rawWasteFraction = optNum(m, 'rawWasteFraction');
  const displayWastePercent = optNum(m, 'displayWastePercent');
  const unavailableReason = optStr(m, 'unavailableReason');
  if (rawWasteFraction !== undefined && rawWasteFraction > 1 && !flags.includes('above_baseline')) {
    throw new SenderError(`measurement ${m.measurementId}: fraction > 1 must carry 'above_baseline'`);
  }
  if (m.method !== 'mask_pixel_count' && displayWastePercent === undefined && unavailableReason === undefined) {
    throw new SenderError(`measurement ${m.measurementId}: unavailableReason required when no percentage`);
  }
  return {
    measurementId: str(m, 'measurementId', 'measurement'),
    eventId: str(m, 'eventId', 'measurement'),
    attemptId: str(m, 'attemptId', 'measurement'),
    itemId: optStr(m, 'itemId'), // null/absent = unknown food
    remainingAreaPx: num(m, 'remainingAreaPx', 'measurement'),
    baselineId: optStr(m, 'baselineId'),
    baselineAreaPx: optNum(m, 'baselineAreaPx'),
    rawWasteFraction,
    displayWastePercent,
    unavailableReason,
    method: str(m, 'method', 'measurement'),
    maskCountJson: m.method === 'mask_pixel_count' && m.maskCount ? JSON.stringify({
      pixelsWasted: num(m.maskCount, 'pixelsWasted', 'mask'),
      maskObjectId: str(m.maskCount, 'maskObjectId', 'mask'),
      geometry: geometry(m.maskCount, 'mask'),
      menuId: str(m.maskCount, 'menuId', 'mask'),
      menuVersion: num(m.maskCount, 'menuVersion', 'mask'),
      classificationVersion: str(m.maskCount, 'classificationVersion', 'mask'),
      segmentationVersion: str(m.maskCount, 'segmentationVersion', 'mask'),
      processingVersion: str(m.maskCount, 'processingVersion', 'mask'),
      assignment: m.maskCount.assignment,
      validated: m.maskCount.validated === true,
    }) : undefined,
    qualityFlags: flags,
    physical: physicalRow(m.physical, `measurement ${m.measurementId}.physical`),
  };
}

const COUNT_STATUSES = new Set(['complete', 'empty', 'partial', 'unavailable']);
const SEG_STATUSES = new Set(['succeeded', 'partial', 'failed', 'skipped']);
const REGION_STATUSES = new Set(['succeeded', 'failed', 'skipped']);

function boxArray(o: Json, key: string, what: string): number[] {
  const v = o?.[key];
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new SenderError(`${what}.${key} must be 4 finite numbers`);
  }
  return v as number[];
}

function storedError(e: unknown) {
  if (typeof e !== 'object' || e === null) return undefined;
  const o = e as Json;
  return {
    code: str(o, 'code', 'error'),
    message: str(o, 'message', 'error'),
    detailsJson: o.details === undefined ? undefined : JSON.stringify(o.details),
    retryable: o.retryable === true,
  };
}

/**
 * Segmentation provenance + Pixels wasted for one attempt
 * (contracts/measurement.md). Enforces the counting invariants a bad write
 * would break: integer counts within the canvas, and for complete/partial
 * captures sum(item + unclassified pixels) == capture union (rule smallest-first-v1; any rule that assigns each pixel to one bucket).
 */
function insertSegmentation(ctx: any, attemptId: string, eventId: string, seg: Json, measuredPx: number) {
  const width = num(seg, 'widthPx', 'segmentation', { exclusive: true });
  const height = num(seg, 'heightPx', 'segmentation', { exclusive: true });
  const status = str(seg, 'status', 'segmentation');
  const countStatus = str(seg, 'countStatus', 'segmentation');
  if (!SEG_STATUSES.has(status)) throw new SenderError(`segmentation.status '${status}' is not allowed`);
  if (!COUNT_STATUSES.has(countStatus)) throw new SenderError(`segmentation.countStatus '${countStatus}' is not allowed`);
  const capture = optNum(seg, 'capturePixelsWasted');
  if (capture !== undefined && (!Number.isInteger(capture) || capture < 0 || capture > width * height)) {
    throw new SenderError('segmentation.capturePixelsWasted must be an integer within the image');
  }
  if (countStatus === 'unavailable' && capture !== undefined) throw new SenderError('an unavailable count has no pixel total');
  if (countStatus !== 'unavailable' && capture === undefined) throw new SenderError(`a ${countStatus} count needs capturePixelsWasted`);
  if (countStatus === 'empty' && capture !== 0) throw new SenderError('an empty plate counts 0 pixels');
  if ((countStatus === 'complete' || countStatus === 'partial') && capture !== measuredPx) {
    throw new SenderError(`capture union ${capture} != sum of measured pixels ${measuredPx}`);
  }
  ctx.db.captureCount.insert({
    attemptId,
    eventId,
    model: str(seg, 'model', 'segmentation'),
    checkpoint: str(seg, 'checkpoint', 'segmentation'),
    codeRevision: str(seg, 'codeRevision', 'segmentation'),
    promptSource: str(seg, 'promptSource', 'segmentation'),
    settingsVersion: str(seg, 'settingsVersion', 'segmentation'),
    countingRuleVersion: str(seg, 'countingRuleVersion', 'segmentation'),
    status,
    countStatus,
    capturePixelsWasted: capture,
    widthPx: width,
    heightPx: height,
  });
  const regions = Array.isArray(seg.regions) ? (seg.regions as Json[]) : [];
  for (const r of regions) {
    const regionStatus = str(r, 'segmentationStatus', 'region');
    if (!REGION_STATUSES.has(regionStatus)) throw new SenderError(`region status '${regionStatus}' is not allowed`);
    const maskPixels = optNum(r, 'maskPixels');
    if (maskPixels !== undefined && (!Number.isInteger(maskPixels) || maskPixels < 0 || maskPixels > width * height)) {
      throw new SenderError('region.maskPixels must be an integer within the image');
    }
    if (r.attemptId !== attemptId) throw new SenderError(`region ${r.regionId} is for another attempt`);
    const box = typeof r.box === 'object' && r.box !== null ? (r.box as Json) : {};
    ctx.db.segmentationRegion.insert({
      regionId: str(r, 'regionId', 'region'),
      attemptId,
      eventId,
      itemId: optStr(r, 'itemId'),
      visualLabel: str(r, 'visualLabel', 'region'),
      geminiBox: boxArray(box, 'gemini', 'region.box'),
      pixelBox: boxArray(box, 'pixelXyxy', 'region.box'),
      boxConvention: str(box, 'convention', 'region.box'),
      segmentationStatus: regionStatus,
      maskObjectId: optStr(r, 'maskObjectId'),
      maskPixels,
      score: optNum(r, 'score'),
      error: storedError(r.error),
    });
  }
}

const CALIBRATION_METHODS = new Set(['plate-fit-v1', 'configured-default']);
const CALIBRATION_FLAGS = new Set(['calibration_default', 'plate_cut_off', 'bowl_size_assumed']);
const DISH_TYPES = new Set(['plate', 'bowl', 'other']);

/**
 * contracts PlateCalibration + overlayObjectId (BIG-PLAN D2/D7) for one
 * attempt. Re-checks what a bad write would break: positive finite scale,
 * cm2PerPx == (cm/px)^2, known method/flags, a default calibration flagged as
 * such, and an overlay reference that is a registered overlay of THIS capture.
 */
function insertCalibration(ctx: any, attemptId: string, eventId: string, a: Json) {
  const raw = a.calibration;
  const overlayObjectId = optStr(a, 'overlayObjectId');
  if (raw === undefined && overlayObjectId === undefined) return;
  let calibration: Json | undefined;
  if (raw !== undefined) {
    if (typeof raw !== 'object' || raw === null) throw new SenderError('attempt.calibration must be an object');
    const c = raw as Json;
    const method = str(c, 'method', 'calibration');
    if (!CALIBRATION_METHODS.has(method)) throw new SenderError(`calibration.method '${method}' is not allowed`);
    const plateDiameterCm = num(c, 'plateDiameterCm', 'calibration', { exclusive: true });
    const plateDiameterPx = num(c, 'plateDiameterPx', 'calibration', { exclusive: true });
    const cm2PerPx = num(c, 'cm2PerPx', 'calibration', { exclusive: true });
    const expected = (plateDiameterCm / plateDiameterPx) ** 2;
    if (Math.abs(cm2PerPx - expected) > expected * 1e-3) {
      throw new SenderError(`calibration.cm2PerPx ${cm2PerPx} != (plateDiameterCm / plateDiameterPx)^2`);
    }
    if (!Array.isArray(c.flags)) throw new SenderError('calibration.flags must be an array');
    const flags = strArray(c, 'flags');
    for (const f of flags) if (!CALIBRATION_FLAGS.has(f)) throw new SenderError(`calibration flag '${f}' is not allowed`);
    if (method === 'configured-default' && !flags.includes('calibration_default')) {
      throw new SenderError("a configured-default calibration must carry 'calibration_default'");
    }
    const dishType = optStr(c, 'dishType');
    if (dishType !== undefined && !DISH_TYPES.has(dishType)) throw new SenderError(`calibration.dishType '${dishType}' is not allowed`);
    calibration = {
      method,
      plateDiameterCm,
      plateDiameterPx,
      cm2PerPx,
      dishType,
      fullyVisible: typeof c.fullyVisible === 'boolean' ? c.fullyVisible : undefined,
      flags,
    };
  }
  if (overlayObjectId !== undefined) {
    const overlay = ctx.db.imageObject.objectId.find(overlayObjectId);
    if (!overlay || overlay.associationKind !== 'overlay' || overlay.associationId !== eventId) {
      throw new SenderError(`overlay ${overlayObjectId} is not a registered overlay of capture ${eventId}`);
    }
  }
  ctx.db.attemptCalibration.insert({ attemptId, eventId, calibration, overlayObjectId });
}

/** Append one attempt, its measurements, segmentation result, and calibration/overlay in a single transaction. */
export const record_analysis = spacetimedb.reducer(
  { attemptJson: t.string(), measurementsJson: t.string() },
  (ctx, { attemptJson, measurementsJson }) => {
    const attempt = attemptRow(parse(attemptJson, 'attempt'));
    if (ctx.db.analysisAttempt.attemptId.find(attempt.attemptId)) {
      throw new SenderError(`attempt ${attempt.attemptId} already recorded`);
    }
    let list: unknown;
    try {
      list = JSON.parse(measurementsJson);
    } catch {
      throw new SenderError('measurements: invalid JSON');
    }
    if (!Array.isArray(list)) throw new SenderError('measurements must be an array');
    ctx.db.analysisAttempt.insert(attempt);
    let measuredPx = 0;
    for (const raw of list as Json[]) {
      const row = measurementRow(raw);
      if (row.attemptId !== attempt.attemptId) throw new SenderError(`measurement ${row.measurementId} is for another attempt`);
      if (row.method === 'mask_pixel_count' && !Number.isInteger(row.remainingAreaPx)) {
        throw new SenderError(`measurement ${row.measurementId}: mask pixel counts are integers`);
      }
      measuredPx += row.remainingAreaPx;
      ctx.db.foodMeasurement.insert(row);
    }
    const seg = parse(attemptJson, 'attempt').segmentation;
    if (seg !== undefined) {
      if (typeof seg !== 'object' || seg === null) throw new SenderError('attempt.segmentation must be an object');
      insertSegmentation(ctx, attempt.attemptId, attempt.eventId, seg as Json, measuredPx);
    }
    insertCalibration(ctx, attempt.attemptId, attempt.eventId, parse(attemptJson, 'attempt'));
    checkPhysicalSnapshot(ctx, attempt, list as Json[]);
  },
);

/**
 * IT_4 I9: the attempt's snapshot must reference a succeeded calibration
 * (every measurement's physical numbers use THAT calibration).
 */
function checkPhysicalSnapshot(
  ctx: any,
  attempt: { attemptId: string; eventId: string; calibrationId?: string; physicalMethod?: string },
  measurements: Json[],
) {
  if (attempt.calibrationId !== undefined) {
    const cal = ctx.db.cameraCalibration.calibrationId.find(attempt.calibrationId);
    if (!cal || cal.status !== 'succeeded') {
      throw new SenderError(`calibration ${attempt.calibrationId} is not a succeeded camera calibration`);
    }
  }
  if (attempt.physicalMethod !== undefined && attempt.calibrationId === undefined) {
    throw new SenderError('attempt.physicalMethod needs attempt.calibrationId');
  }
  for (const m of measurements) {
    const p = m.physical as Json | undefined;
    if (p === undefined || p === null) continue;
    if (p.calibrationId !== attempt.calibrationId) {
      throw new SenderError(`measurement ${m.measurementId}: physical.calibrationId differs from the attempt's calibration`);
    }
  }
}

// --- IT_4: camera calibration + measurement settings -----------------------

const CALIBRATION_STATUSES = new Set(['processing', 'succeeded', 'failed']);
const CAMERA_CALIBRATION_FLAGS = new Set(['reference_not_found', 'reference_low_confidence', 'reference_touches_edge']);
/** Flags a pre-removal client may still send; dropped, never stored. */
const LEGACY_DEPTH_CALIBRATION_FLAGS = new Set(['depth_unavailable', 'depth_scale_disagrees']);
const INTRINSICS_SOURCES = new Set(['nominal-fov', 'checkerboard', 'configured']);

function imageOf(ctx: any, objectId: string | undefined, kinds: string[], associationId: string, what: string) {
  if (objectId === undefined) return;
  const obj = ctx.db.imageObject.objectId.find(objectId);
  if (!obj || !kinds.includes(obj.associationKind) || obj.associationId !== associationId) {
    throw new SenderError(`${what} ${objectId} is not a registered ${kinds.join('/')} image of ${associationId}`);
  }
}

/**
 * contracts CameraCalibration. A succeeded calibration has N_ref > 0 and
 * k = knownAreaCm2 / N_ref; once succeeded or failed it is immutable, so
 * attempts that snapshotted it stay reproducible.
 */
export const upsert_camera_calibration = spacetimedb.reducer({ calibrationJson: t.string() }, (ctx, { calibrationJson }) => {
  const c = parse(calibrationJson, 'calibration');
  const calibrationId = str(c, 'calibrationId', 'calibration');
  const status = str(c, 'status', 'calibration');
  if (!CALIBRATION_STATUSES.has(status)) throw new SenderError(`calibration.status '${status}' is not allowed`);
  if (str(c, 'method', 'calibration') !== 'reference-area-v1') throw new SenderError("calibration.method must be 'reference-area-v1'");
  const widthPx = num(c, 'widthPx', 'calibration', { exclusive: true });
  const heightPx = num(c, 'heightPx', 'calibration', { exclusive: true });
  const knownAreaCm2 = num(c, 'knownAreaCm2', 'calibration', { exclusive: true });
  const referencePixels = num(c, 'referencePixels', 'calibration');
  const cm2PerPx = num(c, 'cm2PerPx', 'calibration');
  if (!Number.isInteger(referencePixels) || referencePixels > widthPx * heightPx) {
    throw new SenderError('calibration.referencePixels must be an integer within the image');
  }
  if (status === 'succeeded') {
    if (referencePixels <= 0) throw new SenderError('a succeeded calibration needs referencePixels > 0');
    const k = knownAreaCm2 / referencePixels;
    if (Math.abs(cm2PerPx - k) > k * 1e-6) throw new SenderError('calibration.cm2PerPx must equal knownAreaCm2 / referencePixels');
  }
  const i = c.intrinsics;
  if (typeof i !== 'object' || i === null) throw new SenderError('calibration.intrinsics is required');
  const intrinsicsSource = str(i, 'source', 'intrinsics');
  if (!INTRINSICS_SOURCES.has(intrinsicsSource)) throw new SenderError(`intrinsics.source '${intrinsicsSource}' is not allowed`);
  const flags = strArray(c, 'flags').filter((f) => !LEGACY_DEPTH_CALIBRATION_FLAGS.has(f));
  for (const f of flags) if (!CAMERA_CALIBRATION_FLAGS.has(f)) throw new SenderError(`calibration flag '${f}' is not allowed`);
  const row = {
    calibrationId,
    hallId: str(c, 'hallId', 'calibration'),
    cameraId: str(c, 'cameraId', 'calibration'),
    createdAt: str(c, 'createdAt', 'calibration'),
    status,
    method: 'reference-area-v1',
    imageObjectId: str(c, 'imageObjectId', 'calibration'),
    overlayObjectId: optStr(c, 'overlayObjectId'),
    referenceMaskObjectId: optStr(c, 'referenceMaskObjectId'),
    widthPx,
    heightPx,
    knownAreaCm2,
    referenceLabel: str(c, 'referenceLabel', 'calibration'),
    referencePixels,
    cm2PerPx,
    intrinsics: {
      cameraModel: str(i, 'cameraModel', 'intrinsics'),
      widthPx: num(i, 'widthPx', 'intrinsics', { exclusive: true }),
      heightPx: num(i, 'heightPx', 'intrinsics', { exclusive: true }),
      fxPx: num(i, 'fxPx', 'intrinsics', { exclusive: true }),
      fyPx: num(i, 'fyPx', 'intrinsics', { exclusive: true }),
      cxPx: num(i, 'cxPx', 'intrinsics'),
      cyPx: num(i, 'cyPx', 'intrinsics'),
      source: intrinsicsSource,
    },
    cameraHeightCmGeometric: num(c, 'cameraHeightCmGeometric', 'calibration'),
    // Unused legacy column (Depth Anything V2 removed): always none; any incoming `depth` is ignored.
    depth: undefined,
    flags,
    error: storedError(c.error),
  };
  imageOf(ctx, row.imageObjectId, ['calibration'], calibrationId, 'calibration.imageObjectId');
  imageOf(ctx, row.overlayObjectId, ['calibration_overlay'], calibrationId, 'calibration.overlayObjectId');
  imageOf(ctx, row.referenceMaskObjectId, ['calibration_overlay', 'mask'], calibrationId, 'calibration.referenceMaskObjectId');
  const existing = ctx.db.cameraCalibration.calibrationId.find(calibrationId);
  if (existing) {
    if (existing.status !== 'processing') throw new SenderError(`calibration ${calibrationId} is ${existing.status} and cannot change`);
    ctx.db.cameraCalibration.calibrationId.update(row);
  } else {
    ctx.db.cameraCalibration.insert(row);
  }
});

/** contracts MeasurementSettings. The active calibration must be a succeeded calibration of this hall. */
export const upsert_measurement_settings = spacetimedb.reducer({ settingsJson: t.string() }, (ctx, { settingsJson }) => {
  const m = parse(settingsJson, 'settings');
  const hallId = str(m, 'hallId', 'settings');
  const activeCalibrationId = optStr(m, 'activeCalibrationId');
  if (activeCalibrationId !== undefined) {
    const cal = ctx.db.cameraCalibration.calibrationId.find(activeCalibrationId);
    if (!cal || cal.hallId !== hallId || cal.status !== 'succeeded') {
      throw new SenderError(`calibration ${activeCalibrationId} is not a succeeded calibration of hall ${hallId}`);
    }
  }
  const row = {
    hallId,
    // Unused legacy columns (Depth Anything V2 removed): fixed defaults; incoming values are ignored.
    depthEnabled: false,
    activeCalibrationId,
    plateThicknessCm: 0,
    updatedAt: str(m, 'updatedAt', 'settings'),
  };
  if (ctx.db.measurementSettings.hallId.find(hallId)) ctx.db.measurementSettings.hallId.update(row);
  else ctx.db.measurementSettings.insert(row);
});


// --- attendance (SIMULATED) ------------------------------------------------

/** Validate all rows before replacing this version's counts in one transaction. */
export const replace_portions_served = spacetimedb.reducer({ snapshotJson: t.string() }, (ctx, { snapshotJson }) => {
  const body = parse(snapshotJson, 'portions');
  const serviceId = str(body, 'serviceId', 'portions');
  const menuVersion = num(body, 'menuVersion', 'portions', { min: 1 });
  const service = ctx.db.mealService.serviceId.find(serviceId);
  if (!service || service.menuVersion !== menuVersion) throw new SenderError('The menu changed; reload before saving portions.');
  if (!Array.isArray(body.portions)) throw new SenderError('portions must be an array');
  const allowed = new Set([...ctx.db.menuItem.menuId.filter(service.menuId)].map(i => i.itemId));
  const seen = new Set<string>();
  const rows = (body.portions as Json[]).map(p => {
    const itemId = str(p, 'itemId', 'portion');
    const count = num(p, 'count', 'portion');
    if (!allowed.has(itemId) || seen.has(itemId)) throw new SenderError('Unknown or duplicate portions item');
    seen.add(itemId);
    if (!Number.isInteger(count) || count > 4_294_967_295) throw new SenderError('Portions served must be a nonnegative whole number');
    const source = str(p, 'source', 'portion');
    if (!['manual', 'csv', 'demo'].includes(source)) throw new SenderError('Invalid portions source');
    if (p.serviceId !== serviceId || p.menuVersion !== menuVersion || p.hallId !== service.hallId ||
        p.serviceDate !== service.serviceDate || p.menuId !== service.menuId) throw new SenderError('Portions service context differs');
    return {
      recordId: JSON.stringify([serviceId, menuVersion, itemId]), serviceId, menuVersion,
      hallId: service.hallId, serviceDate: service.serviceDate, menuId: service.menuId,
      itemId, count, source, updatedAt: str(p, 'updatedAt', 'portion'),
    };
  });
  for (const old of [...ctx.db.portionsServed.serviceId.filter(serviceId)]) {
    if (old.menuVersion === menuVersion) ctx.db.portionsServed.recordId.delete(old.recordId);
  }
  for (const row of rows) ctx.db.portionsServed.insert(row);
});

export const upsert_attendance = spacetimedb.reducer({ attendanceJson: t.string() }, (ctx, { attendanceJson }) => {
  const a = parse(attendanceJson, 'attendance');
  if (a.source !== 'simulated') throw new SenderError("attendance.source must be 'simulated' in the prototype");
  const row = {
    serviceId: str(a, 'serviceId', 'attendance'),
    hallId: str(a, 'hallId', 'attendance'),
    serviceDate: str(a, 'serviceDate', 'attendance'),
    count: num(a, 'count', 'attendance'),
    source: 'simulated',
    configuredMin: num(a, 'configuredMin', 'attendance'),
    configuredMax: num(a, 'configuredMax', 'attendance'),
    seed: optStr(a, 'seed'),
    generatorVersion: str(a, 'generatorVersion', 'attendance'),
  };
  if (ctx.db.attendance.serviceId.find(row.serviceId)) ctx.db.attendance.serviceId.update(row);
  else ctx.db.attendance.insert(row);
});

// --- insights --------------------------------------------------------------

export const upsert_insight = spacetimedb.reducer({ insightJson: t.string() }, (ctx, { insightJson }) => {
  const i = parse(insightJson, 'insight');
  const row = {
    insightId: str(i, 'insightId', 'insight'),
    hallId: str(i, 'hallId', 'insight'),
    windowStart: str(i, 'windowStart', 'insight'),
    windowEnd: str(i, 'windowEnd', 'insight'),
    metricsJson: JSON.stringify(typeof i.metrics === 'object' && i.metrics !== null ? i.metrics : {}),
    dataVersion: str(i, 'dataVersion', 'insight'),
    recommendation: str(i, 'recommendation', 'insight'),
    source: str(i, 'source', 'insight'),
    generatedAt: str(i, 'generatedAt', 'insight'),
  };
  if (ctx.db.insight.insightId.find(row.insightId)) ctx.db.insight.insightId.update(row);
  else ctx.db.insight.insert(row);
});

// --- scans (per-capture details; contracts ScanInfo) -------------------------

const TIMESTAMP_BASES = ['laptop_trigger', 'laptop_received', 'laptop_ingest', 'demo'];

export const upsert_scan_info = spacetimedb.reducer({ scanJson: t.string() }, (ctx, { scanJson }) => {
  const s = parse(scanJson, 'scanInfo');
  const timestampBasis = str(s, 'timestampBasis', 'scanInfo');
  if (!TIMESTAMP_BASES.includes(timestampBasis)) throw new SenderError(`scanInfo.timestampBasis must be one of ${TIMESTAMP_BASES.join(', ')}`);
  const sha = optStr(s, 'originalSha256');
  if (sha !== undefined && !/^[0-9a-f]{64}$/.test(sha)) throw new SenderError('scanInfo.originalSha256 must be 64 lowercase hex characters');
  const row = {
    eventId: str(s, 'eventId', 'scanInfo'),
    deviceId: str(s, 'deviceId', 'scanInfo'),
    timestampBasis,
    originalImageObjectId: optStr(s, 'originalImageObjectId'),
    originalSha256: sha,
    sourceName: optStr(s, 'sourceName'),
    demo: s.demo === true,
  };
  if (ctx.db.scanInfo.eventId.find(row.eventId)) ctx.db.scanInfo.eventId.update(row);
  else ctx.db.scanInfo.insert(row);
});

// --- sample data (DEMO_SEED) -------------------------------------------------

/** Tables the demo-history seed may create rows in, keyed by primary key. */
const DEMO_TABLES = [
  'meal_service', 'menu_item', 'portions_served', 'capture_event', 'scan_info',
  'analysis_attempt', 'food_measurement', 'capture_count',
] as const;

export const record_demo_markers = spacetimedb.reducer({ markersJson: t.string() }, (ctx, { markersJson }) => {
  let list: unknown;
  try {
    list = JSON.parse(markersJson);
  } catch {
    throw new SenderError('markers: invalid JSON');
  }
  if (!Array.isArray(list)) throw new SenderError('markers must be an array');
  for (const m of list as Json[]) {
    const tableName = str(m, 'tableName', 'marker');
    const rowKey = str(m, 'rowKey', 'marker');
    if (!(DEMO_TABLES as readonly string[]).includes(tableName)) throw new SenderError(`marker table ${tableName} is not a demo table`);
    const markerId = `${tableName}:${rowKey}`;
    if (!ctx.db.demoMarker.markerId.find(markerId)) ctx.db.demoMarker.insert({ markerId, tableName, rowKey });
  }
});

/**
 * Remove every row the demo-history seed created (and only those), in one
 * transaction. Real scans, menus, and portions have no marker and are untouched.
 */
export const clear_demo_data = spacetimedb.reducer({}, (ctx) => {
  for (const marker of [...ctx.db.demoMarker.iter()]) {
    const key = marker.rowKey;
    switch (marker.tableName) {
      case 'meal_service':
        ctx.db.mealService.serviceId.delete(key);
        // Simulated attendance the dashboard generated for this sample service.
        ctx.db.attendance.serviceId.delete(key);
        break;
      case 'menu_item': ctx.db.menuItem.itemId.delete(key); break;
      case 'portions_served': ctx.db.portionsServed.recordId.delete(key); break;
      case 'capture_event':
        ctx.db.captureEvent.eventId.delete(key);
        // An admin may have hidden a sample scan; its visibility row goes with it.
        ctx.db.captureVisibility.eventId.delete(key);
        break;
      case 'scan_info': ctx.db.scanInfo.eventId.delete(key); break;
      case 'analysis_attempt': ctx.db.analysisAttempt.attemptId.delete(key); break;
      case 'food_measurement': ctx.db.foodMeasurement.measurementId.delete(key); break;
      case 'capture_count': ctx.db.captureCount.attemptId.delete(key); break;
      default: break;
    }
    ctx.db.demoMarker.markerId.delete(marker.markerId);
  }
});
