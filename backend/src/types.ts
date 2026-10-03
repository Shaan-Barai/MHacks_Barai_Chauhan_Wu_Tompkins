/**
 * Backend-local types. All shared entity shapes come verbatim from
 * contracts/types.ts (owned by Agent 1) — this module only re-exports them
 * and adds backend-internal composites that never leave this package
 * except through the documented API payloads.
 */

export type {
  MealLabel,
  MealService,
  MenuItem,
  ReferenceSource,
  ImageGeometry,
  ReferencePortion,
  UploadState,
  ImageObject,
  CaptureSource,
  ProcessingState,
  QualityFlag,
  CaptureEvent,
  AnalysisStatus,
  AnalysisAttempt,
  MeasurementMethod,
  FoodMeasurement,
  Attendance,
  Insight,
  ApiError,
} from '../../contracts/types.js';

import type {
  MealService,
  MenuItem,
  AnalysisAttempt,
  FoodMeasurement,
} from '../../contracts/types.js';

/** A daily menu as uploaded and served: the service plus its items. */
export interface MenuBundle {
  service: MealService;
  items: MenuItem[];
}

/** Everything Agent 4's analyzer returns for one attempt (contract 4.5). */
export interface AnalysisResult {
  attempt: AnalysisAttempt;
  measurements: FoodMeasurement[];
}
