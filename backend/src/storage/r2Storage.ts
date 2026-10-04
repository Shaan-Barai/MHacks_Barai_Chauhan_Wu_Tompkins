/**
 * Cloudflare R2 implementation of ObjectStorageAdapter (AGENTS.md §2, 5.7).
 *
 * R2 speaks the S3 API, so this uses the AWS SDK against
 * https://<account>.r2.cloudflarestorage.com with region "auto"
 * (developers.cloudflare.com/r2/api/s3/). Uploads and reads use presigned
 * URLs (developers.cloudflare.com/r2/api/s3/presigned-urls/): the client PUTs
 * bytes straight to R2, the backend verifies them with HeadObject on
 * finalize, and reads get a temporary GET URL. Bucket credentials stay on the
 * server; presigned URLs are returned to the caller but never logged or
 * stored as an image's identity (identity = provider/container/objectKey).
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

export interface R2Options {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Bucket name (OBJECT_STORAGE_CONTAINER). */
  bucket: string;
  /** Override the endpoint (EU jurisdiction buckets, or an S3-compatible test server). */
  endpoint?: string;
  allowedMimeTypes: string[];
  maxUploadBytes: number;
  uploadUrlTtlMs: number;
  readUrlTtlMs: number;
  now?: () => number;
  /** Injectable for tests. */
  client?: S3Client;
}

/** Presigned URL lifetime in whole seconds (S3 allows 1 s – 7 days). */
function ttlSeconds(ms: number): number {
  return Math.min(7 * 24 * 3600, Math.max(1, Math.round(ms / 1000)));
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/** Provider failures become retryable ApiErrors without leaking credentials or URLs. */
function storageUnavailable(action: string, err: unknown): HttpError {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return new HttpError(
    502,
    apiError('STORAGE_UNAVAILABLE', `Image storage could not ${action} right now. Please try again.`, true, {
      provider: 'r2',
      providerError: e?.name ?? 'unknown',
      ...(e?.$metadata?.httpStatusCode ? { providerStatus: e.$metadata.httpStatusCode } : {}),
    }),
  );
}

export class R2Storage implements ObjectStorageAdapter {
  readonly provider = 'r2';
  readonly container: string;
  private readonly client: S3Client;
  private readonly now: () => number;

  constructor(private readonly opts: R2Options) {
    this.container = opts.bucket;
    this.now = opts.now ?? (() => Date.now());
    this.client =
      opts.client ??
      new S3Client({
        region: 'auto',
        endpoint: opts.endpoint ?? `https://${opts.accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
        // <account>.r2.cloudflarestorage.com/<bucket>/<key>: works for every bucket name and S3-compatible test servers.
        forcePathStyle: true,
        // Presigned URLs for R2 should not carry the SDK's optional checksum params.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
  }

  async authorizeUpload(req: UploadRequest): Promise<UploadAuthorization> {
    validateUploadRequest(req, this.opts);
    const objectKey = makeObjectKey(req, this.now());
    const expiresIn = ttlSeconds(this.opts.uploadUrlTtlMs);
    // Content-Type and Content-Length are part of the signature, so R2 rejects
    // a PUT with a different type or size than the server authorized.
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: objectKey,
        ContentType: req.mimeType,
        ContentLength: req.declaredSizeBytes,
      }),
      { expiresIn, signableHeaders: new Set(['content-type', 'content-length']) },
    );
    return {
      objectKey,
      uploadUrl,
      uploadHeaders: { 'Content-Type': req.mimeType },
      expiresAt: new Date(this.now() + expiresIn * 1000).toISOString(),
    };
  }

  async statObject(objectKey: string): Promise<StoredObjectStat> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: objectKey }));
      return { exists: true, ...(head.ContentLength !== undefined ? { sizeBytes: head.ContentLength } : {}) };
    } catch (err) {
      if (isNotFound(err)) return { exists: false };
      throw storageUnavailable('check the upload', err);
    }
  }

  async getReadAccess(objectKey: string): Promise<ReadAccess> {
    const stat = await this.statObject(objectKey);
    if (!stat.exists) throw notFound('OBJECT_MISSING', 'The stored image could not be found.', { objectKey });
    const expiresIn = ttlSeconds(this.opts.readUrlTtlMs);
    const url = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.opts.bucket, Key: objectKey }), {
      expiresIn,
    });
    return { url, expiresAt: new Date(this.now() + expiresIn * 1000).toISOString() };
  }

  async getObjectBytes(objectKey: string): Promise<{ bytes: Buffer; mimeType: string }> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: objectKey }));
      const body = await res.Body?.transformToByteArray();
      if (!body) throw notFound('OBJECT_MISSING', 'The stored image could not be found.', { objectKey });
      return { bytes: Buffer.from(body), mimeType: res.ContentType ?? 'application/octet-stream' };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (isNotFound(err)) throw notFound('OBJECT_MISSING', 'The stored image could not be found.', { objectKey });
      throw storageUnavailable('read the image', err);
    }
  }

  async putBytes(objectKey: string, bytes: Uint8Array, mimeType: string): Promise<{ sizeBytes: number }> {
    try {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.opts.bucket, Key: objectKey, Body: bytes, ContentType: mimeType }),
      );
      return { sizeBytes: bytes.byteLength };
    } catch (err) {
      throw storageUnavailable('store the mask', err);
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: objectKey }));
    } catch (err) {
      if (!isNotFound(err)) throw storageUnavailable('delete the image', err);
    }
  }
}
