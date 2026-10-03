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

/** Shared error envelope for every API response and stored failure. */
export interface ApiError {
  /** Machine-readable, SCREAMING_SNAKE, e.g. "MENU_NOT_FOUND". */
  code: string;
  /** Plain-language message safe to show dining staff. */
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}
