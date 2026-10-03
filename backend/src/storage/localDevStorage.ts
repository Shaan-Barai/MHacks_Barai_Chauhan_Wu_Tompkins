/**
 * `local-dev` filesystem implementation of ObjectStorageAdapter.
 *
 * PLACEHOLDER for the real provider (R2 / S3 / Supabase / Firebase —
 * undecided, see contracts/decisions.md). Bytes live under
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
import type {
  ObjectStorageAdapter,
  ReadAccess,
  StoredObjectStat,
  UploadAuthorization,
  UploadRequest,
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

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

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

  authorizeUpload(req: UploadRequest): UploadAuthorization {
    if (!this.opts.allowedMimeTypes.includes(req.mimeType)) {
      throw badRequest(
        'UNSUPPORTED_MEDIA_TYPE',
        `Only these image types are accepted: ${this.opts.allowedMimeTypes.join(', ')}.`,
        { mimeType: req.mimeType },
      );
    }
    if (!Number.isFinite(req.declaredSizeBytes) || req.declaredSizeBytes <= 0) {
      throw badRequest('INVALID_UPLOAD_SIZE', 'The upload size must be a positive number of bytes.');
    }
    if (req.declaredSizeBytes > this.opts.maxUploadBytes) {
      throw badRequest(
        'UPLOAD_TOO_LARGE',
        `Images may be at most ${this.opts.maxUploadBytes} bytes.`,
        { maxUploadBytes: this.opts.maxUploadBytes, declaredSizeBytes: req.declaredSizeBytes },
      );
    }
    const ext = EXT_BY_MIME[req.mimeType] ?? 'bin';
    const prefix = req.associationKind === 'capture' ? 'captures' : 'references';
    const date = new Date(this.opts.now()).toISOString().slice(0, 10);
    const objectKey = `${prefix}/${date}/${req.associationId}_${randomBytes(6).toString('hex')}.${ext}`;
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
      uploadToken,
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
      mimeType: this.mimeFor(objectKey),
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

  private mimeFor(objectKey: string): string {
    const ext = objectKey.split('.').pop();
    for (const [mime, e] of Object.entries(EXT_BY_MIME)) if (e === ext) return mime;
    return 'application/octet-stream';
  }
}
