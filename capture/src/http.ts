/**
 * HTTP implementations of the Uploader and IngestionSink seams against
 * Agent 5's backend API (backend/README.md):
 *
 *   POST /api/images/uploads          authorize -> { objectId, uploadUrl, uploadHeaders }
 *   PUT  <uploadUrl>                  normalized bytes (R2 presigned URL, or the local-dev route)
 *   POST /api/images/:id/finalize     verify + register the object reference
 *   POST /api/captures                capture metadata + finalized objectId
 *   POST /api/dish-match              same-dish verdict for the camera bridge
 *   POST /api/calibrations            run a camera calibration (IT_4 §3)
 *   GET/PUT /api/settings/measurement active calibration per hall (IT_4 I9)
 *
 * Still not a storage client: no credentials, no bucket access — only the
 * backend's authorized upload URL. Upload URLs and tokens are never logged.
 *
 * Auth (IT_4 I11): with a token, every backend request carries
 * `Authorization: Bearer <token>`. The PUT to a presigned object-storage URL
 * on another origin never does: the signature is the authorization there, and
 * the token must not leak to the storage provider.
 */

import { authHeaders } from './backendConfig.js';
import type {
  ApiError,
  CameraCalibration,
  CaptureEvent,
  DishMatchRequest,
  DishMatchResult,
  MeasurementSettings,
  ProcessingState,
} from './contract-types.js';
import type { IngestionSink } from './ingestion.js';
import type { FinalizedUpload, UploadAuthorization, UploadRequest, Uploader } from './uploader.js';

export interface HttpClientOptions {
  /** Bearer token for backend requests (SCRAP_INGEST_TOKEN). */
  token?: string;
}

function authMessage(status: number): string {
  return status === 401
    ? 'the backend needs an ingest token. Set SCRAP_INGEST_TOKEN (or --token-env NAME) to the token the backend was started with'
    : 'the ingest token was refused. Check that SCRAP_INGEST_TOKEN matches the backend';
}

/** Thrown for non-2xx backend responses; carries the backend's ApiError when present. */
export class BackendRequestError extends Error {
  constructor(
    readonly status: number,
    readonly apiError: ApiError | undefined,
    what: string,
  ) {
    super(
      status === 401 || status === 403
        ? `${what} failed (${status}): ${authMessage(status)}.`
        : `${what} failed (${status})${apiError ? `: ${apiError.code} — ${apiError.message}` : ''}`,
    );
    this.name = 'BackendRequestError';
  }

  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

async function request<T>(url: string, init: RequestInit, what: string): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (res.ok) throw new Error(`${what}: the backend answered with non-JSON content.`);
    }
  }
  if (!res.ok) {
    const error = body.error;
    throw new BackendRequestError(
      res.status,
      error && typeof error === 'object' ? (error as ApiError) : undefined,
      what,
    );
  }
  return body as T;
}

/** Base URL, auth headers and JSON helpers shared by the HTTP seams. */
class BackendClient {
  protected readonly base: string;
  protected readonly auth: Record<string, string>;

  constructor(apiUrl: string, options: HttpClientOptions = {}) {
    this.base = apiUrl.replace(/\/$/, '');
    this.auth = authHeaders(options.token);
  }

  protected json<T>(method: string, route: string, what: string, body?: unknown): Promise<T> {
    return request<T>(
      `${this.base}${route}`,
      {
        method,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...this.auth },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      what,
    );
  }

  /** True when `url` is on the backend's own origin (local-dev upload route). */
  protected sameOrigin(url: string): boolean {
    return new URL(url).origin === new URL(this.base).origin;
  }
}

export class HttpUploader extends BackendClient implements Uploader {
  /** objectId -> authorized upload URL + the headers it was signed over. */
  private readonly uploads = new Map<string, { url: string; headers: Record<string, string> }>();

  async authorizeUpload(req: UploadRequest): Promise<UploadAuthorization> {
    const body = await this.json<{ objectId: string; uploadUrl: string; uploadHeaders?: Record<string, string> }>(
      'POST',
      '/api/images/uploads',
      'Upload authorization',
      {
        associationKind: req.association.kind,
        associationId: req.association.id,
        mimeType: req.mimeType,
        sizeBytes: req.sizeBytes,
        widthPx: req.widthPx,
        heightPx: req.heightPx,
      },
    );
    // local-dev returns a backend-relative URL; R2 returns an absolute presigned URL.
    this.uploads.set(body.objectId, {
      url: new URL(body.uploadUrl, `${this.base}/`).toString(),
      headers: body.uploadHeaders ?? { 'Content-Type': req.mimeType },
    });
    return { uploadId: body.objectId };
  }

  async uploadBytes(auth: UploadAuthorization, bytes: Uint8Array): Promise<void> {
    const upload = this.uploads.get(auth.uploadId);
    if (!upload) throw new Error(`No authorized upload URL for ${auth.uploadId}`);
    // The token goes only to the backend's own upload route, never to R2.
    const headers = this.sameOrigin(upload.url) ? { ...upload.headers, ...this.auth } : upload.headers;
    const res = await fetch(upload.url, { method: 'PUT', headers, body: bytes });
    // R2 answers with an XML body, the local-dev route with JSON or nothing.
    if (!res.ok) throw new BackendRequestError(res.status, undefined, 'Image upload');
  }

  async finalizeUpload(auth: UploadAuthorization): Promise<FinalizedUpload> {
    await this.json('POST', `/api/images/${encodeURIComponent(auth.uploadId)}/finalize`, 'Upload finalization');
    this.uploads.delete(auth.uploadId);
    return { objectId: auth.uploadId };
  }
}

export interface SubmittedCapture {
  state: ProcessingState;
  deduplicated: boolean;
}

export class HttpIngestionSink extends BackendClient implements IngestionSink {
  /** Backend outcome per eventId, for reporting (analysis runs on submit). */
  readonly outcomes = new Map<string, SubmittedCapture>();

  async submitCaptureEvent(event: CaptureEvent): Promise<void> {
    const body = await this.json<{ event: CaptureEvent; deduplicated?: boolean }>(
      'POST',
      '/api/captures',
      'Capture submission',
      event,
    );
    this.outcomes.set(event.eventId, { state: body.event.state, deduplicated: body.deduplicated === true });
  }
}

/** Same-dish verdicts for the camera bridge (BRIDGE.md §4.3). */
export interface DishMatcher {
  match(request: DishMatchRequest): Promise<DishMatchResult>;
}

export class HttpDishMatcher extends BackendClient implements DishMatcher {
  match(body: DishMatchRequest): Promise<DishMatchResult> {
    return this.json<DishMatchResult>('POST', '/api/dish-match', 'Dish comparison', body);
  }
}

/** POST /api/calibrations body (IT_4 §3). */
export interface CalibrationRequest {
  hallId: string;
  cameraId: string;
  imageObjectId: string;
  knownAreaCm2: number;
  referenceLabel: string;
}

/** Calibration + measurement-settings endpoints (IT_4 §3, I9). */
export interface CalibrationApi {
  createCalibration(body: CalibrationRequest): Promise<CameraCalibration>;
  getCalibration(calibrationId: string): Promise<CameraCalibration>;
  getSettings(hallId: string): Promise<MeasurementSettings | null>;
  putSettings(settings: Partial<MeasurementSettings> & { hallId: string }): Promise<MeasurementSettings>;
}

/** Accept a bare record or one wrapped as `{ calibration }` / `{ settings }`. */
function unwrap<T>(body: unknown, key: string): T {
  if (body && typeof body === 'object' && key in body) return (body as Record<string, unknown>)[key] as T;
  return body as T;
}

export class HttpCalibrationClient extends BackendClient implements CalibrationApi {
  async createCalibration(body: CalibrationRequest): Promise<CameraCalibration> {
    return unwrap(await this.json('POST', '/api/calibrations', 'Calibration', body), 'calibration');
  }

  async getCalibration(calibrationId: string): Promise<CameraCalibration> {
    const route = `/api/calibrations/${encodeURIComponent(calibrationId)}`;
    return unwrap(await this.json('GET', route, 'Calibration lookup'), 'calibration');
  }

  async getSettings(hallId: string): Promise<MeasurementSettings | null> {
    try {
      const route = `/api/settings/measurement?hallId=${encodeURIComponent(hallId)}`;
      return unwrap(await this.json('GET', route, 'Measurement settings'), 'settings');
    } catch (err) {
      // A hall without saved settings yet; a missing route (ROUTE_NOT_FOUND) still throws.
      if (err instanceof BackendRequestError && err.status === 404 && err.apiError && err.apiError.code !== 'ROUTE_NOT_FOUND') {
        return null;
      }
      throw err;
    }
  }

  async putSettings(settings: Partial<MeasurementSettings> & { hallId: string }): Promise<MeasurementSettings> {
    return unwrap(await this.json('PUT', '/api/settings/measurement', 'Measurement settings update', settings), 'settings');
  }
}
