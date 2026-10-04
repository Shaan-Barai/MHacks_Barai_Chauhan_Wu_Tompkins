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

/** Append one attempt, its measurements, and its segmentation result in a single transaction. */
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
  },
);

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
