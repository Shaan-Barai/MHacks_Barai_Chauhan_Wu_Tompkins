/**
 * Capture ingestion and processing orchestration (AGENTS.md 5.2–5.4).
 *
 * Idempotency: CaptureEvent.eventId is the key. Submitting the same eventId
 * again NEVER creates a second observation:
 *   - already `succeeded`  -> the stored result is returned unchanged,
 *   - `failed`/`needs_review`/`pending` -> a RETRY runs a new analysis
 *     attempt on the SAME event (attempts are append-only history),
 *   - `processing` -> the in-flight state is returned.
 *
 * Processing states: pending -> processing -> succeeded | needs_review | failed.
 *
 * Context freezing (5.4): the menu version and the exact baseline versions
 * supplied to the analyzer are recorded on the AnalysisAttempt, so later menu
 * or baseline edits never silently rewrite historical results.
 *
 * All Gemini and object-storage network work happens HERE in service code —
 * when SpacetimeDB lands, only the repo persistence calls move into reducers
 * (see repo/repository.ts), never this orchestration.
 */

import { badRequest, notFound, apiError } from '../errors.js';
import { validMaskCount } from '@scrap/analytics';
import { newId } from '../ids.js';
import type { Analyzer } from '../analysis/analyzer.js';
import type { Repository } from '../repo/repository.js';
import type { ImageService } from './imageService.js';
import type { CaptureSubmission } from './validation.js';
import type {
  AnalysisAttempt,
  AnalysisResult,
  CaptureEvent,
  FoodMeasurement,
  MenuBundle,
  ProcessingState,
  ReferencePortion,
} from '../types.js';

export interface IngestResult {
  event: CaptureEvent;
  attempt?: AnalysisAttempt;
  measurements: FoodMeasurement[];
  /** true when this call was a replay of an already-succeeded event. */
  deduplicated: boolean;
}

export class IngestionService {
  constructor(
    private readonly repo: Repository,
    private readonly images: ImageService,
    private readonly analyzer: Analyzer,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async submitCapture(submission: CaptureSubmission): Promise<IngestResult> {
    const existing = await this.repo.getCaptureEvent(submission.eventId);

    if (existing && (existing.state === 'succeeded' || existing.state === 'processing')) {
      // Idempotent replay: same event, no new observation, no new attempt.
      return {
        event: existing,
        measurements: await this.countedMeasurements(existing),
        deduplicated: true,
      };
    }

    // Verify the image object: it must exist, be finalized, and belong to
    // THIS capture (5.7: register only verified objects for the intended upload).
    const image = await this.repo.getImageObject(submission.imageObjectId);
    if (!image) {
      throw notFound('IMAGE_OBJECT_NOT_FOUND', 'The referenced image upload does not exist.', {
        imageObjectId: submission.imageObjectId,
      });
    }
    if (image.state !== 'finalized') {
      throw badRequest(
        'IMAGE_NOT_FINALIZED',
        'Finalize the image upload before submitting the capture.',
        { imageObjectId: submission.imageObjectId, state: image.state },
      );
    }
    if (image.association.kind !== 'capture' || image.association.id !== submission.eventId) {
      throw badRequest(
        'IMAGE_ASSOCIATION_MISMATCH',
        'This image was uploaded for a different capture event.',
        { imageObjectId: submission.imageObjectId, eventId: submission.eventId },
      );
    }

    // Resolve the menu for this service; a capture without a menu is a clear
    // recoverable error, never a silent zero-waste record.
    const menu = await this.repo.getMenuByService(submission.serviceId);
    if (!menu) {
      throw notFound('MENU_NOT_FOUND', 'No menu is saved for this hall and service yet. Add one in Menus.', {
        serviceId: submission.serviceId,
      });
    }
    if (menu.service.hallId !== submission.hallId) {
      throw badRequest('HALL_SERVICE_MISMATCH', 'This service belongs to a different dining hall.', {
        serviceId: submission.serviceId,
        hallId: submission.hallId,
      });
    }

    const event: CaptureEvent = {
      eventId: submission.eventId,
      hallId: submission.hallId,
      serviceId: submission.serviceId,
      capturedAt: submission.capturedAt,
      imageObjectId: submission.imageObjectId,
      geometry: submission.geometry,
      source: submission.source,
      qualityFlags: submission.qualityFlags ?? existing?.qualityFlags ?? [],
      state: 'processing',
    };
    await this.repo.upsertCaptureEvent(event);

    // Freeze the analysis context: this menu version + the latest baseline
    // per item, recorded on the attempt (5.4).
    const baselines = await this.resolveBaselines(menu);
    const attemptId = newId('att');

    let attempt: AnalysisAttempt;
    let measurements: FoodMeasurement[];
    try {
      const result = await this.analyzer.analyze({
        event,
        attemptId,
        menu,
        baselines,
        getImage: () => this.images.readImageBytes(event.imageObjectId),
      });
      attempt = result.attempt;
      measurements = this.validateMeasurements(this.withMaskCounts(result), menu, attemptId, event);
      this.validateSegmentation(attempt, measurements);
      // Masks go to object storage; only their ids reach the database.
      if (attempt.segmentation && result.masks?.length) {
        const byRegion = new Map(attempt.segmentation.regions.map((r) => [r.regionId, r]));
        for (const mask of result.masks) {
          const region = byRegion.get(mask.regionId);
          if (!region) throw new Error(`Analyzer returned a mask for unknown region ${mask.regionId}.`);
          const stored = await this.images.storeMask(
            mask.regionId,
            mask.png,
            attempt.segmentation.widthPx,
            attempt.segmentation.heightPx,
          );
          region.maskObjectId = stored.objectId;
        }
      }
      for (const mask of result.itemMasks ?? []) {
        const m = measurements.find((x) => x.measurementId === mask.measurementId)!;
        const stored = await this.images.storeMask(mask.measurementId, mask.png, event.geometry.widthPx, event.geometry.heightPx);
        m.maskCount!.maskObjectId = stored.objectId;
      }
    } catch (err) {
      // Infrastructure failure: record an explicit failed attempt, never
      // silence it and never leave the event stuck in `processing`.
      attempt = {
        eventId: event.eventId,
        attemptId,
        menuId: menu.service.menuId,
        menuVersion: menu.service.menuVersion,
        baselineVersions: Object.fromEntries(baselines.map((b) => [b.itemId, b.baselineVersion])),
        model: 'unknown',
        promptVersion: 'unknown',
        status: 'failed',
        error: apiError(
          'ANALYSIS_INFRASTRUCTURE_ERROR',
          err instanceof Error ? err.message : 'Analysis could not run.',
          true,
        ),
        qualityFlags: [],
        createdAt: new Date(this.now()).toISOString(),
      };
      measurements = [];
    }

    await this.repo.recordAnalysis(attempt, measurements);

    const finalState: ProcessingState =
      attempt.status === 'succeeded'
        ? 'succeeded'
        : attempt.status === 'needs_review'
          ? 'needs_review'
          : 'failed';
    const finalEvent: CaptureEvent = { ...event, state: finalState };
    await this.repo.upsertCaptureEvent(finalEvent);

    return { event: finalEvent, attempt, measurements, deduplicated: false };
  }

  /**
   * The measurements that count as THE observation for an event: those of the
   * latest succeeded attempt. Superseded/failed attempts stay stored as
   * history but are never double-counted.
   */
  async countedMeasurements(event: CaptureEvent): Promise<FoodMeasurement[]> {
    const attempt = await this.countedAttempt(event.eventId);
    return attempt ? this.repo.listMeasurementsByAttempt(attempt.attemptId) : [];
  }

  async countedAttempt(eventId: string): Promise<AnalysisAttempt | undefined> {
    const attempts = await this.repo.listAnalysisAttempts(eventId);
    const succeeded = attempts.filter((a) => a.status === 'succeeded');
    succeeded.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.attemptId.localeCompare(b.attemptId));
    return succeeded.at(-1);
  }

  private async resolveBaselines(menu: MenuBundle): Promise<ReferencePortion[]> {
    const result: ReferencePortion[] = [];
    for (const item of menu.items) {
      const refs = await this.repo.listReferencePortions(item.itemId);
      refs.sort((a, b) => a.baselineVersion - b.baselineVersion);
      const latest = refs.at(-1);
      if (latest) result.push(latest);
    }
    return result;
  }

  /**
   * Attach each exclusive mask's count/provenance to its measurement. The
   * mask object id is filled in once the PNG is stored, after validation.
   */
  private withMaskCounts(result: AnalysisResult): FoodMeasurement[] {
    const byId = new Map((result.itemMasks ?? []).map((mask) => [mask.measurementId, mask]));
    if (byId.size !== (result.itemMasks ?? []).length) throw new Error('Analyzer returned duplicate exclusive masks.');
    const measurements = result.measurements.map((m) => {
      const mask = byId.get(m.measurementId);
      if (!mask) return m;
      byId.delete(m.measurementId);
      return { ...m, maskCount: { ...mask.count, maskObjectId: `pending:${m.measurementId}` } };
    });
    if (byId.size > 0) throw new Error(`Analyzer returned a mask for unknown measurement ${[...byId.keys()][0]}.`);
    return measurements;
  }

  /**
   * Pixels wasted invariants (contracts/measurement.md): integer mask counts
   * within the canvas, and for complete/partial captures the item +
   * unclassified pixels sum exactly to the capture's union total.
   */
  private validateSegmentation(attempt: AnalysisAttempt, measurements: FoodMeasurement[]): void {
    const seg = attempt.segmentation;
    const maskMeasurements = measurements.filter((m) => m.method === 'mask_pixel_count');
    if (!seg) {
      if (maskMeasurements.length > 0) throw new Error('Mask pixel counts were returned without a segmentation result.');
      return;
    }
    const canvas = seg.widthPx * seg.heightPx;
    for (const m of maskMeasurements) {
      if (!Number.isInteger(m.remainingAreaPx) || m.remainingAreaPx > canvas) {
        throw new Error(`Measurement ${m.measurementId} is not an integer pixel count within the image.`);
      }
    }
    const sum = maskMeasurements.reduce((total, m) => total + m.remainingAreaPx, 0);
    const capture = seg.capturePixelsWasted;
    if ((seg.countStatus === 'complete' || seg.countStatus === 'partial') && capture !== sum) {
      throw new Error(`Capture union ${capture} does not equal the measured pixels ${sum}.`);
    }
    if (seg.countStatus === 'empty' && (capture !== 0 || sum !== 0)) throw new Error('An empty plate must count 0 pixels.');
    if (seg.countStatus === 'unavailable' && capture !== undefined) throw new Error('An unavailable count has no total.');
  }

  /** Working rule 9: validate analyzer output before storing it. */
  private validateMeasurements(
    measurements: FoodMeasurement[],
    menu: MenuBundle,
    attemptId: string,
    event: CaptureEvent,
  ): FoodMeasurement[] {
    const menuItemIds = new Set(menu.items.map((i) => i.itemId));
    let maskPixels = 0;
    const normalized = measurements.map(m => structuredClone(m));
    for (const m of normalized) {
      if (m.eventId !== event.eventId || m.attemptId !== attemptId) {
        throw new Error(`Analyzer returned a measurement for the wrong event/attempt (${m.measurementId}).`);
      }
      if (m.itemId !== null && !menuItemIds.has(m.itemId)) {
        throw new Error(`Analyzer invented a non-menu item ID: ${m.itemId}.`);
      }
      if (!Number.isFinite(m.remainingAreaPx) || m.remainingAreaPx < 0) {
        throw new Error(`Analyzer returned an invalid remaining area for ${m.measurementId}.`);
      }
      if (m.method === 'mask_pixel_count') {
        // Quality-flag eligibility is decided at aggregation time; here only the
        // count and its provenance must be valid.
        const unflagged = validMaskCount({ ...m, qualityFlags: [] }, { ...event, qualityFlags: [] }, menu.service);
        if (!unflagged || m.maskCount!.pixelsWasted !== m.remainingAreaPx) {
          throw new Error(`Invalid mask count/provenance for ${m.measurementId}.`);
        }
        maskPixels += m.maskCount!.pixelsWasted;
        if (maskPixels > event.geometry.widthPx * event.geometry.heightPx) throw new Error('Mask assignments exceed image bounds.');
        // An invalid auxiliary denominator cannot invalidate a counted mask.
        if (m.baselineAreaPx !== undefined && (!Number.isFinite(m.baselineAreaPx) || m.baselineAreaPx <= 0)) {
          delete m.baselineAreaPx;
          delete m.baselineId;
          delete m.rawWasteFraction;
          delete m.displayWastePercent;
          m.unavailableReason = 'Auxiliary baseline comparison unavailable.';
          if (!m.qualityFlags.includes('missing_baseline')) m.qualityFlags.push('missing_baseline');
        }
        if (m.rawWasteFraction !== undefined && m.rawWasteFraction > 1 && !m.qualityFlags.includes('above_baseline')) m.qualityFlags.push('above_baseline');
      }
      if (m.baselineAreaPx !== undefined && (!Number.isFinite(m.baselineAreaPx) || m.baselineAreaPx <= 0)) {
        throw new Error(`Analyzer returned an invalid baseline area for ${m.measurementId}.`);
      }
      if (m.method !== 'mask_pixel_count' && m.displayWastePercent === undefined && m.unavailableReason === undefined) {
        throw new Error(`Measurement ${m.measurementId} has neither a percentage nor an unavailableReason.`);
      }
      if (
        m.rawWasteFraction !== undefined &&
        m.rawWasteFraction > 1 &&
        !m.qualityFlags.includes('above_baseline')
      ) {
        throw new Error(`Measurement ${m.measurementId} is above baseline but not flagged.`);
      }
    }
    return normalized;
  }
}
