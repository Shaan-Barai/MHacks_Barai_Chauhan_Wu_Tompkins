/**
 * `local-dev` filesystem implementation of ObjectStorageAdapter.
 *
 * Offline/dev stand-in for Cloudflare R2 (r2Storage.ts). Bytes live under
 * OBJECT_STORAGE_LOCAL_DIR (default `.local-storage/`, gitignored at the
 * repo root). Upload/read URLs are backend routes guarded by opaque
 * random tokens with expiry — standing in for presigned URLs.
 *
 * Tokens and URLs are intentionally never logged.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { badRequest, notFound, HttpError, apiError } from '../errors.js';
import {
  makeObjectKey,
  mimeForKey,
  validateUploadRequest,
  type ObjectStorageAdapter,
  type ReadAccess,
  type StoredObjectStat,
  type UploadAuthorization,
  type UploadRequest,
} from './objectStorage.js';

interface LocalDevOptions {
  localDir: string;
  container: string;
  allowedMimeTypes: string[];
  maxUploadBytes: number;
  uploadUrlTtlMs: number;
  readUrlTtlMs: number;
  /** Base path of the backend routes serving uploads/reads. */
  routeBase?: string;
  now?: () => number;
}

interface TokenRecord {
  objectKey: string;
  mimeType: string;
  declaredSizeBytes: number;
  expiresAtMs: number;
}

export class LocalDevStorage implements ObjectStorageAdapter {
  readonly provider = 'local-dev';
  readonly container: string;
  private readonly opts: Required<Pick<LocalDevOptions, 'routeBase' | 'now'>> & LocalDevOptions;
  private uploadTokens = new Map<string, TokenRecord>();
  private readTokens = new Map<string, TokenRecord>();

  constructor(options: LocalDevOptions) {
    this.opts = { routeBase: '/api/storage', now: () => Date.now(), ...options };
    this.container = options.container;
  }

  async authorizeUpload(req: UploadRequest): Promise<UploadAuthorization> {
    validateUploadRequest(req, this.opts);
    const objectKey = makeObjectKey(req, this.opts.now());
    const uploadToken = randomBytes(24).toString('hex');
    const expiresAtMs = this.opts.now() + this.opts.uploadUrlTtlMs;
    this.uploadTokens.set(uploadToken, {
      objectKey,
      mimeType: req.mimeType,
      declaredSizeBytes: req.declaredSizeBytes,
      expiresAtMs,
    });
    return {
      objectKey,
      uploadUrl: `${this.opts.routeBase}/upload/${encodeURIComponent(objectKey)}?token=${uploadToken}`,
      uploadHeaders: { 'Content-Type': req.mimeType },
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async putObject(objectKey: string, uploadToken: string, bytes: Buffer, mimeType: string): Promise<void> {
    const record = this.uploadTokens.get(uploadToken);
    if (!record || record.objectKey !== objectKey) {
      throw new HttpError(403, apiError('UPLOAD_NOT_AUTHORIZED', 'This upload link is not valid.', false));
    }
    if (record.expiresAtMs < this.opts.now()) {
      this.uploadTokens.delete(uploadToken);
      throw new HttpError(
        403,
        apiError('UPLOAD_URL_EXPIRED', 'This upload link has expired. Request a new upload.', true),
      );
    }
    if (mimeType !== record.mimeType) {
      throw badRequest('UPLOAD_MIME_MISMATCH', 'The uploaded file type does not match the authorized type.', {
        expected: record.mimeType,
      });
    }
    if (bytes.length === 0 || bytes.length > this.opts.maxUploadBytes) {
      throw badRequest('UPLOAD_SIZE_REJECTED', 'The uploaded file is empty or larger than the allowed limit.', {
        maxUploadBytes: this.opts.maxUploadBytes,
      });
    }
    const filePath = this.pathFor(objectKey);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
    this.uploadTokens.delete(uploadToken);
  }

  async statObject(objectKey: string): Promise<StoredObjectStat> {
    try {
      const s = await stat(this.pathFor(objectKey));
      return { exists: s.isFile(), sizeBytes: s.size };
    } catch {
      return { exists: false };
    }
  }

  async getReadAccess(objectKey: string): Promise<ReadAccess> {
    const s = await this.statObject(objectKey);
    if (!s.exists) {
      throw notFound('OBJECT_MISSING', 'The stored image could not be found.', { objectKey });
    }
    const readToken = randomBytes(24).toString('hex');
    const expiresAtMs = this.opts.now() + this.opts.readUrlTtlMs;
    this.readTokens.set(readToken, {
      objectKey,
      mimeType: mimeForKey(objectKey),
      declaredSizeBytes: s.sizeBytes ?? 0,
      expiresAtMs,
    });
    return {
      url: `${this.opts.routeBase}/read/${encodeURIComponent(objectKey)}?token=${readToken}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async readObject(objectKey: string, readToken: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const record = this.readTokens.get(readToken);
    if (!record || record.objectKey !== objectKey) {
      throw new HttpError(403, apiError('READ_NOT_AUTHORIZED', 'This image link is not valid.', false));
    }
    if (record.expiresAtMs < this.opts.now()) {
      this.readTokens.delete(readToken);
      throw new HttpError(
        403,
        apiError('READ_URL_EXPIRED', 'This image link has expired. Request a fresh one.', true),
      );
    }
    const bytes = await readFile(this.pathFor(objectKey));
    return { bytes, mimeType: record.mimeType };
  }

  async getObjectBytes(objectKey: string): Promise<{ bytes: Buffer; mimeType: string }> {
    try {
      return { bytes: await readFile(this.pathFor(objectKey)), mimeType: mimeForKey(objectKey) };
    } catch {
      throw notFound('OBJECT_MISSING', 'The stored image could not be found.', { objectKey });
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    await rm(this.pathFor(objectKey), { force: true });
  }

  private pathFor(objectKey: string): string {
    const safe = normalize(objectKey);
    if (safe.startsWith('..') || safe.includes(`..${sep}`) || safe.startsWith(sep)) {
      throw badRequest('INVALID_OBJECT_KEY', 'The image reference is not valid.');
    }
    return join(this.opts.localDir, this.container, safe);
  }
}
