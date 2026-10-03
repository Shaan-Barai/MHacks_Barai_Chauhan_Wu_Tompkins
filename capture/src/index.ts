/**
 * @scrap/capture — Agent 3's replay/file-upload capture adapter.
 * Public surface for Agents 4, 5, and 8.
 */

export type {
  ApiError,
  CaptureEvent,
  CaptureSource,
  ImageGeometry,
  ProcessingState,
  QualityFlag,
} from './contract-types.js';

export {
  CaptureError,
  CaptureErrorCodes,
  type CaptureErrorCode,
} from './errors.js';

export { newId, ulid, type IdFactory } from './ids.js';

export {
  COORDINATE_SPACE,
  NORMALIZED_MIME_TYPE,
  NORMALIZED_SIZE_PX,
  SUPPORTED_INPUT_EXTENSIONS,
  assertValidDimensions,
  normalizeImage,
  type NormalizedImage,
  type PlateGeometryHints,
} from './normalize.js';

export {
  DECLARABLE_FLAGS,
  loadManifest,
  validateManifest,
  type DeclarableFlag,
  type LoadedManifest,
  type ReplayEntry,
  type ReplayManifest,
} from './manifest.js';

export {
  InMemoryUploader,
  type FinalizedUpload,
  type UploadAuthorization,
  type UploadRequest,
  type Uploader,
} from './uploader.js';

export { InMemoryIngestionSink, type IngestionSink } from './ingestion.js';

export {
  ReplayCaptureAdapter,
  type CaptureAdapterOptions,
  type CaptureResult,
  type ManualUploadOptions,
} from './adapter.js';
