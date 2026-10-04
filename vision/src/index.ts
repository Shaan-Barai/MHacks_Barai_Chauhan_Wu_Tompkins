/**
 * @scrap/vision — Agent 4 public surface.
 *
 * - createGeminiGateway: server-side Gemini transport (live or mock) with
 *   normalized errors, timeout, and bounded retries. `generateText` is the
 *   reusable interface for Agent 6's suggestions.
 * - analyzeCapture: image + menu/baseline context -> AnalysisAttempt +
 *   FoodMeasurement[] per contracts/types.ts and AGENTS.md §7.
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
