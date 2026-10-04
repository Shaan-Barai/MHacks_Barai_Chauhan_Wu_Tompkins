/**
 * Camera calibration + per-hall measurement settings (IT_4 I2, I9).
 *
 * POST /api/calibrations takes an already-finalized upload whose association
 * is { kind: 'calibration', id: <calibrationId> }: the client picks the new
 * calibration id when it requests the upload (e.g. `cal_<random>`), so a
 * retried POST with the same image is idempotent. Vision's runner measures
 * the reference; the backend stores the overlay and reference mask in object
 * storage and persists the CameraCalibration. Activating a
 * calibration only changes measurement_settings: earlier attempts keep the
 * calibrationId they snapshotted, so history never changes.
 */

import { HttpError, apiError, badRequest, conflict, notFound } from '../errors.js';
import { log } from '../log.js';
import type { CalibrationRunner } from '../analysis/calibrationRunner.js';
import type { Repository } from '../repo/repository.js';
import type { ImageService } from './imageService.js';
import type { CameraCalibration, MeasurementSettings, SignedImage } from '../types.js';

/**
 * Fields an older client (from the removed Depth Anything V2 trial) may still
 * send to PUT /api/settings/measurement. They are accepted and ignored.
 */
export const IGNORED_LEGACY_SETTINGS_FIELDS = ['depthEnabled', 'plateThicknessCm'] as const;

export interface CalibrationRequest {
  hallId: string;
  cameraId: string;
  imageObjectId: string;
  knownAreaCm2: number;
  referenceLabel: string;
}

export interface CalibrationImages {
  calibrationId: string;
  photo: SignedImage | null;
  overlay: SignedImage | null;
  referenceMask: SignedImage | null;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function validateCalibrationRequest(body: unknown): CalibrationRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (k: string, max = 128) => {
    const v = b[k];
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) {
      throw badRequest('INVALID_CALIBRATION_REQUEST', `'${k}' is required (text, at most ${max} characters).`, { field: k });
    }
    return v.trim();
  };
  const knownAreaCm2 = b.knownAreaCm2;
  if (typeof knownAreaCm2 !== 'number' || !Number.isFinite(knownAreaCm2) || knownAreaCm2 <= 0 || knownAreaCm2 > 10_000) {
    throw badRequest('INVALID_CALIBRATION_REQUEST', "'knownAreaCm2' must be a number above 0 (cm²). A credit card is 46.21.", {
      field: 'knownAreaCm2',
    });
  }
  return {
    hallId: str('hallId'),
    cameraId: str('cameraId'),
    imageObjectId: str('imageObjectId'),
    knownAreaCm2,
    referenceLabel: str('referenceLabel', 80),
  };
}

export class CalibrationService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly repo: Repository,
    private readonly images: ImageService,
    /** Undefined until vision's runCalibration is wired: POST then reports CALIBRATION_UNAVAILABLE. */
    private readonly runner: CalibrationRunner | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async calibrate(req: CalibrationRequest): Promise<{ calibration: CameraCalibration; created: boolean }> {
    const image = await this.repo.getImageObject(req.imageObjectId);
    if (!image) throw notFound('IMAGE_OBJECT_NOT_FOUND', 'The referenced image upload does not exist.', { imageObjectId: req.imageObjectId });
    if (image.state !== 'finalized') {
      throw badRequest('IMAGE_NOT_FINALIZED', 'Finalize the image upload before calibrating.', { imageObjectId: req.imageObjectId });
    }
    if (image.association.kind !== 'calibration') {
      throw badRequest(
        'IMAGE_ASSOCIATION_MISMATCH',
        "Upload the calibration photo with associationKind 'calibration' and the new calibration id as associationId.",
        { imageObjectId: req.imageObjectId },
      );
    }
    const calibrationId = image.association.id;
    if (!ID.test(calibrationId)) throw badRequest('INVALID_CALIBRATION_ID', 'The calibration id (the upload associationId) is not valid.');

    // Idempotent retry: the same upload returns the stored calibration.
    const existing = await this.repo.getCameraCalibration(calibrationId);
    if (existing) {
      if (existing.imageObjectId !== req.imageObjectId || existing.hallId !== req.hallId) {
        throw conflict('CALIBRATION_ID_TAKEN', 'This calibration id is already used by another calibration.', { calibrationId });
      }
      return { calibration: existing, created: false };
    }
    if (!this.runner) {
      throw new HttpError(
        503,
        apiError('CALIBRATION_UNAVAILABLE', 'Camera calibration is not available on this server yet.', true),
      );
    }
    if (this.inFlight.has(calibrationId)) {
      throw conflict('CALIBRATION_IN_PROGRESS', 'This calibration is already running. Try again in a moment.', { calibrationId });
    }
    this.inFlight.add(calibrationId);
    try {
      const bytes = await this.images.readImageBytes(req.imageObjectId);
      const out = await this.runner.run({
        image: bytes,
        knownAreaCm2: req.knownAreaCm2,
        referenceLabel: req.referenceLabel,
      });
      const { widthPx, heightPx } = out;
      if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx <= 0 || heightPx <= 0) {
        throw new Error('Calibration returned invalid image dimensions.');
      }
      const succeeded =
        out.status === 'succeeded' &&
        Number.isInteger(out.referencePixels) &&
        out.referencePixels > 0 &&
        out.referencePixels <= widthPx * heightPx;
      const calibration: CameraCalibration = {
        calibrationId,
        hallId: req.hallId,
        cameraId: req.cameraId,
        createdAt: new Date(this.now()).toISOString(),
        status: succeeded ? 'succeeded' : 'failed',
        method: 'reference-area-v1',
        imageObjectId: req.imageObjectId,
        widthPx,
        heightPx,
        knownAreaCm2: req.knownAreaCm2,
        referenceLabel: req.referenceLabel,
        referencePixels: succeeded ? out.referencePixels : 0,
        // k recomputed here from the stored inputs (the reducer re-checks it).
        cm2PerPx: succeeded ? req.knownAreaCm2 / out.referencePixels : 0,
        intrinsics: out.intrinsics,
        cameraHeightCmGeometric: succeeded ? out.cameraHeightCmGeometric : 0,
        flags: [...new Set(out.flags)],
        ...(succeeded
          ? {}
          : {
              error:
                out.error ??
                apiError('REFERENCE_NOT_FOUND', `The ${req.referenceLabel} could not be found in the photo. Place it flat in view and try again.`, false),
            }),
      };
      if (out.overlayJpeg) {
        calibration.overlayObjectId = (
          await this.images.storeDerived('calibration_overlay', calibrationId, 'calibrations/overlays', out.overlayJpeg, 'image/jpeg', widthPx, heightPx)
        ).objectId;
      }
      if (out.referenceMaskPng) {
        calibration.referenceMaskObjectId = (
          await this.images.storeDerived('calibration_overlay', calibrationId, 'calibrations/masks', out.referenceMaskPng, 'image/png', widthPx, heightPx)
        ).objectId;
      }
      await this.repo.upsertCameraCalibration(calibration);
      log.info('calibration stored', {
        calibrationId,
        hallId: req.hallId,
        status: calibration.status,
        flags: calibration.flags.join(','),
      });
      return { calibration, created: true };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // Infrastructure failure (Gemini, SAM, storage): nothing persisted, so a retry with the same upload is safe.
      const apiErr =
        err && typeof err === 'object' && 'apiError' in err ? ((err as { apiError: unknown }).apiError as Record<string, unknown>) : undefined;
      throw new HttpError(
        503,
        apiError(
          typeof apiErr?.code === 'string' ? apiErr.code : 'CALIBRATION_INFRASTRUCTURE_ERROR',
          typeof apiErr?.message === 'string' ? apiErr.message : 'Calibration could not run right now. It is safe to retry.',
          true,
        ),
      );
    } finally {
      this.inFlight.delete(calibrationId);
    }
  }

  async get(calibrationId: string): Promise<CameraCalibration> {
    const cal = await this.repo.getCameraCalibration(calibrationId);
    if (!cal) throw notFound('CALIBRATION_NOT_FOUND', 'No calibration has this id.', { calibrationId });
    return cal;
  }

  async list(hallId?: string): Promise<CameraCalibration[]> {
    const all = await this.repo.listCameraCalibrations(hallId);
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.calibrationId.localeCompare(a.calibrationId));
  }

  async signedImages(calibrationId: string): Promise<CalibrationImages> {
    const cal = await this.get(calibrationId);
    return {
      calibrationId,
      photo: await this.sign(cal.imageObjectId),
      overlay: cal.overlayObjectId ? await this.sign(cal.overlayObjectId) : null,
      referenceMask: cal.referenceMaskObjectId ? await this.sign(cal.referenceMaskObjectId) : null,
    };
  }

  private async sign(objectId: string): Promise<SignedImage | null> {
    try {
      const a = await this.images.getReadAccess(objectId);
      return { objectId, url: a.url, expiresAt: a.expiresAt };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 409)) return null;
      throw err;
    }
  }

  // ---- measurement settings ----

  defaults(hallId: string): MeasurementSettings {
    return {
      hallId,
      activeCalibrationId: null,
      updatedAt: new Date(0).toISOString(),
    };
  }

  async getSettings(hallId: string): Promise<MeasurementSettings> {
    return (await this.repo.getMeasurementSettings(hallId)) ?? this.defaults(hallId);
  }

  /**
   * Partial update: omitted fields keep their current value. Legacy
   * `depthEnabled` / `plateThicknessCm` (Depth Anything V2 was removed) are
   * accepted and ignored so old clients keep working; the response never
   * contains them.
   */
  async putSettings(body: unknown): Promise<MeasurementSettings> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.hallId !== 'string' || b.hallId.length === 0) throw badRequest('INVALID_SETTINGS', "'hallId' is required.");
    const current = await this.getSettings(b.hallId);
    const next: MeasurementSettings = { ...current, updatedAt: new Date(this.now()).toISOString() };
    const ignored = IGNORED_LEGACY_SETTINGS_FIELDS.filter((k) => b[k] !== undefined);
    if (ignored.length) log.info('measurement settings: ignored legacy fields', { hallId: b.hallId, fields: ignored.join(',') });
    if (b.activeCalibrationId !== undefined) {
      const id = b.activeCalibrationId;
      if (id !== null && (typeof id !== 'string' || id.length === 0)) {
        throw badRequest('INVALID_SETTINGS', "'activeCalibrationId' must be a calibration id or null.");
      }
      if (id !== null) {
        const cal = await this.repo.getCameraCalibration(id);
        if (!cal || cal.hallId !== b.hallId || cal.status !== 'succeeded') {
          throw badRequest('INVALID_CALIBRATION', 'Only a successful calibration of this hall can be activated.', { calibrationId: id });
        }
      }
      next.activeCalibrationId = id;
    }
    await this.repo.upsertMeasurementSettings(next);
    return next;
  }

  /** Seed (IT_4 deliverable 6): default settings for a hall, only when none exist. */
  async ensureDefaults(hallId: string): Promise<{ settings: MeasurementSettings; created: boolean }> {
    const existing = await this.repo.getMeasurementSettings(hallId);
    if (existing) return { settings: existing, created: false };
    const settings = { ...this.defaults(hallId), updatedAt: new Date(this.now()).toISOString() };
    await this.repo.upsertMeasurementSettings(settings);
    return { settings, created: true };
  }
}
