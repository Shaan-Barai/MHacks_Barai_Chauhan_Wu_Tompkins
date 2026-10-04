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
  PortionsServed,
  MaskPixelCount,
  Attendance,
  Insight,
  ApiError,
  DishMatchImage,
  DishMatchRequest,
  DishMatchResult,
  RegionBox,
  StageStatus,
  ClassificationRegion,
  CountStatus,
  SegmentationResult,
  CalibrationFlag,
  PlateCalibration,
  WasteImpact,
  ImpactUnavailableReason,
  PerPortion,
  ItemImpactRow,
  ImpactDashboard,
  CaptureListItem,
  SignedImage,
  CaptureImages,
  Recommendation,
  CameraIntrinsics,
  CameraCalibrationFlag,
  CalibrationDepth,
  CameraCalibration,
  MeasurementSettings,
  PhysicalMethod,
  VolumeFlag,
  PhysicalUnavailableReason,
  PhysicalEstimate,
} from '../../contracts/types.js';

import type {
  MealService,
  MenuItem,
  AnalysisAttempt,
  FoodMeasurement,
  MaskPixelCount,
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
  /** Validated binary PNG masks (mask pipeline) for the backend to store. */
  masks?: { regionId: string; png: Uint8Array }[];
  /** Exclusive per-measurement masks; stored, then referenced from measurement.maskCount. */
  itemMasks?: { measurementId: string; png: Uint8Array; count: Omit<MaskPixelCount, 'maskObjectId'> }[];
  /** Segmented overlay JPEG (D7); stored in object storage, referenced by attempt.overlayObjectId. */
  overlay?: { jpeg: Uint8Array; widthPx: number; heightPx: number } | null;
  /**
   * IT_4 physical stage outcome. `depth.png` (depth-png16-v1, 0.1 mm) is stored
   * in object storage and referenced by attempt.depthObjectId.
   */
  physical?: {
    status: 'applied' | 'unavailable' | 'not_requested';
    reason?: string;
    depth: { png: Uint8Array; widthPx: number; heightPx: number } | null;
  };
}
