/**
 * Image upload orchestration (AGENTS.md 5.7 / 5.8).
 *
 * The object-store write and the database registration are SEPARATE
 * operations, never one atomic transaction:
 *   requestUpload -> ImageObject registered as `pending_upload`
 *   (client PUTs bytes via the adapter's temporary upload URL)
 *   finalize      -> adapter verifies the stored object, then the record
 *                    flips to `finalized`. Retryable and idempotent.
 *
 * Orphan tracking: records authorized/uploaded but never finalized are
 * discoverable via findOrphans and removable via cleanupOrphans.
 */

import { badRequest, conflict, notFound } from '../errors.js';
import { newId } from '../ids.js';
import type { Repository } from '../repo/repository.js';
import type { ObjectStorageAdapter, ReadAccess } from '../storage/objectStorage.js';
import type { ImageObject } from '../types.js';

export interface RequestUploadBody {
  associationKind: 'capture' | 'reference' | 'calibration';
  associationId: string;
  mimeType: string;
  sizeBytes: number;
  widthPx?: number;
  heightPx?: number;
}

/** Client-uploadable kinds; masks, overlays and depth maps are server-produced only. */
const UPLOAD_KINDS: RequestUploadBody['associationKind'][] = ['capture', 'reference', 'calibration'];

export interface RequestUploadResponse {
  objectId: string;
  objectKey: string;
  uploadUrl: string;
  /** Headers the PUT must send (presigned URLs are signed over Content-Type). */
  uploadHeaders: Record<string, string>;
  expiresAt: string;
}

export class ImageService {
  /**
   * When each pending upload was authorized, for orphan aging. In-memory on
   * purpose: after a restart, pending records' upload tokens are lost too,
   * so unknown pending uploads are treated as immediately orphanable.
   */
  private requestedAtMs = new Map<string, number>();

  constructor(
    private readonly repo: Repository,
    private readonly storage: ObjectStorageAdapter,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async requestUpload(body: RequestUploadBody): Promise<RequestUploadResponse> {
    if (!UPLOAD_KINDS.includes(body.associationKind)) {
      throw badRequest('INVALID_ASSOCIATION', "associationKind must be 'capture', 'reference' or 'calibration'.");
    }
    if (!body.associationId || typeof body.associationId !== 'string') {
      throw badRequest('INVALID_ASSOCIATION', 'associationId is required.');
    }
    const auth = await this.storage.authorizeUpload({
      associationKind: body.associationKind,
      associationId: body.associationId,
      mimeType: body.mimeType,
      declaredSizeBytes: body.sizeBytes,
    });
    const objectId = newId('img');
    const record: ImageObject = {
      objectId,
      provider: this.storage.provider as ImageObject['provider'],
      container: this.storage.container,
      objectKey: auth.objectKey,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      ...(body.widthPx !== undefined ? { widthPx: body.widthPx } : {}),
      ...(body.heightPx !== undefined ? { heightPx: body.heightPx } : {}),
      association: { kind: body.associationKind, id: body.associationId },
      state: 'pending_upload',
    };
    await this.repo.upsertImageObject(record);
    this.requestedAtMs.set(objectId, this.now());
    return {
      objectId,
      objectKey: auth.objectKey,
      uploadUrl: auth.uploadUrl,
      uploadHeaders: auth.uploadHeaders,
      expiresAt: auth.expiresAt,
    };
  }

  /**
   * Retryable finalization: verifies the bytes actually exist in the store,
   * then registers the durable reference as finalized. Calling it again on a
   * finalized object succeeds without changes.
   */
  async finalize(objectId: string): Promise<ImageObject> {
    const record = await this.repo.getImageObject(objectId);
    if (!record) {
      throw notFound('IMAGE_OBJECT_NOT_FOUND', 'No upload with this ID was requested.', { objectId });
    }
    if (record.state === 'finalized') return record; // idempotent
    if (record.state === 'orphaned') {
      throw conflict('IMAGE_OBJECT_ORPHANED', 'This upload was cleaned up. Start a new upload.', {
        objectId,
      });
    }
    const stat = await this.storage.statObject(record.objectKey);
    if (!stat.exists) {
      // Upload not completed yet (or failed): the caller may retry the
      // upload and then finalize again — hence retryable.
      throw conflict(
        'UPLOAD_NOT_COMPLETED',
        'The image bytes have not arrived in storage yet. Upload them, then finalize again.',
        { objectId },
      );
    }
    const finalized: ImageObject = {
      ...record,
      sizeBytes: stat.sizeBytes ?? record.sizeBytes,
      uploadedAt: new Date(this.now()).toISOString(),
      state: 'finalized',
    };
    await this.repo.upsertImageObject(finalized);
    this.requestedAtMs.delete(objectId);
    return finalized;
  }

  async getReadAccess(objectId: string): Promise<ReadAccess & { objectId: string }> {
    const record = await this.repo.getImageObject(objectId);
    if (!record) {
      throw notFound('IMAGE_OBJECT_NOT_FOUND', 'This image is not registered.', { objectId });
    }
    if (record.state !== 'finalized') {
      throw conflict('IMAGE_NOT_FINALIZED', 'This image upload was never completed.', {
        objectId,
        state: record.state,
      });
    }
    const access = await this.storage.getReadAccess(record.objectKey);
    return { objectId, ...access }; // temporary URL; never logged, never stored as identity
  }

  /**
   * Server-internal bytes read for analysis (AGENTS.md 4.7: Agent 4 receives
   * image content through Agent 5's storage interface). Only finalized
   * objects are readable; nothing is logged.
   */
  async readImageBytes(objectId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const record = await this.repo.getImageObject(objectId);
    if (!record) {
      throw notFound('IMAGE_OBJECT_NOT_FOUND', 'This image is not registered.', { objectId });
    }
    if (record.state !== 'finalized') {
      throw conflict('IMAGE_NOT_FINALIZED', 'This image upload was never completed.', {
        objectId,
        state: record.state,
      });
    }
    const { bytes } = await this.storage.getObjectBytes(record.objectKey);
    return { bytes, mimeType: record.mimeType };
  }

  /**
   * Store a segmentation mask the backend produced (lossless binary PNG,
   * 255 = food) and register it as a finalized image object associated with
   * its region. Masks never travel through SpacetimeDB rows.
   */
  async storeMask(regionId: string, png: Uint8Array, widthPx: number, heightPx: number): Promise<ImageObject> {
    const date = new Date(this.now()).toISOString().slice(0, 10);
    const objectKey = `masks/${date}/${regionId}.png`;
    const { sizeBytes } = await this.storage.putBytes(objectKey, png, 'image/png');
    const record: ImageObject = {
      objectId: newId('img'),
      provider: this.storage.provider as ImageObject['provider'],
      container: this.storage.container,
      objectKey,
      mimeType: 'image/png',
      sizeBytes,
      widthPx,
      heightPx,
      uploadedAt: new Date(this.now()).toISOString(),
      association: { kind: 'mask', id: regionId },
      state: 'finalized',
    };
    await this.repo.upsertImageObject(record);
    return record;
  }

  /**
   * Store the segmented overlay JPEG for one capture (BIG-PLAN D7: masks
   * tinted per food, plate rim outlined) and register it as a finalized image
   * object associated with the capture event. The key carries the attempt id
   * so a retried capture never overwrites an earlier attempt's overlay.
   */
  async storeOverlay(eventId: string, attemptId: string, jpeg: Uint8Array, widthPx: number, heightPx: number): Promise<ImageObject> {
    const date = new Date(this.now()).toISOString().slice(0, 10);
    const objectKey = `overlays/${date}/${eventId}_${attemptId}.jpg`;
    const { sizeBytes } = await this.storage.putBytes(objectKey, jpeg, 'image/jpeg');
    const record: ImageObject = {
      objectId: newId('img'),
      provider: this.storage.provider as ImageObject['provider'],
      container: this.storage.container,
      objectKey,
      mimeType: 'image/jpeg',
      sizeBytes,
      widthPx,
      heightPx,
      uploadedAt: new Date(this.now()).toISOString(),
      association: { kind: 'overlay', id: eventId },
      state: 'finalized',
    };
    await this.repo.upsertImageObject(record);
    return record;
  }

  /**
   * Store a server-produced derived image (IT_4: calibration overlay/reference
   * mask, depth PNGs) and register it finalized. Keys never collide across
   * retries because they carry a fresh suffix.
   */
  async storeDerived(
    kind: 'calibration_overlay' | 'depth' | 'mask',
    associationId: string,
    keyPrefix: string,
    bytes: Uint8Array,
    mimeType: 'image/png' | 'image/jpeg',
    widthPx: number,
    heightPx: number,
  ): Promise<ImageObject> {
    const date = new Date(this.now()).toISOString().slice(0, 10);
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    const objectId = newId('img');
    const objectKey = `${keyPrefix}/${date}/${associationId}_${objectId.slice(-8)}.${ext}`;
    const { sizeBytes } = await this.storage.putBytes(objectKey, bytes, mimeType);
    const record: ImageObject = {
      objectId,
      provider: this.storage.provider as ImageObject['provider'],
      container: this.storage.container,
      objectKey,
      mimeType,
      sizeBytes,
      widthPx,
      heightPx,
      uploadedAt: new Date(this.now()).toISOString(),
      association: { kind: kind, id: associationId },
      state: 'finalized',
    };
    await this.repo.upsertImageObject(record);
    return record;
  }

  /** Uploads authorized/uploaded but never finalized, older than maxAgeMs. */
  async findOrphans(maxAgeMs: number): Promise<ImageObject[]> {
    const cutoff = this.now() - maxAgeMs;
    const all = await this.repo.listImageObjects();
    return all.filter((o) => {
      if (o.state !== 'pending_upload' && o.state !== 'uploaded' && o.state !== 'failed') return false;
      const requested = this.requestedAtMs.get(o.objectId);
      // Unknown request time (e.g. process restarted): token is gone, so the
      // upload can never be finalized — treat as orphanable immediately.
      return requested === undefined || requested <= cutoff;
    });
  }

  /** Delete orphaned bytes (if any) and mark records `orphaned`. */
  async cleanupOrphans(maxAgeMs: number): Promise<{ cleaned: string[] }> {
    const orphans = await this.findOrphans(maxAgeMs);
    const cleaned: string[] = [];
    for (const o of orphans) {
      await this.storage.deleteObject(o.objectKey);
      await this.repo.upsertImageObject({ ...o, state: 'orphaned' });
      this.requestedAtMs.delete(o.objectId);
      cleaned.push(o.objectId);
    }
    return { cleaned };
  }
}
