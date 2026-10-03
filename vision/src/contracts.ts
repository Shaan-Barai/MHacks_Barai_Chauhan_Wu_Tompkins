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
  | 'ambiguous_items';

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
export type MeasurementMethod = 'gemini_area_estimate';

export interface FoodMeasurement {
  measurementId: string;
  eventId: string;
  attemptId: string;
  /** null = unknown/non-menu food (excluded from menu percentages). */
  itemId: string | null;
  /** Raw estimate, preserved unclamped; finite and >= 0. */
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
  qualityFlags: QualityFlag[];
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
