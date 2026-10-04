/**
 * Provider-neutral object-storage adapter (AGENTS.md 5.7 / 5.8).
 *
 * Flow is always two-step and never atomic with the database:
 *   1. requestUpload  — server authorizes an upload (validates MIME/size),
 *                       registers an ImageObject record in `pending_upload`.
 *   2. upload         — bytes go to the provider (local-dev: HTTP PUT handled
 *                       by the backend; cloud: presigned URL direct upload).
 *   3. finalize       — server VERIFIES the object exists and matches the
 *                       declared metadata, then flips the DB record to
 *                       `finalized`. Retryable: finalizing an already
 *                       finalized object is a no-op success.
 *   4. getReadAccess  — temporary read URL with expiry metadata. NEVER an
 *                       identity: identity is provider/container/objectKey.
 *
 * Orphans: an object uploaded (or merely authorized) but never finalized.
 * findOrphans/cleanupOrphans make them visible and removable per the
 * retention policy (age threshold is configurable).
 *
 * Security: signed/temporary URLs are never logged; storage credentials never
 * reach a client. The local-dev implementation uses opaque random tokens in
 * place of cryptographic signatures; the R2 adapter (r2Storage.ts) issues
 * real S3-compatible presigned URLs.
 */

import { randomBytes } from 'node:crypto';
import { badRequest } from '../errors.js';

export type UploadAssociationKind = 'capture' | 'original' | 'reference';

export interface UploadRequest {
  /** The association drives the object-key folder (captures/, originals/, references/). */
  associationKind: UploadAssociationKind;
  associationId: string;
  mimeType: string;
  declaredSizeBytes: number;
  /** Prepended to the key, e.g. 'test/' (config.objectStorage.keyPrefix). */
  keyPrefix?: string;
}

export interface UploadAuthorization {
  objectKey: string;
  /** Where the client PUTs the bytes. Temporary; expires. */
  uploadUrl: string;
  /** Headers the PUT must carry (a presigned URL is signed over them). */
  uploadHeaders: Record<string, string>;
  expiresAt: string; // UTC ISO 8601
}

export interface StoredObjectStat {
  exists: boolean;
  sizeBytes?: number;
}

export interface ReadAccess {
  /** Temporary read URL. Never store as the image's identity. */
  url: string;
  expiresAt: string; // UTC ISO 8601
}

export interface ObjectStorageAdapter {
  readonly provider: string;
  readonly container: string;

  /** Validate MIME/size and authorize an upload for a new object key. */
  authorizeUpload(req: UploadRequest): Promise<UploadAuthorization>;

  /** Check the object really exists and report its stored size. */
  statObject(objectKey: string): Promise<StoredObjectStat>;

  /** Issue temporary read access for a stored object. */
  getReadAccess(objectKey: string): Promise<ReadAccess>;

  /** Server-internal read of the bytes (analysis); never exposed to clients. */
  getObjectBytes(objectKey: string): Promise<{ bytes: Buffer; mimeType: string }>;

  /** Remove the stored bytes (used by orphan cleanup). */
  deleteObject(objectKey: string): Promise<void>;

  /** Server-side write of bytes the backend itself produced (segmentation masks). */
  putBytes(objectKey: string, bytes: Uint8Array, mimeType: string): Promise<{ sizeBytes: number }>;

  /**
   * local-dev only: the backend itself serves the upload/read URLs, so it
   * needs these. Providers with presigned URLs leave them undefined.
   */
  putObject?(objectKey: string, uploadToken: string, bytes: Buffer, mimeType: string): Promise<void>;
  readObject?(objectKey: string, readToken: string): Promise<{ bytes: Buffer; mimeType: string }>;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface UploadPolicy {
  allowedMimeTypes: string[];
  maxUploadBytes: number;
}

/** Shared MIME/size validation every adapter applies before authorizing. */
export function validateUploadRequest(req: UploadRequest, policy: UploadPolicy): void {
  if (!policy.allowedMimeTypes.includes(req.mimeType)) {
    throw badRequest(
      'UNSUPPORTED_MEDIA_TYPE',
      `Only these image types are accepted: ${policy.allowedMimeTypes.join(', ')}.`,
      { mimeType: req.mimeType },
    );
  }
  if (!Number.isFinite(req.declaredSizeBytes) || req.declaredSizeBytes <= 0) {
    throw badRequest('INVALID_UPLOAD_SIZE', 'The upload size must be a positive number of bytes.');
  }
  if (req.declaredSizeBytes > policy.maxUploadBytes) {
    throw badRequest('UPLOAD_TOO_LARGE', `Images may be at most ${policy.maxUploadBytes} bytes.`, {
      maxUploadBytes: policy.maxUploadBytes,
      declaredSizeBytes: req.declaredSizeBytes,
    });
  }
}

const KEY_FOLDER: Record<UploadAssociationKind, string> = {
  capture: 'captures',
  original: 'originals',
  reference: 'references',
};

/**
 * Stable, provider-independent key: `<keyPrefix><folder>/<date>/<associationId>.<ext>`.
 * A capture event has exactly one normalized image and one original, so their
 * keys are deterministic: a retried upload overwrites the same object instead
 * of leaving a duplicate. Reference images keep a random suffix (a baseline
 * may be re-photographed).
 */
export function makeObjectKey(req: UploadRequest, nowMs: number): string {
  const ext = EXT_BY_MIME[req.mimeType] ?? 'bin';
  const date = new Date(nowMs).toISOString().slice(0, 10);
  const name =
    req.associationKind === 'reference' ? `${req.associationId}_${randomBytes(6).toString('hex')}` : req.associationId;
  return `${req.keyPrefix ?? ''}${KEY_FOLDER[req.associationKind]}/${date}/${name}.${ext}`;
}

export function mimeForKey(objectKey: string): string {
  const ext = objectKey.split('.').pop();
  for (const [mime, e] of Object.entries(EXT_BY_MIME)) if (e === ext) return mime;
  return 'application/octet-stream';
}
