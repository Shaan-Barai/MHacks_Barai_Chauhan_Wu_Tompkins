/**
 * Verbatim copy of the subset of `contracts/types.ts` (owner: Agent 1) that
 * the vision package consumes, so the package stays self-contained.
 *
 * DO NOT edit the shapes here independently — `contracts/types.ts` is the
 * source of truth. If the contract changes, re-copy the affected types.
 */

export interface MenuItem {
  itemId: string;
  menuId: string;
  displayName: string;
  category?: string;
  description?: string;
}

/** How a reference (uneaten) portion's expected area was obtained. */
export type ReferenceSource = 'reference_photo' | 'manual_area' | 'gemini_estimate';

export interface ImageGeometry {
  widthPx: number;
  heightPx: number;
  coordinateSpace: 'topdown-normalized-v1';
  plateShape?: 'round' | 'tray' | 'other';
  plateDiameterPx?: number;
}

export interface ReferencePortion {
  baselineId: string;
  baselineVersion: number;
  itemId: string;
  /** Expected visible area of one uneaten serving; finite and > 0. */
  expectedAreaPx: number;
  geometry: ImageGeometry;
  source: ReferenceSource;
  referenceImageObjectId?: string;
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
  /**
   * Target-dish counting (BIG-PLAN v2), attempt-level: food outside the
   * scanned dish was left out (Gemini marked boxes as on another dish, or the
   * target-dish clip removed at least 0.1% of the frame). Not an exclusion reason.
   */
  | 'neighbor_food_excluded'
  /** Target-dish counting, attempt-level: no usable dish region, so masks were not clipped; counts kept. */
  | 'target_dish_unavailable';

/** Convenience constants for the target-dish attempt flags. */
export const NEIGHBOR_FOOD_EXCLUDED: QualityFlag = 'neighbor_food_excluded';
export const TARGET_DISH_UNAVAILABLE: QualityFlag = 'target_dish_unavailable';

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
  /** DEPRECATED (BIG-PLAN v2): no longer produced by vision. Legacy attempts only. */
  calibration?: PlateCalibration;
  /** Object id of the segmented overlay JPEG in object storage (BIG-PLAN D7). */
  overlayObjectId?: string;
  /** IT_4 I9: calibration + physical method snapshotted at analysis time. */
  calibrationId?: string;
  physicalMethod?: PhysicalMethod;
  /** IT_4 I4: 16-bit depth PNG (0.1 mm units) in object storage, when DAv2 ran. */
  depthObjectId?: string;
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
 * 'mask_pixel_count': remainingAreaPx is an integer count of mask
 * foreground pixels assigned to the item (Pixels wasted). The mask boundary
 * is an AI estimate; counting it is deterministic.
 * 'gemini_area_estimate': legacy Gemini-guessed area (no longer primary).
 */
export type MeasurementMethod = 'mask_pixel_count' | 'gemini_area_estimate';

/** Internal output of validated, mutually exclusive food masks; never user-entered. */
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
  /** Only available after mask validation/counting. Legacy area estimates cannot supply it. */
  maskCount?: MaskPixelCount;
  qualityFlags: QualityFlag[];
  /** IT_4: calibrated area / DAv2 volume. Absent when no compatible calibration was active. */
  physical?: PhysicalEstimate;
}

/** Shared error envelope for every API response and stored failure. */
export interface ApiError {
  /** Machine-readable, SCREAMING_SNAKE, e.g. "MENU_NOT_FOUND". */
  code: string;
  /** Plain-language message safe to show dining staff. */
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Legacy plate calibration (BIG-PLAN D2, 2026-10-03). DEPRECATED by BIG-PLAN
// v2 (2026-10-04): pixels only, no plate-size calibration, no grams. The
// type stays so legacy attempts still parse; vision never produces it.
// ---------------------------------------------------------------------------

export type CalibrationFlag = 'calibration_default' | 'plate_cut_off' | 'bowl_size_assumed';

/** DEPRECATED legacy per-capture pixel→area calibration (never produced in v2). */
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

// ---------------------------------------------------------------------------
// IT_4 (2026-10-04): camera calibration, calibrated area, Depth Anything V2
// volume, estimated grams / CO2e / water. See IT_4.md §2–§3.
// ---------------------------------------------------------------------------

export interface CameraIntrinsics {
  cameraModel: 'logitech-c920s' | 'other';
  widthPx: number;
  heightPx: number;
  /** C920s nominal: 78° diagonal FOV ⇒ ≈1360 px at 1920 wide, scaled with width. */
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
  | 'reference_touches_edge'
  | 'depth_unavailable'
  | 'depth_scale_disagrees';

export interface CalibrationDepth {
  /** 'depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf' (Apache-2.0; Small only). */
  checkpoint: string;
  /** 'dav2-metric-small-v1' */
  settingsVersion: string;
  /** Median raw DAv2 metric depth over the reference mask, metres, before correction. */
  rawReferenceMedianM: number;
  /** cameraHeightCmGeometric / (100 × rawReferenceMedianM). Multiplies raw DAv2 depth. */
  scale: number;
  cameraHeightCmDepth: number;
  /** Base (table) plane in corrected depth: Z(x, y) = a·x + b·y + c, cm, pixel coords. */
  tablePlane: { a: number; b: number; c: number };
  /** 16-bit PNG, 0.1 mm units, in object storage. */
  depthObjectId: string;
}

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
  /** f · √k */
  cameraHeightCmGeometric: number;
  depth: CalibrationDepth | null;
  flags: CameraCalibrationFlag[];
  error?: ApiError;
}

/** GET/PUT /api/settings/measurement — per hall (IT_4 I9). */
export interface MeasurementSettings {
  hallId: string;
  /** Depth Anything V2 on/off. Off ⇒ area method. */
  depthEnabled: boolean;
  activeCalibrationId: string | null;
  /** Fallback plate-surface offset above the table plane (default 1.5). */
  plateThicknessCm: number;
  updatedAt: string;
}

export type PhysicalMethod = 'area-calibrated-v1' | 'volume-dav2-v1';

export type VolumeFlag =
  | 'plate_plane_from_calibration'
  | 'negative_heights_clipped'
  | 'height_outliers_clipped'
  | 'bowl_volume_unreliable'
  | 'depth_invalid'
  | 'depth_unavailable';

export type PhysicalUnavailableReason =
  | 'no_calibration'
  | 'incompatible_geometry'
  | 'no_factor'
  | 'no_density'
  | 'unknown_item';

/** Stored per food measurement. Pixels (remainingAreaPx) stay the raw measurement. */
export interface PhysicalEstimate {
  calibrationId: string;
  method: PhysicalMethod;
  /** area method: pixels × k; volume method: Σ (D/fx)(D/fy). */
  areaCm2: number;
  /** Σ h·a over the mask; null for the area method. */
  volumeCm3: number | null;
  meanHeightMm: number | null;
  maxHeightMm: number | null;
  depthSettingsVersion?: string;
  plateReference?: 'dish-ring-fit' | 'calibration-plane';
  flags: VolumeFlag[];
}
