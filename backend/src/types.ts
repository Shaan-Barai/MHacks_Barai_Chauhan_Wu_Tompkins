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
  ScanInfo,
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
  DailyImpactPoint,
  CaptureListItem,
  SignedImage,
  CaptureImages,
  Recommendation,
  CameraIntrinsics,
  CameraCalibrationFlag,
  CameraCalibration,
  MeasurementSettings,
  PhysicalMethod,
  PhysicalUnavailableReason,
  PhysicalEstimate,
  TryImageStatus,
  TryImageAccepted,
  TryImageError,
  TryImageImages,
  TryImageFoodRow,
  TryImageSummary,
  TryImageJob,
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
  /** plate-scale-v1: the target plate's diameter in pixels, or why there is none (vision measurePlate). */
  plate?:
    | { ok: true; version: string; diameterPx: number; boxWidthPx: number; boxHeightPx: number }
    | { ok: false; version: string; reason: string };
  /** IT_4 physical stage outcome (calibrated area). */
  physical?: {
    status: 'applied' | 'unavailable' | 'not_requested';
    reason?: string;
  };
}

/** One plate-scale record per analysis attempt (plate_scale_estimate). Pounds are computed at read time. */
export interface PlateScaleRecord {
  attemptId: string;
  eventId: string;
  method: 'plate-scale-v1';
  dishType: string | null;
  fullyVisible: boolean | null;
  /** null when no usable plate (see unavailableReason). */
  plateDiameterPx: number | null;
  boxWidthPx: number | null;
  boxHeightPx: number | null;
  /** The plate diameter assumed when this was recorded (PLATE_DIAMETER_CM). */
  assumedPlateDiameterCm: number;
  unavailableReason: string | null;
  createdAt: string;
}
