/**
 * Plate gallery read models (BIG-PLAN D7, contracts CaptureImages):
 * short-lived read URLs for a capture's original photo, its segmented
 * overlay, and its per-food masks. URLs come from the storage adapter's
 * read access, appear only in responses, and are never logged or stored.
 */

import { UNKNOWN_FOOD_LABEL } from '@scrap/analytics';
import { HttpError, notFound } from '../errors.js';
import type { Repository } from '../repo/repository.js';
import type { ImageService } from './imageService.js';
import type { IngestionService } from './ingestionService.js';
import type { AnalysisAttempt, CaptureImages, FoodMeasurement, SignedImage } from '../types.js';


export class CaptureService {
  constructor(
    private readonly repo: Repository,
    private readonly images: ImageService,
    private readonly ingestion: IngestionService,
  ) {}

  /**
   * The attempt whose images describe the plate: the counted (latest
   * succeeded) attempt, else the latest attempt (e.g. needs_review), so a
   * reviewer still sees what the analysis drew.
   */
  async displayAttempt(eventId: string): Promise<AnalysisAttempt | undefined> {
    return (await this.ingestion.countedAttempt(eventId)) ?? (await this.repo.listAnalysisAttempts(eventId)).at(-1);
  }

  async captureImages(eventId: string): Promise<CaptureImages> {
    const event = await this.repo.getCaptureEvent(eventId);
    if (!event) throw notFound('CAPTURE_NOT_FOUND', 'No capture event has this ID.', { eventId });
    const attempt = await this.displayAttempt(eventId);
    const measurements: FoodMeasurement[] = attempt ? await this.repo.listMeasurementsByAttempt(attempt.attemptId) : [];
    const menu = await this.repo.getMenuByService(event.serviceId);
    const names = new Map((menu?.items ?? []).map((i) => [i.itemId, i.displayName]));
    const nameOf = (itemId: string | null) => (itemId === null ? UNKNOWN_FOOD_LABEL : names.get(itemId) ?? itemId);

    // Per-food masks: the exclusive per-item masks behind each count; for
    // attempts without them, the per-region masks.
    const maskRefs: Array<{ objectId: string; itemId: string | null }> = [];
    for (const m of measurements) {
      if (m.maskCount?.maskObjectId) maskRefs.push({ objectId: m.maskCount.maskObjectId, itemId: m.itemId });
    }
    if (maskRefs.length === 0) {
      for (const r of attempt?.segmentation?.regions ?? []) {
        if (r.maskObjectId) maskRefs.push({ objectId: r.maskObjectId, itemId: r.itemId });
      }
    }

    const masks: CaptureImages['masks'] = [];
    for (const ref of maskRefs) {
      const signed = await this.sign(ref.objectId);
      if (signed) masks.push({ ...signed, itemId: ref.itemId, displayName: nameOf(ref.itemId) });
    }
    return {
      eventId,
      original: await this.sign(event.imageObjectId),
      overlay: attempt?.overlayObjectId ? await this.sign(attempt.overlayObjectId) : null,
      masks,
    };
  }

  /** Temporary read access, or null when the object is missing/unfinalized. Storage outages propagate. */
  private async sign(objectId: string): Promise<SignedImage | null> {
    try {
      const access = await this.images.getReadAccess(objectId);
      return { objectId, url: access.url, expiresAt: access.expiresAt };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 409)) return null;
      throw err;
    }
  }
}
