/**
 * @scrap/analytics — Agent 6 public API.
 *
 * Pure analytics: aggregates, simulated attendance, and grounded suggestions.
 * Agent 5 owns HTTP routing and persistence; Agent 4 owns Gemini transport.
 */

export type {
  AnalysisAttempt,
  SegmentationResult,
  ClassificationRegion,
  CountStatus,
  PortionsServed,
  MaskPixelCount,
  MealLabel,
  MealService,
  MenuItem,
  CaptureEvent,
  FoodMeasurement,
  Attendance,
  Insight,
  QualityFlag,
  ProcessingState,
  ApiError,
} from './contracts.js';

export { summarizePortionBenchmarks, portionDataVersion, validMaskCount, type PortionBenchmark, type PortionBenchmarkItem } from './portions.js';
export { generatePortionInsight } from './portionSuggestions.js';
export { plateWastePercent, averagePlateWaste, type PlateWasteAverage } from './plateWaste.js';
export { readableItemName } from './names.js';

export {
  classifyMeasurement,
  classifyCapture,
  geometryCompatible,
  emptyExclusionCounts,
  isFiniteNonNegative,
  isFinitePositive,
  AGGREGATE_COORDINATE_SPACE,
  type ExclusionReason,
  type EligibilityResult,
} from './eligibility.js';

export {
  summarizeService,
  buildWasteTrend,
  computeDataVersion,
  METRIC_LABELS,
  type AggregateInput,
  type ServiceSummary,
  type ItemWasteComparison,
  type WasteTrendPoint,
} from './aggregates.js';

export {
  generateAttendance,
  AttendanceCache,
  resolveAttendanceSeed,
  attendanceEntropyKey,
  hashString,
  mulberry32,
  ATTENDANCE_GENERATOR_VERSION,
  DEFAULT_ATTENDANCE_MIN,
  DEFAULT_ATTENDANCE_MAX,
  type AttendanceConfig,
} from './attendance.js';

export {
  generateInsight,
  buildInsightMetrics,
  buildSuggestionPrompt,
  buildFallbackRecommendation,
  InsightCache,
  SUGGESTION_PROMPT_VERSION,
  type TextGateway,
  type SuggestionRequest,
  type SuggestionOptions,
} from './suggestions.js';

export {
  summarizePixels,
  computePixelDataVersion,
  PIXEL_LABELS,
  type PixelServiceSummary,
  type PixelItemTotal,
  type PixelAggregateInput,
  type PixelExclusionReason,
} from './pixels.js';

export {
  generatePixelInsight,
  buildPixelInsightMetrics,
  buildPixelFallback,
  PIXEL_SUGGESTION_PROMPT_VERSION,
  type PixelSuggestionRequest,
} from './pixelSuggestions.js';
