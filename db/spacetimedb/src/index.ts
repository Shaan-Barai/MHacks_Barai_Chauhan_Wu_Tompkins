/**
 * Scrap SpacetimeDB module — TABLE DEFINITIONS (Agent 2).
 *
 * Mirrors contracts/types.ts field-for-field (AGENTS.md §6) with the
 * representation choices documented in db/README.md:
 *   - Contract string unions (meal labels, sources, states, quality flags)
 *     are stored as strings; reducers validate against the contract unions
 *     (validators live in data/, Agent 2's package).
 *   - Timestamps are the contract's UTC ISO 8601 strings, verbatim, so rows
 *     round-trip unchanged through backend/src/repo/repository.ts.
 *   - Open maps (AnalysisAttempt.baselineVersions, Insight.metrics,
 *     ApiError.details) become entry arrays / small JSON strings — SpacetimeDB
 *     has no map column type. These are tiny text records, never image data.
 *   - IMAGE BYTES ARE NEVER STORED HERE. image_object holds only the durable
 *     provider/container/objectKey reference and metadata; bytes live in
 *     external object storage (AGENTS.md §2 agreed architecture).
 *
 * Ownership boundary (AGENTS.md §4): Agent 2 owns these table definitions,
 * schema evolution, and seeds. Agent 5 owns reducers/procedures — add them in
 * a separate reducers file that imports `spacetimedb` from this module; do
 * not edit the table definitions here without an Agent 2 handoff. Gemini
 * calls and object-storage network I/O stay OUTSIDE reducers (AGENTS.md 5.1).
 */

import { schema, table, t } from 'spacetimedb/server';

// ---------------------------------------------------------------------------
// Shared composite types
// ---------------------------------------------------------------------------

/**
 * contracts ImageGeometry. coordinateSpace is 'topdown-normalized-v1' in the
 * prototype; stored as a string so a future space is a data change, not a
 * schema migration. plateShape: 'round' | 'tray' | 'other'.
 */
const ImageGeometry = t.object('ImageGeometry', {
  widthPx: t.u32(),
  heightPx: t.u32(),
  coordinateSpace: t.string(),
  plateShape: t.option(t.string()),
  plateDiameterPx: t.option(t.f64()),
});

/** One entry of contracts AnalysisAttempt.baselineVersions (itemId -> version). */
const BaselineVersionEntry = t.object('BaselineVersionEntry', {
  itemId: t.string(),
  baselineVersion: t.u32(),
});

/**
 * contracts ApiError, stored with a stable shape. `detailsJson` is the
 * JSON-serialized `details` record (small text, optional).
 */
const StoredApiError = t.object('StoredApiError', {
  code: t.string(),
  message: t.string(),
  detailsJson: t.option(t.string()),
  retryable: t.bool(),
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** contracts MealService. One row per hall/local-date/meal. */
const mealService = table(
  { name: 'meal_service', public: true },
  {
    serviceId: t.string().primaryKey(), // svc_<hallId>_<date>_<meal>
    hallId: t.string().index('btree'),
    hallTimezone: t.string(), // IANA name, e.g. "America/Detroit"
    serviceDate: t.string().index('btree'), // LOCAL date YYYY-MM-DD in hallTimezone
    mealLabel: t.string(), // 'breakfast' | 'lunch' | 'dinner'
    menuId: t.string().index('btree'),
    menuVersion: t.u32(), // bumped by revisions; analyses freeze the version they used
  },
);

/** contracts MenuItem. Items join their menu by menuId (never display name). */
const menuItem = table(
  { name: 'menu_item', public: true },
  {
    itemId: t.string().primaryKey(), // item_<hallId>_<date>_<meal>_<slug>
    menuId: t.string().index('btree'),
    displayName: t.string(),
    category: t.option(t.string()),
    description: t.option(t.string()),
  },
);

/**
 * contracts ReferencePortion — expected visible pixel area of ONE uneaten
 * serving. Rows are append-only versions: a revision inserts a new
 * baselineId/baselineVersion (data/ createReferencePortion), never updates an
 * old row, so frozen baselineVersions in analysis_attempt stay resolvable.
 * A missing baseline is the ABSENCE of a row — never a zero-area row (§7.1).
 */
const referencePortion = table(
  { name: 'reference_portion', public: true },
  {
    baselineId: t.string().primaryKey(), // base_<item>_v<version>
    baselineVersion: t.u32(),
    itemId: t.string().index('btree'),
    expectedAreaPx: t.f64(), // finite, > 0 — reducer-validated via data/ helpers
    geometry: ImageGeometry,
    // 'reference_photo' | 'manual_area' | 'gemini_estimate' — the three
    // sources MUST stay distinguishable (AGENTS.md 2.3).
    source: t.string(),
    referenceImageObjectId: t.option(t.string()), // required when source = reference_photo
  },
);

/**
 * contracts ImageObject — durable REFERENCE to an image in external object
 * storage. Metadata only; the key identifies the object, expiring signed URLs
 * never live here. Private: clients get temporary read URLs from the backend
 * (GET /api/images/:objectId/access), not via subscription.
 */
const imageObject = table(
  { name: 'image_object' },
  {
    objectId: t.string().primaryKey(),
    provider: t.string(), // 'r2' | 's3' | 'supabase' | 'firebase' | 'local-dev'
    container: t.string(),
    objectKey: t.string(), // stable identity; never an expiring URL
    publicUrl: t.option(t.string()), // only when public delivery is deliberately chosen
    mimeType: t.string(),
    sizeBytes: t.u64(),
    widthPx: t.option(t.u32()),
    heightPx: t.option(t.u32()),
    uploadedAt: t.option(t.string()), // UTC ISO 8601
    associationKind: t.string(), // 'capture' | 'reference'
    associationId: t.string().index('btree'),
    // 'pending_upload' | 'uploaded' | 'finalized' | 'failed' | 'orphaned'
    state: t.string().index('btree'),
  },
);

/** contracts CaptureEvent. eventId is the ingestion idempotency key. */
const captureEvent = table(
  { name: 'capture_event', public: true },
  {
    eventId: t.string().primaryKey(),
    hallId: t.string().index('btree'),
    serviceId: t.string().index('btree'),
    capturedAt: t.string(), // UTC ISO 8601
    imageObjectId: t.string(), // reference into image_object — never bytes
    geometry: ImageGeometry,
    source: t.string(), // 'camera' | 'replay' | 'manual_upload' — label replays clearly
    qualityFlags: t.array(t.string()), // contracts QualityFlag[]
    state: t.string(), // 'pending' | 'processing' | 'succeeded' | 'needs_review' | 'failed'
  },
);

/**
 * contracts AnalysisAttempt — append-only history per capture event. Freezes
 * the menuVersion and per-item baselineVersions actually used so later menu/
 * baseline revisions never rewrite historical results (AGENTS.md 5.4).
 * Private: dashboard reads counted measurements, not raw attempt history.
 */
const analysisAttempt = table(
  { name: 'analysis_attempt' },
  {
    attemptId: t.string().primaryKey(),
    eventId: t.string().index('btree'),
    menuId: t.string(),
    menuVersion: t.u32(),
    baselineVersions: t.array(BaselineVersionEntry),
    model: t.string(), // e.g. 'gemini-2.5-flash'
    promptVersion: t.string(),
    status: t.string(), // 'succeeded' | 'needs_review' | 'failed'
    error: t.option(StoredApiError),
    qualityFlags: t.array(t.string()),
    createdAt: t.string(), // UTC ISO 8601
  },
);

/**
 * contracts FoodMeasurement — raw values preserved (§7.2). itemId is the
 * option: none = unknown/non-menu food, kept with its area estimate but
 * excluded from menu percentages. Missing baseline => no percentage fields +
 * unavailableReason, never a guessed zero (§7.1).
 */
const foodMeasurement = table(
  { name: 'food_measurement', public: true },
  {
    measurementId: t.string().primaryKey(),
    eventId: t.string().index('btree'),
    attemptId: t.string().index('btree'),
    itemId: t.option(t.string()), // none = unknown/non-menu result
    remainingAreaPx: t.f64(), // raw, unclamped, finite >= 0
    baselineId: t.option(t.string()),
    baselineAreaPx: t.option(t.f64()), // finite > 0 when present
    rawWasteFraction: t.option(t.f64()), // unclamped; > 1 carries 'above_baseline' flag
    displayWastePercent: t.option(t.f64()), // 100 * clamp(raw, 0, 1)
    unavailableReason: t.option(t.string()), // required whenever displayWastePercent is absent
    method: t.string(), // 'gemini_area_estimate' — always an AI estimate in prototype
    qualityFlags: t.array(t.string()),
  },
);

/** contracts Attendance — one SIMULATED row per service, never regenerated per request. */
const attendance = table(
  { name: 'attendance', public: true },
  {
    serviceId: t.string().primaryKey(),
    hallId: t.string().index('btree'),
    serviceDate: t.string(), // local date, matches meal_service.serviceDate
    count: t.u32(),
    source: t.string(), // always 'simulated' in the prototype — label survives into UI
    configuredMin: t.u32(),
    configuredMax: t.u32(),
    seed: t.option(t.string()),
    generatorVersion: t.string(),
  },
);

/**
 * contracts Insight — AI suggestions with their grounding. `metricsJson` is
 * the JSON-serialized metrics record (small text). source: 'gemini' |
 * 'fallback_rules' — fallbacks stay labeled.
 */
const insight = table(
  { name: 'insight', public: true },
  {
    insightId: t.string().primaryKey(),
    hallId: t.string().index('btree'),
    windowStart: t.string(), // UTC ISO 8601
    windowEnd: t.string(),
    metricsJson: t.string(),
    dataVersion: t.string(),
    recommendation: t.string(),
    source: t.string(),
    generatedAt: t.string(),
  },
);

// ---------------------------------------------------------------------------
// Schema assembly
// ---------------------------------------------------------------------------

const spacetimedb = schema({
  mealService,
  menuItem,
  referencePortion,
  imageObject,
  captureEvent,
  analysisAttempt,
  foodMeasurement,
  attendance,
  insight,
});

export default spacetimedb;

// Agent 5: declare reducers against this schema, e.g.
//   export const upsertMenu = spacetimedb.reducer({ ... }, (ctx, args) => { ... });
// One reducer per Repository mutation in backend/src/repo/repository.ts
// (see db/README.md "Swap plan"). Reducers must validate inputs with the
// data/ helpers and must not perform network I/O.
