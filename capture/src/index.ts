/**
 * @scrap/capture — Agent 3's replay/file-upload capture adapter.
 * Public surface for Agents 4, 5, and 8.
 */

export type {
  ApiError,
  CaptureEvent,
  ScanSubmission,
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
  BackendRequestError,
  type DishMatcher,
  type SubmittedCapture,
} from './http.js';

export {
  ReplayCaptureAdapter,
  type CameraCaptureOptions,
  type IngestPhotoInput,
  type CaptureAdapterOptions,
  type CaptureResult,
  type ManualUploadOptions,
} from './adapter.js';

export { SIMULATED_CAPTURE_SOURCE, scanInbox, type InboxFrame, type InboxIssue, type InboxScan } from './inbox.js';

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

export {
  CameraConfigError,
  CameraError,
  explainSshFailure,
  findCameraDevice,
  loadCameraConfig,
  parseV4l2Devices,
  pickCameraNode,
  runOnBoard,
  spawnRunner,
  sshArgs,
  sshOptions,
  sshTarget,
  takePhoto,
  type CameraConfig,
  type CommandResult,
  type CommandRunner,
  type TakenPhoto,
  type TakePhotoOptions,
  type VideoDevice,
} from './camera.js';

export {
  DEFAULT_MEAL_WINDOWS,
  localDateTime,
  parseMealWindows,
  resolveServiceAt,
  type MealWindow,
  type ServiceLike,
  type ServiceResolution,
} from './mealService.js';
