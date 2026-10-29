/**
 * Supabase Storage implementation of ObjectStorageAdapter (AGENTS.md §2, 5.7).
 *
 * The bucket is PRIVATE (supabase/migrations/*_storage_bucket.sql): no
 * storage.objects policies exist, so the anon key cannot read or write. The
 * backend uses the service role key, which must never reach a client:
 *  - uploads: a signed upload URL (createSignedUploadUrl, upsert so a retried
 *    capture overwrites its deterministic key). Clients PUT the raw bytes to
 *    it, exactly like the former R2 presigned PUT; the bucket enforces the
 *    MIME allow-list and size limit, and finalize re-checks the stored size.
 *  - reads: a short-lived signed GET URL (createSignedUrl).
 * Signed URLs are returned to the caller but never logged or stored as an
 * image's identity (identity = provider/container/objectKey).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { HttpError, apiError, notFound } from '../errors.js';
import {
  makeObjectKey,
  validateUploadRequest,
  type ObjectStorageAdapter,
  type ReadAccess,
  type StoredObjectStat,
  type UploadAuthorization,
  type UploadRequest,
} from './objectStorage.js';

export interface SupabaseStorageOptions {
  /** Project API URL, https://<ref>.supabase.co */
  url: string;
  /** Service role (secret) key. Server only. */
  serviceRoleKey: string;
  bucket: string;
  allowedMimeTypes: string[];
  maxUploadBytes: number;
  readUrlTtlMs: number;
  now?: () => number;
  /** Injectable for tests. */
  client?: Pick<SupabaseClient, 'storage'>;
}

/** Supabase signed upload URLs are valid for a fixed 2 hours. */
const SIGNED_UPLOAD_TTL_MS = 2 * 3600 * 1000;

interface StorageErrorLike {
  name?: string;
  message?: string;
  status?: number;
  statusCode?: string | number;
}

function isNotFound(err: StorageErrorLike | null | undefined): boolean {
  if (!err) return false;
  // Storage answers a missing object with HTTP 400 and a "not found" body.
  return err.status === 404 || String(err.statusCode) === '404' || /not.?found/i.test(err.message ?? '');
}

/** Provider failures become retryable ApiErrors without leaking keys or URLs. */
function storageUnavailable(action: string, err: StorageErrorLike | unknown): HttpError {
  const e = err as StorageErrorLike;
  return new HttpError(
    502,
    apiError('STORAGE_UNAVAILABLE', `Image storage could not ${action} right now. Please try again.`, true, {
      provider: 'supabase',
      providerError: e?.name ?? 'unknown',
      ...(typeof e?.status === 'number' ? { providerStatus: e.status } : {}),
    }),
  );
}

export class SupabaseStorage implements ObjectStorageAdapter {
  readonly provider = 'supabase';
  readonly container: string;
  private readonly client: Pick<SupabaseClient, 'storage'>;
  private readonly now: () => number;

  constructor(private readonly opts: SupabaseStorageOptions) {
    this.container = opts.bucket;
    this.now = opts.now ?? (() => Date.now());
    this.client =
      opts.client ??
      createClient(opts.url, opts.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
  }

  private get bucket() {
    return this.client.storage.from(this.opts.bucket);
  }

  async authorizeUpload(req: UploadRequest): Promise<UploadAuthorization> {
    validateUploadRequest(req, this.opts);
    const objectKey = makeObjectKey(req, this.now());
    const { data, error } = await this.bucket.createSignedUploadUrl(objectKey, { upsert: true });
    if (error || !data) throw storageUnavailable('prepare the upload', error);
    return {
      objectKey,
      uploadUrl: data.signedUrl,
      uploadHeaders: { 'Content-Type': req.mimeType },
      expiresAt: new Date(this.now() + SIGNED_UPLOAD_TTL_MS).toISOString(),
    };
  }

  async statObject(objectKey: string): Promise<StoredObjectStat> {
    const { data, error } = await this.bucket.info(objectKey);
    if (error) {
      if (isNotFound(error)) return { exists: false };
      throw storageUnavailable('check the upload', error);
    }
    return { exists: true, ...(typeof data?.size === 'number' ? { sizeBytes: data.size } : {}) };
  }

  async getReadAccess(objectKey: string): Promise<ReadAccess> {
    const stat = await this.statObject(objectKey);
    if (!stat.exists) throw notFound('OBJECT_MISSING', 'The stored image could not be found.', { objectKey });
    const expiresIn = Math.max(1, Math.round(this.opts.readUrlTtlMs / 1000));
    const { data, error } = await this.bucket.createSignedUrl(objectKey, expiresIn);
    if (error || !data) {
      if (isNotFound(error)) throw notFound('OBJECT_MISSING', 'The stored image could not be found.', { objectKey });
      throw storageUnavailable('share the image', error);
    }
    return { url: data.signedUrl, expiresAt: new Date(this.now() + expiresIn * 1000).toISOString() };
  }

  async getObjectBytes(objectKey: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const { data, error } = await this.bucket.download(objectKey);
    if (error || !data) {
      if (!error || isNotFound(error)) throw notFound('OBJECT_MISSING', 'The stored image could not be found.', { objectKey });
      throw storageUnavailable('read the image', error);
    }
    return { bytes: Buffer.from(await data.arrayBuffer()), mimeType: data.type || 'application/octet-stream' };
  }

  async putBytes(objectKey: string, bytes: Uint8Array, mimeType: string): Promise<{ sizeBytes: number }> {
    const { error } = await this.bucket.upload(objectKey, bytes, { contentType: mimeType, upsert: true });
    if (error) throw storageUnavailable('store the image', error);
    return { sizeBytes: bytes.byteLength };
  }

  async deleteObject(objectKey: string): Promise<void> {
    const { error } = await this.bucket.remove([objectKey]);
    if (error && !isNotFound(error)) throw storageUnavailable('delete the image', error);
  }
}
