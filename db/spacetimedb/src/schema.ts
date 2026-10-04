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
 * Archive of menu items from SUPERSEDED menu versions (2026-10-04, additive,
 * BIG-PLAN v2 V4). menu_item holds only the live version of each menu (the
 * classification vocabulary); when upsert_menu stores a higher menuVersion it
 * first copies the outgoing version's items here, so food measurements from
 * analyses that froze the older version still resolve their itemId to a
 * display name/category. Never used for classification. Insert-only.
 */
const menuItemRevision = table(
  { name: 'menu_item_revision', public: true },
  {
    revisionItemId: t.string().primaryKey(), // <itemId>@v<menuVersion>
    itemId: t.string().index('btree'),
    menuId: t.string().index('btree'),
    menuVersion: t.u32(), // the superseded version these items belonged to
    displayName: t.string(),
    category: t.option(t.string()),
    description: t.option(t.string()),
    supersededAt: t.string(), // UTC ISO 8601: when the next version replaced it
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
    // 'capture' | 'reference' | 'mask' | 'overlay' (id = capture eventId) |
    // IT_4: 'calibration' / 'calibration_overlay' (id = calibrationId).
    // 'depth' only on legacy rows from the removed Depth Anything V2 trial.
    associationKind: t.string(),
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
    model: t.string(), // e.g. 'gemini-3.8-flash'
    promptVersion: t.string(),
    status: t.string(), // 'succeeded' | 'needs_review' | 'failed'
    error: t.option(StoredApiError),
    qualityFlags: t.array(t.string()),
    createdAt: t.string(), // UTC ISO 8601
    // IT_4 I9 (2026-10-04, additive): appended columns with defaults publish
    // in place; legacy rows read as none. The hall's measurement settings are
    // snapshotted here so activating another calibration never rewrites history.
    calibrationId: t.option(t.string()).default(undefined), // camera_calibration used, if any
    physicalMethod: t.option(t.string()).default(undefined), // 'area-calibrated-v1' (legacy rows: 'volume-dav2-v1')
    depthObjectId: t.option(t.string()).default(undefined), // UNUSED legacy column (Depth Anything V2 removed); always none
  },
);

/**
 * contracts PhysicalEstimate (IT_4 I6), stored on food_measurement.physical:
 * calibrationId, method 'area-calibrated-v1', areaCm2. The other fields are
 * UNUSED legacy columns from the removed Depth Anything V2 trial (they cannot
 * be dropped without wiping `scrap`): new rows write none / []. Legacy rows
 * may carry method 'volume-dav2-v1' and volume fields; readers ignore them
 * and recompute areaCm2 = pixels × the calibration's k.
 */
const PhysicalEstimate = t.object('PhysicalEstimate', {
  calibrationId: t.string(),
  method: t.string(),
  areaCm2: t.f64(),
  volumeCm3: t.option(t.f64()),
  meanHeightMm: t.option(t.f64()),
  maxHeightMm: t.option(t.f64()),
  depthSettingsVersion: t.option(t.string()),
  plateReference: t.option(t.string()),
  flags: t.array(t.string()),
});

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
    maskCountJson: t.option(t.string()), // small validated count/provenance; no mask bytes
    qualityFlags: t.array(t.string()),
    // IT_4 (additive, default none): ESTIMATED calibrated area (pixels × k).
    // remainingAreaPx stays the raw measurement; none = no compatible calibration.
    physical: t.option(PhysicalEstimate).default(undefined),
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

const portionsServed = table(
  { name: 'portions_served', public: true },
  {
    recordId: t.string().primaryKey(),
    serviceId: t.string().index('btree'),
    hallId: t.string(),
    serviceDate: t.string(),
    menuId: t.string(),
    menuVersion: t.u32(),
    itemId: t.string(),
    count: t.u32(),
    source: t.string(),
    updatedAt: t.string(),
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

/**
 * Segmentation stage + Pixels wasted per analysis attempt
 * (contracts SegmentationResult minus its regions). One row per attempt that
 * ran the mask pipeline; legacy Gemini-area attempts have none.
 * capturePixelsWasted is the union of the attempt's valid food masks:
 * present for 'complete', 'empty' (0), and 'partial' (a lower bound).
 * Private, like analysis_attempt: the dashboard reads aggregates.
 */
const captureCount = table(
  { name: 'capture_count' },
  {
    attemptId: t.string().primaryKey(),
    eventId: t.string().index('btree'),
    model: t.string(), // e.g. 'sam2.1-hiera-small'
    checkpoint: t.string(),
    codeRevision: t.string(),
    promptSource: t.string(), // 'gemini_box'
    settingsVersion: t.string(), // e.g. 'sam2-box-v1'
    countingRuleVersion: t.string(), // e.g. 'smallest-first-v1'
    status: t.string(), // 'succeeded' | 'partial' | 'failed' | 'skipped'
    countStatus: t.string(), // 'complete' | 'empty' | 'partial' | 'unavailable'
    capturePixelsWasted: t.option(t.u32()),
    widthPx: t.u32(),
    heightPx: t.u32(),
  },
);

/**
 * contracts ClassificationRegion — one food box from classification and its
 * segmentation outcome. The mask itself lives in object storage
 * (image_object with association kind 'mask'); only its id is here.
 */
const segmentationRegion = table(
  { name: 'segmentation_region' },
  {
    regionId: t.string().primaryKey(),
    attemptId: t.string().index('btree'),
    eventId: t.string().index('btree'),
    itemId: t.option(t.string()), // none = unclassified edible food
    visualLabel: t.string(),
    geminiBox: t.array(t.f64()), // [ymin, xmin, ymax, xmax] on 0-1000
    pixelBox: t.array(t.f64()), // [x0, y0, x1, y1] on the analyzed image
    boxConvention: t.string(),
    segmentationStatus: t.string(), // 'succeeded' | 'failed' | 'skipped'
    maskObjectId: t.option(t.string()),
    maskPixels: t.option(t.u32()),
    score: t.option(t.f64()),
    error: t.option(StoredApiError),
  },
);

/**
 * contracts PlateCalibration (BIG-PLAN D2): per-capture pixel -> cm² scale.
 * method: 'plate-fit-v1' | 'configured-default'; flags: contracts
 * CalibrationFlag[] ('calibration_default' | 'plate_cut_off' | 'bowl_size_assumed').
 */
const PlateCalibration = t.object('PlateCalibration', {
  method: t.string(),
  plateDiameterCm: t.f64(),
  plateDiameterPx: t.f64(),
  cm2PerPx: t.f64(),
  dishType: t.option(t.string()), // 'plate' | 'bowl' | 'other'
  fullyVisible: t.option(t.bool()),
  flags: t.array(t.string()),
});

/**
 * Waste-impact outputs of one analysis attempt (BIG-PLAN D2/D7):
 * contracts AnalysisAttempt.calibration and AnalysisAttempt.overlayObjectId.
 * A separate small table (like capture_count) so the existing
 * analysis_attempt rows stay untouched: additive, publishes in place.
 * Impact is NOT stored (analytics derives relative impact points from pixels
 * at read time). BIG-PLAN v2 (2026-10-04): `calibration` is deprecated and
 * left empty by new attempts (no plate-size calibration); the column stays so
 * the table keeps publishing in place and legacy rows parse.
 * The overlay JPEG lives in object storage (image_object association kind
 * 'overlay'); only its object id is here. Written in the same record_analysis
 * transaction as its attempt. Legacy attempts have no row.
 */
const attemptCalibration = table(
  { name: 'attempt_calibration' },
  {
    attemptId: t.string().primaryKey(),
    eventId: t.string().index('btree'),
    calibration: t.option(PlateCalibration),
    overlayObjectId: t.option(t.string()),
  },
);

/** contracts CameraIntrinsics (IT_4 I3). source: 'nominal-fov' | 'checkerboard' | 'configured'. */
const CameraIntrinsics = t.object('CameraIntrinsics', {
  cameraModel: t.string(), // 'logitech-c920s' | 'other'
  widthPx: t.u32(),
  heightPx: t.u32(),
  fxPx: t.f64(),
  fyPx: t.f64(),
  cxPx: t.f64(),
  cyPx: t.f64(),
  source: t.string(),
});

/** UNUSED legacy type (Depth Anything V2 removed); kept so the schema publishes in place. */
const DepthPlane = t.object('DepthPlane', { a: t.f64(), b: t.f64(), c: t.f64() });

/** UNUSED legacy type (Depth Anything V2 removed); camera_calibration.depth is always none for new rows. */
const CalibrationDepth = t.object('CalibrationDepth', {
  checkpoint: t.string(),
  settingsVersion: t.string(),
  rawReferenceMedianM: t.f64(),
  scale: t.f64(),
  cameraHeightCmDepth: t.f64(),
  tablePlane: DepthPlane,
  depthObjectId: t.string(),
});

/**
 * contracts CameraCalibration (IT_4 I2, `reference-area-v1`): a reference
 * object of user-entered area at the base plane → cm² per pixel for ONE camera
 * and ONE resolution. Photos and the reference outline/mask are image_object
 * rows (kinds 'calibration', 'calibration_overlay'); only their ids are here.
 * `depth` is an UNUSED legacy column (always none for new rows). Rows are
 * never rewritten after they succeed, so attempts that snapshotted a
 * calibrationId stay reproducible.
 */
const cameraCalibration = table(
  { name: 'camera_calibration', public: true },
  {
    calibrationId: t.string().primaryKey(),
    hallId: t.string().index('btree'),
    cameraId: t.string(),
    createdAt: t.string(), // UTC ISO 8601
    status: t.string(), // 'processing' | 'succeeded' | 'failed'
    method: t.string(), // 'reference-area-v1'
    imageObjectId: t.string(),
    overlayObjectId: t.option(t.string()),
    referenceMaskObjectId: t.option(t.string()),
    widthPx: t.u32(),
    heightPx: t.u32(),
    knownAreaCm2: t.f64(), // user input, > 0
    referenceLabel: t.string(),
    referencePixels: t.u32(), // N_ref (0 only on a failed calibration)
    cm2PerPx: t.f64(), // k (0 only on a failed calibration)
    intrinsics: CameraIntrinsics,
    cameraHeightCmGeometric: t.f64(),
    depth: t.option(CalibrationDepth), // UNUSED legacy column (Depth Anything V2 removed)
    flags: t.array(t.string()), // contracts CameraCalibrationFlag[]
    error: t.option(StoredApiError),
  },
);

/** contracts MeasurementSettings (IT_4 I9): one row per hall. */
const measurementSettings = table(
  { name: 'measurement_settings', public: true },
  {
    hallId: t.string().primaryKey(),
    depthEnabled: t.bool(), // UNUSED legacy column (Depth Anything V2 removed); written false
    activeCalibrationId: t.option(t.string()), // a succeeded camera_calibration of this hall
    plateThicknessCm: t.f64(), // UNUSED legacy column; written 0
    updatedAt: t.string(), // UTC ISO 8601
  },
);

// ---------------------------------------------------------------------------
// Schema assembly
// ---------------------------------------------------------------------------

const spacetimedb = schema({
  mealService,
  menuItem,
  menuItemRevision,
  referencePortion,
  imageObject,
  captureEvent,
  analysisAttempt,
  foodMeasurement,
  attendance,
  portionsServed,
  insight,
  captureCount,
  segmentationRegion,
  attemptCalibration,
  cameraCalibration,
  measurementSettings,
});

export default spacetimedb;

// Reducers (Agent 5) live in reducers.ts — one per Repository mutation in
// backend/src/repo/repository.ts (db/README.md "Swap plan"); index.ts is the
// module entry that exports both. Reducers must not perform network I/O.
