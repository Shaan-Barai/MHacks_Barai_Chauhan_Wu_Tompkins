/**
 * VERBATIM COPY of the shapes this package needs from `contracts/types.ts`
 * (owner: Agent 1). Do not edit these definitions here; if the contract
 * changes, Agent 1 updates `contracts/types.ts` and this file is re-synced.
 *
 * Copied rather than imported relatively so `capture/` stays a self-contained
 * package with its own tsconfig/rootDir (allowed per assignment).
 */

export type CaptureSource = 'camera' | 'replay' | 'manual_upload';
export type ProcessingState = 'pending' | 'processing' | 'succeeded' | 'needs_review' | 'failed';

export interface ImageGeometry {
  widthPx: number;
  heightPx: number;
  coordinateSpace: 'topdown-normalized-v1';
  plateShape?: 'round' | 'tray' | 'other';
  plateDiameterPx?: number;
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
  | 'neighbor_food_excluded'
  | 'target_dish_unavailable';

export interface CaptureEvent {
  /** Idempotency key: retries update this event, never duplicate it. */
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

/** Shared error envelope for every API response and stored failure. */
export interface ApiError {
  /** Machine-readable, SCREAMING_SNAKE, e.g. "MENU_NOT_FOUND". */
  code: string;
  /** Plain-language message safe to show dining staff. */
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

/** POST /api/dish-match payloads (BRIDGE.md §4.3). Thumbnails are transient. */
export interface DishMatchImage {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
}

export interface DishMatchRequest {
  reference: DishMatchImage;
  candidate: DishMatchImage;
}

/** `sameDish` is present only when a plate is visible in the candidate. */
export type DishMatchResult = (
  | { plateVisible: false }
  | { plateVisible: true; sameDish: 'same' | 'different' | 'unsure' }
) & {
  reason: string;
  model: string;
  promptVersion: string;
};

// IT_4 (2026-10-04): camera calibration + measurement settings (verbatim).

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
