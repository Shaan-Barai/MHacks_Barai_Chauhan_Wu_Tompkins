/**
 * Verbatim subset of `contracts/types.ts` (owner: Agent 1) that analytics
 * consumes. Keep shapes in sync with the shared contracts — do not invent
 * alternate fields here.
 */

export type MealLabel = 'breakfast' | 'lunch' | 'dinner';

export interface MealService {
  serviceId: string;
  hallId: string;
  hallTimezone: string;
  serviceDate: string;
  mealLabel: MealLabel;
  menuId: string;
  menuVersion: number;
}

export interface MenuItem {
  itemId: string;
  menuId: string;
  displayName: string;
  category?: string;
  description?: string;
}

export type QualityFlag =
  | 'blurred'
  | 'no_plate'
  | 'multiple_dishes'
  | 'incompatible_geometry'
  | 'above_baseline'
  | 'missing_baseline'
  | 'gemini_estimated_baseline'
  | 'ai_estimate'
  | 'empty_plate'
  | 'ambiguous_items'
  /** A region's segmentation failed or produced an invalid mask (no pixels counted for it). */
  | 'segmentation_failed'
  /** Masks of different foods overlapped; shared pixels went to the unclassified bucket. */
  | 'overlapping_masks'
  /** Target-dish counting (BIG-PLAN v2): food on other dishes in the frame was left out. */
  | 'neighbor_food_excluded'
  /** Target-dish counting: the scanned dish couldn't be found, so masks were not clipped to it. */
  | 'target_dish_unavailable';

export type ProcessingState = 'pending' | 'processing' | 'succeeded' | 'needs_review' | 'failed';

export type CaptureSource = 'camera' | 'replay' | 'manual_upload';

export interface ImageGeometry {
  widthPx: number;
  heightPx: number;
  coordinateSpace: 'topdown-normalized-v1';
  plateShape?: 'round' | 'tray' | 'other';
  plateDiameterPx?: number;
}

export interface CaptureEvent {
  eventId: string;
  hallId: string;
  serviceId: string;
  capturedAt: string;
  imageObjectId: string;
  geometry: ImageGeometry;
  source: CaptureSource;
  qualityFlags: QualityFlag[];
  state: ProcessingState;
}


export type AnalysisStatus = 'succeeded' | 'needs_review' | 'failed';

export interface AnalysisAttempt {
  eventId: string;
  attemptId: string;
  menuId: string;
  menuVersion: number;
  /** itemId -> baselineVersion actually used, frozen at analysis time. */
  baselineVersions: Record<string, number>;
  model: string;
  promptVersion: string;
  status: AnalysisStatus;
  error?: ApiError;
  qualityFlags: QualityFlag[];
  createdAt: string;
  /**
   * Segmentation stage + pixel count (contracts/measurement.md). Absent on
   * legacy attempts that only carry Gemini area estimates. `model` and
   * `promptVersion` above describe the classification stage.
   */
  segmentation?: SegmentationResult;
  /** DEPRECATED (BIG-PLAN v2): no longer produced. Legacy attempts only. */
  calibration?: PlateCalibration;
  /** Object id of the segmented overlay JPEG in object storage (BIG-PLAN D7). */
  overlayObjectId?: string;
  /** IT_4 I9: calibration + physical method snapshotted at analysis time. */
  calibrationId?: string;
  physicalMethod?: PhysicalMethod;
}

/**
 * Gemini box [ymin, xmin, ymax, xmax] on a 0-1000 scale, converted to SAM's
 * pixel XYXY [x0, y0, x1, y1] for the exact analyzed image (MVP_AI.md step 3).
 */
export interface RegionBox {
  gemini: [number, number, number, number];
  pixelXyxy: [number, number, number, number];
  convention: 'gemini-yxyx-1000_to_xyxy-px_v1';
}

export type StageStatus = 'succeeded' | 'failed' | 'skipped';

/** One food region found by classification, and its segmentation outcome. */
export interface ClassificationRegion {
  regionId: string;
  eventId: string;
  attemptId: string;
  /** Menu item, or null for edible food not matching the menu (unclassified bucket). */
  itemId: string | null;
  /** Short visual description from classification, e.g. "scattered fries". */
  visualLabel: string;
  box: RegionBox;
  segmentationStatus: StageStatus;
  /** Full-canvas binary PNG mask (255 = food) in object storage. */
  maskObjectId?: string;
  /** Foreground pixels in this region's own mask, before cross-item overlap resolution. */
  maskPixels?: number;
  /** Segmenter's own score; not calibrated accuracy. */
  score?: number;
  error?: ApiError;
}

/** How a capture's pixel total is reported (contracts/measurement.md). */
export type CountStatus =
  /** Every region segmented; capturePixelsWasted is the full union. */
  | 'complete'
  /** Classification explicitly found no food; zero pixels is a real measurement. */
  | 'empty'
  /** Some regions failed: counted pixels are a lower bound, excluded from totals. */
  | 'partial'
  /** Nothing countable (classification or all segmentation failed). */
  | 'unavailable';

export interface SegmentationResult {
  /** e.g. 'sam2.1-hiera-small'. */
  model: string;
  /** Checkpoint id + segmenter code revision, for reproducibility. */
  checkpoint: string;
  codeRevision: string;
  promptSource: 'gemini_box';
  /** Versioned mask settings, e.g. 'sam2-box-v1: multimask=false, logit>0, no postprocess'. */
  settingsVersion: string;
  /** Overlap/union counting rule version. */
  countingRuleVersion: string;
  status: 'succeeded' | 'partial' | 'failed' | 'skipped';
  countStatus: CountStatus;
  /** Union of eligible food masks; present for complete, empty (0), and partial (lower bound). */
  capturePixelsWasted?: number;
  /** Analyzed canvas the masks and boxes refer to. */
  widthPx: number;
  heightPx: number;
  regions: ClassificationRegion[];
}

/**
 * 'mask_pixel_count': remainingAreaPx is an integer count of mask foreground
 * pixels assigned to the item (Pixels wasted), with provenance in maskCount.
 * The mask boundary is an AI estimate; counting it is deterministic.
 * 'gemini_area_estimate': legacy Gemini-guessed area (no longer primary).
 */
export type MeasurementMethod = 'mask_pixel_count' | 'gemini_area_estimate';

export interface MaskPixelCount {
  pixelsWasted: number;
  maskObjectId: string;
  geometry: ImageGeometry;
  menuId: string;
  menuVersion: number;
  classificationVersion: string;
  segmentationVersion: string;
  processingVersion: string;
  assignment: 'exclusive';
  validated: true;
}

export interface PortionsServed {
  recordId: string;
  hallId: string;
  serviceId: string;
  serviceDate: string;
  menuId: string;
  menuVersion: number;
  itemId: string;
  count: number;
  source: 'manual' | 'csv' | 'demo';
  updatedAt: string;
}

export interface FoodMeasurement {
  measurementId: string;
  eventId: string;
  attemptId: string;
  /** null = unclassified edible food (its own bucket; never a named item). */
  itemId: string | null;
  /** mask_pixel_count: Pixels wasted (integer). Legacy: raw estimate. Finite and >= 0. */
  remainingAreaPx: number;
  /** mask_pixel_count: the regions whose union produced this count. */
  regionIds?: string[];
  baselineId?: string;
  /** Optional auxiliary baseline; never required for Pixels wasted. Finite and > 0 when present. */
  baselineAreaPx?: number;
  /** remainingAreaPx / baselineAreaPx, unclamped. >1 must carry 'above_baseline'. */
  rawWasteFraction?: number;
  /** 100 * clamp(rawWasteFraction, 0, 1). Absent when baseline missing/invalid. */
  displayWastePercent?: number;
  /** Required whenever displayWastePercent is absent. */
  unavailableReason?: string;
  method: MeasurementMethod;
  maskCount?: MaskPixelCount;
  qualityFlags: QualityFlag[];
  /** IT_4: calibrated area. Absent when no compatible calibration was active. */
  physical?: PhysicalEstimate;
}

export interface Attendance {
  hallId: string;
  serviceId: string;
  serviceDate: string;
  count: number;
  source: 'simulated';
  configuredMin: number;
  configuredMax: number;
  seed?: string;
  generatorVersion: string;
}

export interface Insight {
  insightId: string;
  hallId: string;
  windowStart: string;
  windowEnd: string;
  metrics: Record<string, number | string>;
  dataVersion: string;
  recommendation: string;
  source: 'gemini' | 'fallback_rules';
  generatedAt: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Waste impact (BIG-PLAN.md; v2 2026-10-04). Pixels wasted is the measurement
// and the headline unit. Relative impact points are derived at read time by
// analytics from pixels and the factor tables (menu_waste_factors.csv,
// menu_nutrition_factors.csv). No plate-size calibration, no grams.
// ---------------------------------------------------------------------------

export type CalibrationFlag = 'calibration_default' | 'plate_cut_off' | 'bowl_size_assumed';

/**
 * Per-capture pixel→area calibration. DEPRECATED 2026-10-04 (BIG-PLAN v2):
 * not produced or used; kept only so legacy attempts still parse.
 */
export interface PlateCalibration {
  /** 'plate-fit-v1' = Gemini plate box → SAM plate mask → outer-rim circle fit. */
  method: 'plate-fit-v1' | 'configured-default';
  /** Physical plate diameter assumed for the fit (26.7 cm / 10.5"). */
  plateDiameterCm: number;
  plateDiameterPx: number;
  /** (plateDiameterCm / plateDiameterPx)^2 */
  cm2PerPx: number;
  dishType?: 'plate' | 'bowl' | 'other';
  fullyVisible?: boolean;
  flags: CalibrationFlag[];
}

/** One row of menu_waste_factors.csv. Score excludes nutrition (D1). */
export interface WasteFactor {
  /** slug(food), e.g. 'ancho-flank-steak'; menu items match via slug(displayName) (D4). */
  factorKey: string;
  food: string;
  station: string;
  weightGPerCm2: number;
  /** C: kg CO2e per kg of food as served. */
  kgCo2ePerKg: number;
  /** W: m³ freshwater withdrawn per kg. */
  waterM3PerKg: number;
  /** 0.19·C + 1.50·W, dollars per kg. No nutrition term. */
  impactUsdPerKg: number;
  largestFactor: 'carbon' | 'water';
}

/** One row of menu_nutrition_factors.csv. Reported separately; never in the score. */
export interface NutritionFactor {
  factorKey: string;
  nutrientDaysPerKg: number;
  kcalPerKg: number;
}

export type ImpactUnavailableReason = 'no_factor' | 'unknown_item';

/**
 * Derived (never stored) relative impact for a set of counted pixels
 * (BIG-PLAN v2, 2026-10-04: pixels only, no plate-size calibration).
 * "Points" are UNITLESS and only comparable with each other:
 *   points = (pixels / 1000) × weight_g_per_cm2 × factor
 * co2Points uses C, waterPoints uses W, impactPoints uses 0.19·C + 1.50·W.
 * They are never kg, litres or dollars.
 */
export interface WasteImpact {
  pixels: number;
  co2Points: number | null;
  waterPoints: number | null;
  impactPoints: number | null;
  /** Separate statistic from nutrient-days/kg. NOT part of impactPoints. */
  nutritionPoints: number | null;
  wasteFactorsVersion: string;
  unavailableReason?: ImpactUnavailableReason;
  /**
   * IT_4 I7: ESTIMATED physical amounts from the calibrated area.
   * null (never 0) when unavailable; see physicalUnavailableReason.
   *   grams = areaCm2 × weightGPerCm2
   *   kgCo2e = grams/1000 × C;  waterLitres = grams × W  (W is m³/kg)
   * Sums over mixed captures include only calibrated ones (see coverage).
   */
  grams: number | null;
  kgCo2e: number | null;
  waterLitres: number | null;
  physicalMethod: PhysicalMethod | null;
  physicalUnavailableReason?: PhysicalUnavailableReason;
}

/** Per-portion rates over the same hall/date/service/menu version. */
export interface PerPortion {
  pixels: number;
  impactPoints: number | null;
  /** IT_4: estimated grams per portion (sum-then-divide over calibrated captures); null when unavailable. */
  grams: number | null;
}

export interface ItemImpactRow {
  /** null = unknown / not-on-menu food bucket. */
  itemId: string | null;
  displayName: string;
  factorKey: string | null;
  impact: WasteImpact;
  /** Summed portions served across the window; null when missing. */
  portionsServed: number | null;
  portionsSource: 'manual' | 'csv' | 'demo' | null;
  /** null when portions are missing or zero, or the item is unknown. */
  perPortion: PerPortion | null;
}

/** GET /api/dashboard/impact?start&end[&hallId] */
export interface ImpactDashboard {
  window: { start: string; end: string; hallId?: string };
  totals: WasteImpact & {
    captures: number;
    analyzedCaptures: number;
    excludedCaptures: number;
    /** IT_4: analyzed captures that carried physical estimates (calibrated). */
    physicalCoverage: { calibratedCaptures: number; analyzedCaptures: number };
  };
  /** Ranked by perPortion.pixels desc ("Foods to target"); unavailable rates last. */
  targets: ItemImpactRow[];
  /** Ranked by impact.pixels desc ("Most wasted"). */
  mostWasted: ItemImpactRow[];
  coverage: {
    itemsWithFactor: number;
    itemsWithoutFactor: number;
    itemsWithPortions: number;
    /** Captures where food outside the scanned (target) dish was excluded. */
    capturesWithNeighborFoodExcluded: number;
  };
  labels: { relativeImpact: true; demoPortions: boolean };
}

/** GET /api/captures?start&end — recent plates for the dashboard gallery. */
export interface CaptureListItem {
  eventId: string;
  capturedAt: string;
  serviceId: string;
  source: CaptureSource;
  state: ProcessingState;
  pixelsWasted: number | null;
  items: Array<{
    itemId: string | null;
    displayName: string;
    pixels: number;
    /** IT_4 I8: estimated physical numbers shown next to the food label; null when unavailable. */
    grams?: number | null;
    kgCo2e?: number | null;
    waterLitres?: number | null;
    areaCm2?: number | null;
  }>;
  hasOverlay: boolean;
  calibrationId?: string | null;
  physicalMethod?: PhysicalMethod | null;
}

export interface SignedImage {
  objectId: string;
  url: string;
  expiresAt: string;
}

/** GET /api/captures/:eventId/images */
export interface CaptureImages {
  eventId: string;
  original: SignedImage | null;
  overlay: SignedImage | null;
  masks: Array<SignedImage & { itemId: string | null; displayName: string }>;
}

/** GET /api/recommendation?start&end[&hallId] */
export interface Recommendation {
  text: string;
  bullets: Array<{ text: string; metric: string }>;
  source: 'gemini' | 'fallback';
  generatedAt: string;
  inputVersion: string;
}

// ---------------------------------------------------------------------------
// IT_4 (2026-10-04): camera calibration, calibrated area, estimated
// grams / CO2e / water. See IT_4.md. Depth Anything V2 volume was removed
// (2026-10-04, user decision). Legacy rows written during the brief depth
// trial may carry method 'volume-dav2-v1', volume/height fields, a
// depthObjectId or 'depth' image objects: readers treat any stored estimate
// with a finite areaCm2 as 'area-calibrated-v1' and ignore the rest.
// ---------------------------------------------------------------------------

export interface CameraIntrinsics {
  cameraModel: 'logitech-c920s' | 'other';
  widthPx: number;
  heightPx: number;
  /** C920s nominal: 78° diagonal FOV ⇒ ≈1360 px at 1920 wide; 1289.7 px for the 1024² capture crop. */
  fxPx: number;
  fyPx: number;
  cxPx: number;
  cyPx: number;
  source: 'nominal-fov' | 'checkerboard' | 'configured';
}

/** Distinct from the legacy plate-fit CalibrationFlag above. */
export type CameraCalibrationFlag =
  | 'reference_not_found'
  | 'reference_low_confidence'
  | 'reference_touches_edge';

/** POST /api/calibrations → this. One camera, one resolution (IT_4 I2). */
export interface CameraCalibration {
  calibrationId: string;
  hallId: string;
  /** e.g. 'uno-q-c920s-1' */
  cameraId: string;
  createdAt: string;
  status: 'processing' | 'succeeded' | 'failed';
  method: 'reference-area-v1';
  imageObjectId: string;
  overlayObjectId?: string;
  referenceMaskObjectId?: string;
  widthPx: number;
  heightPx: number;
  /** User input; finite and > 0. Credit card = 46.21 cm². */
  knownAreaCm2: number;
  referenceLabel: string;
  /** N_ref: integer foreground pixels of the reference mask. */
  referencePixels: number;
  /** k = knownAreaCm2 / referencePixels (cm² per pixel at the base plane). */
  cm2PerPx: number;
  intrinsics: CameraIntrinsics;
  /** Camera height above the base plane, f · √k (cm). */
  cameraHeightCmGeometric: number;
  flags: CameraCalibrationFlag[];
  error?: ApiError;
}

/** GET/PUT /api/settings/measurement — per hall (IT_4 I9). */
export interface MeasurementSettings {
  hallId: string;
  activeCalibrationId: string | null;
  updatedAt: string;
}

export type PhysicalMethod = 'area-calibrated-v1';

export type PhysicalUnavailableReason =
  | 'no_calibration'
  | 'incompatible_geometry'
  | 'no_factor'
  | 'unknown_item';

/** Stored per food measurement. Pixels (remainingAreaPx) stay the raw measurement. */
export interface PhysicalEstimate {
  calibrationId: string;
  method: PhysicalMethod;
  /** pixels × k (cm²), food treated as lying on the base plane. */
  areaCm2: number;
}
