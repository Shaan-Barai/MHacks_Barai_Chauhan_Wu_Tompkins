/**
 * Upload seam (AGENTS.md 3.5).
 *
 * Agent 3 never talks to object storage directly. It uploads through this
 * interface, which mirrors Agent 5's agreed two-step storage flow:
 *   1. authorizeUpload  - server-side authorization for one upload
 *   2. uploadBytes      - transfer the normalized image bytes
 *   3. finalizeUpload   - confirm completion; returns the durable objectId
 *
 * Agent 5 owns the real implementation (provider credentials, object keys,
 * verification, SpacetimeDB registration). The in-memory mock below exists
 * only for capture tests and local replay runs — it is NOT a storage client.
 */

import { newId } from './ids.js';

export interface UploadRequest {
  mimeType: string;
  sizeBytes: number;
  widthPx: number;
  heightPx: number;
  association: { kind: 'capture' | 'reference'; id: string };
}

export interface UploadAuthorization {
  /** Opaque handle for this authorized upload attempt. */
  uploadId: string;
}

export interface FinalizedUpload {
  /** Durable ImageObject.objectId registered by Agent 5. Never a signed URL. */
  objectId: string;
}

export interface Uploader {
  authorizeUpload(request: UploadRequest): Promise<UploadAuthorization>;
  uploadBytes(auth: UploadAuthorization, bytes: Uint8Array): Promise<void>;
  finalizeUpload(auth: UploadAuthorization): Promise<FinalizedUpload>;
}

interface MockUploadRecord {
  request: UploadRequest;
  bytes?: Uint8Array;
  objectId?: string;
}

/**
 * In-memory mock of the Uploader seam for tests and offline replay.
 * Supports injected transient failures to exercise retry behavior.
 */
export class InMemoryUploader implements Uploader {
  private readonly uploads = new Map<string, MockUploadRecord>();
  private failNextUploadCount = 0;

  /** Make the next `count` uploadBytes calls fail (transient error). */
  failNextUpload(count = 1): void {
    this.failNextUploadCount = count;
  }

  async authorizeUpload(request: UploadRequest): Promise<UploadAuthorization> {
    const uploadId = newId('upl');
    this.uploads.set(uploadId, { request });
    return { uploadId };
  }

  async uploadBytes(auth: UploadAuthorization, bytes: Uint8Array): Promise<void> {
    const record = this.uploads.get(auth.uploadId);
    if (!record) throw new Error(`unknown uploadId ${auth.uploadId}`);
    if (this.failNextUploadCount > 0) {
      this.failNextUploadCount -= 1;
      throw new Error('injected transient upload failure');
    }
    record.bytes = bytes;
  }

  async finalizeUpload(auth: UploadAuthorization): Promise<FinalizedUpload> {
    const record = this.uploads.get(auth.uploadId);
    if (!record) throw new Error(`unknown uploadId ${auth.uploadId}`);
    if (!record.bytes) throw new Error(`uploadId ${auth.uploadId} has no uploaded bytes`);
    // Finalize is idempotent per upload attempt.
    record.objectId ??= newId('img');
    return { objectId: record.objectId };
  }

  /** Test helper: stored bytes for a finalized objectId, if any. */
  getObjectBytes(objectId: string): Uint8Array | undefined {
    for (const record of this.uploads.values()) {
      if (record.objectId === objectId) return record.bytes;
    }
    return undefined;
  }

  /** Test helper: number of finalized objects. */
  finalizedCount(): number {
    let n = 0;
    for (const record of this.uploads.values()) if (record.objectId) n += 1;
    return n;
  }
}
