/**
 * Shared contract types for the Scrap food-waste prototype.
 * Owner: Agent 1 (coordinator). Consumers: Agents 2–8.
 *
 * Conventions (see contracts/README.md):
 * - All timestamps are UTC ISO 8601 strings.
 * - All areas are pixels in the normalized top-down coordinate space
 *   ("topdown-normalized-v1") shared by observation and reference images.
 * - IDs join records; never match on display names.
 */

export type MealLabel = 'breakfast' | 'lunch' | 'dinner';

export interface MealService {
  serviceId: string; // stable, e.g. "svc_hall-main_2026-10-03_lunch"
  hallId: string;
  hallTimezone: string; // IANA name, e.g. "America/Detroit"
  serviceDate: string; // local date YYYY-MM-DD in hallTimezone
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

export type UploadState = 'pending_upload' | 'uploaded' | 'finalized' | 'failed' | 'orphaned';

/** Durable reference to an image in external object storage. Never bytes. */
export interface ImageObject {
  objectId: string;
  provider: 'r2' | 's3' | 'supabase' | 'firebase' | 'local-dev';
  container: string;
  /** Stable object key. Never store an expiring signed URL as identity. */
  objectKey: string;
  /** Present only when public delivery is deliberately chosen. */
  publicUrl?: string;
  mimeType: string;
  sizeBytes: number;
  widthPx?: number;
  heightPx?: number;
  uploadedAt?: string;
  /** 'mask' = a binary segmentation mask PNG produced for one classification region. */
  association: { kind: 'capture' | 'reference' | 'mask'; id: string };
  state: UploadState;
}

export type CaptureSource = 'camera' | 'replay' | 'manual_upload';
export type ProcessingState = 'pending' | 'processing' | 'succeeded' | 'needs_review' | 'failed';

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
  | 'overlapping_masks';

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

/** Full-service count, keyed by service + menu version + stable menu item ID. */
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
  /** Only available after mask validation/counting. Legacy area estimates cannot supply it. */
  maskCount?: MaskPixelCount;
  qualityFlags: QualityFlag[];
}

export interface Attendance {
  hallId: string;
  serviceId: string;
  serviceDate: string;
  count: number;
  /** Prototype only generates simulated values; label everywhere. */
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
  /** The aggregate facts the recommendation text is grounded in. */
  metrics: Record<string, number | string>;
  dataVersion: string;
  recommendation: string;
  source: 'gemini' | 'fallback_rules';
  generatedAt: string;
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
