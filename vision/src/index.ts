/**
 * @scrap/vision — Agent 4 public surface.
 *
 * - createGeminiGateway: server-side Gemini transport (live or mock) with
 *   normalized errors, timeout, and bounded retries. `generateText` is the
 *   reusable interface for Agent 6's suggestions.
 * - analyzeCaptureWithMasks: Gemini classification + boxes + target dish ->
 *   SAM 2.1 masks -> target-dish clip -> counted Pixels wasted (rule
 *   target-dish-v1), plus the segmented overlay JPEG. Pixels only: no plate
 *   calibration (BIG-PLAN v2).
 * - analyzeCapture: legacy Gemini area estimates (not the measurement path).
 */

export {
  createGeminiGateway,
  defaultMockTransport,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
} from './gateway.js';
export type {
  GeminiGateway,
  GeminiGatewayOptions,
  GenerateTextOptions,
  GatewayMode,
  GatewayPart,
  GatewayTextPart,
  GatewayInlineDataPart,
  GatewayRequest,
  MockTransport,
} from './gateway.js';

export { analyzeCapture } from './analyze.js';

export { analyzeCaptureWithMasks } from './maskPipeline.js';
export type { MaskAnalysisInput, MaskAnalysisResult, MaskAnalysisDiagnostics, LocalizationStats } from './maskPipeline.js';
export { NEIGHBOR_CLIP_MIN_FRACTION, LIQUID_PATTERN, isLiquidMenuItem } from './maskPipeline.js';
export type { PhysicalCalibration, PhysicalStageInput, PhysicalStageResult, PhysicalUnavailable } from './maskPipeline.js';

// IT_4: camera calibration, Depth Anything V2 client, calibrated area / volume.
export {
  C920S,
  C920S_NATIVE_FOCAL_PX,
  CALIBRATION_METHOD,
  CALIBRATION_PROMPT_VERSION,
  CALIBRATION_SYSTEM_INSTRUCTION,
  CREDIT_CARD_AREA_CM2,
  DEPTH_DISAGREE_FRACTION,
  REFERENCE_MASK_VERSION,
  buildCalibrationPrompt,
  buildCalibrationSchema,
  c920sIntrinsics,
  calibrationLegendRows,
  cleanReferenceMask,
  fillHoles,
  fitTablePlane,
  geometricHeightCm,
  intrinsicsOverridesFromEnv,
  runCalibration,
  validateCalibrationText,
} from './calibration.js';
export type {
  CalibrationDiagnostics,
  CalibrationFields,
  CalibrationRunResult,
  IntrinsicsOverrides,
  ReferenceLocateOutcome,
  RunCalibrationInput,
  TablePlaneFit,
} from './calibration.js';
export {
  DEPTH_CHECKPOINT,
  DEPTH_PNG_UNITS_PER_M,
  DEPTH_PNG_VERSION,
  DEPTH_SETTINGS_VERSION,
  createDepthWorkerClient,
  decodeDepthPng16,
  decodeDepthResponse,
  depthToUnits,
  encodeDepthPng16,
} from './depthClient.js';
export type { DecodedDepthPng, DepthEstimator, DepthInfo, DepthMap, DepthWorkerClientOptions } from './depthClient.js';
export {
  AREA_METHOD,
  VOLUME_METHOD,
  DEFAULT_MAX_FOOD_HEIGHT_CM,
  DEFAULT_PLATE_THICKNESS_CM,
  MIN_RING_FRACTION,
  computeAreaEstimate,
  computeVolumeEstimates,
  erodeSquare,
  fitPlaneLeastSquares,
  fitPlaneRobust,
  planeAt,
} from './volume.js';
export type { AreaCalibration, Plane, PlateReferenceInfo, RobustPlaneFit, VolumeBucket, VolumeInput, VolumeResult } from './volume.js';
export type { TargetDishInfo } from './maskPipeline.js';
export {
  DISH_REGION_VERSION,
  MAX_REGION_FRACTION,
  MIN_BOX_COVERAGE,
  MIN_REGION_FRACTION,
  buildDishRegion,
  clipToRegion,
  convexHullFill,
  dilateSquare,
  dishDilatePx,
  dropSpecks,
  labelComponents,
  largestComponent,
} from './targetDish.js';
export type { DishRegionResult } from './targetDish.js';
export { OVERLAY_VERSION, OTHER_DISH_COLOR, colorForIndex, composeWithLegend, fitLegendText, layoutLegend, legendLines, legendRows, renderOverlay } from './overlay.js';
export type { LabelSuffix, LegendLayout, LegendLine, OverlayBucket, OverlayImage, RenderOverlayInput, RenderOverlayResult } from './overlay.js';
export { createSamWorkerClient } from './samClient.js';
export type { Segmenter, SegmenterInfo, SegmentResponse } from './samClient.js';
export { COUNTING_RULE_VERSION, SMALLEST_FIRST_RULE, BOX_CONVENTION, boxIoU, countPixels, decodeBinaryMask, encodeBinaryMask, geminiBoxToPixels } from './masks.js';
export { LOCALIZE_PROMPT_VERSION, LOCALIZE_SYSTEM_INSTRUCTION, TARGET_DISH_LINE, validateLocalizeText, buildLocalizeSchema } from './localize.js';
export type { LocalizedDish, LocalizedRegion, LocalizeOutcome } from './localize.js';

export {
  assessLeftovers,
  buildLeftoverSchema,
  validateLeftoverText,
  LEFTOVER_PROMPT_VERSION,
} from './leftovers.js';
export type { AssessLeftoversInput, AssessLeftoversResult, LeftoverAssessment } from './leftovers.js';

export {
  judgeSameDish,
  buildDishMatchSchema,
  validateDishMatchText,
  DISH_MATCH_PROMPT_VERSION,
} from './dishMatch.js';
export type { DishMatchVerdict, JudgeSameDishInput, JudgeSameDishResult, SameDishVerdict } from './dishMatch.js';
export type { AnalyzeCaptureInput, AnalyzeCaptureResult } from './analyze.js';

export { GatewayError, makeApiError, normalizeProviderError } from './errors.js';

export {
  clamp,
  computeMeasurement,
  computeUnknownMeasurement,
  baselineFromReference,
  MEASUREMENT_METHOD,
} from './measurement.js';
export type { BaselineInput, MeasurementIdentity } from './measurement.js';

export { imageInputToPart } from './image.js';
export type { ImageInput } from './image.js';

export {
  PROMPT_VERSION,
  CLASSIFICATION_SYSTEM_INSTRUCTION,
  buildClassificationPrompt,
  buildResponseSchema,
  sanitizeMenuText,
  sanitizeMenuItems,
} from './prompt.js';

export { validateClassificationText, maxPlausibleAreaPx } from './validate.js';
export type { ClassificationResult, ClassifiedItem, UnknownFood, ValidationOutcome } from './validate.js';

export type * from './contracts.js';
export { NEIGHBOR_FOOD_EXCLUDED, TARGET_DISH_UNAVAILABLE } from './contracts.js';
