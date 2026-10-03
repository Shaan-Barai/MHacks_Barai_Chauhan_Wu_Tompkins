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
  | 'ambiguous_items';

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

export type MeasurementMethod = 'gemini_area_estimate' | 'mask_pixel_count';

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
  itemId: string | null;
  remainingAreaPx: number;
  baselineId?: string;
  baselineAreaPx?: number;
  rawWasteFraction?: number;
  displayWastePercent?: number;
  unavailableReason?: string;
  method: MeasurementMethod;
  maskCount?: MaskPixelCount;
  qualityFlags: QualityFlag[];
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
