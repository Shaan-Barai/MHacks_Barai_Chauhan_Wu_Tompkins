/**
 * @scrap/capture — Agent 3's replay/file-upload capture adapter.
 * Public surface for Agents 4, 5, and 8.
 */

export type {
  ApiError,
  CameraCalibration,
  CameraCalibrationFlag,
  CameraIntrinsics,
  MeasurementSettings,
  CaptureEvent,
  CaptureSource,
  DishMatchImage,
  DishMatchRequest,
  DishMatchResult,
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
  HttpUploader,
  HttpIngestionSink,
  HttpDishMatcher,
  HttpCalibrationClient,
  BackendRequestError,
  type CalibrationApi,
  type CalibrationRequest,
  type DishMatcher,
  type HttpClientOptions,
  type SubmittedCapture,
} from './http.js';

export {
  DEFAULT_API_URL,
  DEFAULT_TOKEN_ENV,
  authHeaders,
  defaultTokenFiles,
  describeBackend,
  readEnvFile,
  isLocalUrl,
  resolveBackend,
  type BackendConfig,
} from './backendConfig.js';

export {
  CREDIT_CARD_AREA_CM2,
  DEFAULT_CAMERA_ID,
  DEFAULT_REFERENCE_LABEL,
  activateCalibration,
  calibrateFromFrame,
  calibrationKey,
  describeCalibration,
  validateCalibrationInput,
  type CalibrateOptions,
  type CalibrateResult,
} from './calibration.js';

export {
  ReplayCaptureAdapter,
  type CameraCaptureOptions,
  type CaptureAdapterOptions,
  type CaptureResult,
  type ManualUploadOptions,
} from './adapter.js';

export {
  CALIBRATION_PURPOSE,
  SIMULATED_CAPTURE_SOURCE,
  scanInbox,
  type FrameFocus,
  type InboxFrame,
  type InboxIssue,
  type InboxScan,
} from './inbox.js';

export { DEFAULT_PREFILTER_MAD, PREFILTER_VERSION, fingerprint, meanAbsDiff, thumbnail } from './frames.js';

export {
  DishGrouper,
  DEFAULT_CLOSE_GRACE_MS,
  type CloseReason,
  type DishGroup,
  type DishGrouperOptions,
  type FrameRecord,
  type FrameVerdict,
  type GroupEvent,
} from './dishGrouper.js';

export { InboxBridge, type BridgeEvent, type InboxBridgeOptions, type PassResult } from './inboxBridge.js';

export {
  MAX_SIMULATED_JPEG_BYTES,
  listPhotos,
  simulateCamera,
  type SimulateCameraOptions,
  type SimulatedCapture,
  type SimulatedCaptureMetadata,
} from './simulateCamera.js';
