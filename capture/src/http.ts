/**
 * HTTP implementations of the Uploader and IngestionSink seams against
 * Agent 5's backend API (backend/README.md):
 *
 *   POST /api/images/uploads          authorize -> { objectId, uploadUrl, uploadHeaders }
 *   PUT  <uploadUrl>                  normalized bytes (R2 presigned URL, or the local-dev route)
 *   POST /api/images/:id/finalize     verify + register the object reference
 *   POST /api/captures                capture metadata + finalized objectId
 *   POST /api/dish-match              same-dish verdict for the camera bridge
 *
 * Still not a storage client: no credentials, no bucket access — only the
 * backend's authorized upload URL. Upload URLs are never logged.
 */

import type { ApiError, CaptureEvent, DishMatchRequest, DishMatchResult, ProcessingState, ScanSubmission } from './contract-types.js';
import type { IngestionSink } from './ingestion.js';
import type { FinalizedUpload, UploadAuthorization, UploadRequest, Uploader } from './uploader.js';

/** Thrown for non-2xx backend responses; carries the backend's ApiError when present. */
export class BackendRequestError extends Error {
  constructor(
    readonly status: number,
    readonly apiError: ApiError | undefined,
    what: string,
  ) {
    super(`${what} failed (${status})${apiError ? `: ${apiError.code} — ${apiError.message}` : ''}`);
    this.name = 'BackendRequestError';
  }
}

async function request<T>(url: string, init: RequestInit, what: string): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new BackendRequestError(res.status, body.error as ApiError | undefined, what);
  return body as T;
}

export class HttpUploader implements Uploader {
  private readonly base: string;
  /** objectId -> authorized upload URL + the headers it was signed over. */
  private readonly uploads = new Map<string, { url: string; headers: Record<string, string> }>();

  constructor(apiUrl: string) {
    this.base = apiUrl.replace(/\/$/, '');
  }

  async authorizeUpload(req: UploadRequest): Promise<UploadAuthorization> {
    const body = await request<
      | { objectId: string; uploadUrl: string; uploadHeaders?: Record<string, string>; alreadyFinalized?: false }
      | { objectId: string; alreadyFinalized: true }
    >(
      `${this.base}/api/images/uploads`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          associationKind: req.association.kind,
          associationId: req.association.id,
          mimeType: req.mimeType,
          sizeBytes: req.sizeBytes,
          widthPx: req.widthPx,
          heightPx: req.heightPx,
        }),
      },
      'Upload authorization',
    );
    // A retry for an upload that already finished: nothing to send again.
    if (body.alreadyFinalized) return { uploadId: body.objectId, alreadyFinalized: true };
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
    const res = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
    // R2 answers with an XML body, the local-dev route with JSON or nothing.
    if (!res.ok) throw new BackendRequestError(res.status, undefined, 'Image upload');
  }

  async finalizeUpload(auth: UploadAuthorization): Promise<FinalizedUpload> {
    await request(
      `${this.base}/api/images/${encodeURIComponent(auth.uploadId)}/finalize`,
      { method: 'POST' },
      'Upload finalization',
    );
    this.uploads.delete(auth.uploadId);
    return { objectId: auth.uploadId };
  }
}

export interface SubmittedCapture {
  state: ProcessingState;
  deduplicated: boolean;
}

export class HttpIngestionSink implements IngestionSink {
  private readonly base: string;
  /** Backend outcome per eventId, for reporting (analysis runs on submit). */
  readonly outcomes = new Map<string, SubmittedCapture>();

  constructor(apiUrl: string) {
    this.base = apiUrl.replace(/\/$/, '');
  }

  async submitCaptureEvent(event: CaptureEvent, scan?: ScanSubmission): Promise<void> {
    const body = await request<{ event: CaptureEvent; deduplicated?: boolean }>(
      `${this.base}/api/captures`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scan ? { ...event, scan } : event),
      },
      'Capture submission',
    );
    this.outcomes.set(event.eventId, { state: body.event.state, deduplicated: body.deduplicated === true });
  }
}

/** Same-dish verdicts for the camera bridge (BRIDGE.md §4.3). */
export interface DishMatcher {
  match(request: DishMatchRequest): Promise<DishMatchResult>;
}

export class HttpDishMatcher implements DishMatcher {
  private readonly base: string;

  constructor(apiUrl: string) {
    this.base = apiUrl.replace(/\/$/, '');
  }

  match(body: DishMatchRequest): Promise<DishMatchResult> {
    return request<DishMatchResult>(
      `${this.base}/api/dish-match`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      'Dish comparison',
    );
  }
}
