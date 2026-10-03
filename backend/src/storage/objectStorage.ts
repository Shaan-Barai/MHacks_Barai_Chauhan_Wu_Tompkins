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
 * place of cryptographic signatures — a real provider adapter must use its
 * presigned-URL mechanism.
 */

export interface UploadRequest {
  /** 'capture' or 'reference' association drives the object-key prefix. */
  associationKind: 'capture' | 'reference';
  associationId: string;
  mimeType: string;
  declaredSizeBytes: number;
}

export interface UploadAuthorization {
  objectKey: string;
  /** Where the client PUTs the bytes. Temporary; expires. */
  uploadUrl: string;
  uploadToken: string;
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
  authorizeUpload(req: UploadRequest): UploadAuthorization;

  /** local-dev only: accept the PUT bytes the uploadUrl points at. */
  putObject(objectKey: string, uploadToken: string, bytes: Buffer, mimeType: string): Promise<void>;

  /** Check the object really exists and report its stored size. */
  statObject(objectKey: string): Promise<StoredObjectStat>;

  /** Issue temporary read access for a stored object. */
  getReadAccess(objectKey: string): Promise<ReadAccess>;

  /** local-dev only: resolve a read token back to bytes. */
  readObject(objectKey: string, readToken: string): Promise<{ bytes: Buffer; mimeType: string }>;

  /** Remove the stored bytes (used by orphan cleanup). */
  deleteObject(objectKey: string): Promise<void>;
}
