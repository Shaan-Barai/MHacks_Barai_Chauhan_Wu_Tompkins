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
  association: { kind: 'capture' | 'reference'; id: string };
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
  | 'ambiguous_items';

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
}

/** Only method in prototype scope; always an AI estimate, never a measured mask. */
export type MeasurementMethod = 'gemini_area_estimate' | 'mask_pixel_count';

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
  /** null = unknown/non-menu food (excluded from menu percentages). */
  itemId: string | null;
  /** Legacy raw area estimate, or code-counted mask pixels when method is mask_pixel_count. */
  remainingAreaPx: number;
  baselineId?: string;
  /** Finite and > 0 when present; missing baseline => no percentage. */
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

/**
 * POST /api/dish-match (BRIDGE.md §4.3). The camera bridge asks whether a
 * candidate frame shows the same physical dish as the open dish group's
 * representative frame, so each dish is counted once. Thumbnails are
 * transient: never stored, logged, or written to SpacetimeDB.
 */
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
