/**
 * Classification -> segmentation -> Pixels wasted (contracts/measurement.md,
 * MVP_AI.md "Proposed image-processing flow").
 *
 *   1. Gemini classifies leftover foods against the menu and boxes them.
 *   2. Boxes convert from Gemini [ymin, xmin, ymax, xmax] (0-1000) to pixel
 *      XYXY on the exact analyzed image; invalid boxes fail their region.
 *   3. SAM 2.1 segments every valid box on that same image (one embedding).
 *   4. Masks are decoded and validated (exact size, strictly binary, nonempty).
 *   5. Pixels are counted in code (rule union-v1, masks.ts). Each bucket's
 *      exclusive mask is returned for storage and backs maskCount.
 *
 * Stage outcomes stay separate: classification failure, explicit empty
 * plate, partial segmentation, and total segmentation failure each produce a
 * distinct, contract-valid attempt. A failed stage never becomes zero pixels.
 */

import type {
  AnalysisAttempt,
  AnalysisStatus,
  ClassificationRegion,
  CountStatus,
  FoodMeasurement,
  ImageGeometry,
  MaskPixelCount,
  MenuItem,
  QualityFlag,
  ReferencePortion,
  SegmentationResult,
} from './contracts.js';
import { GatewayError, makeApiError } from './errors.js';
import type { GeminiGateway } from './gateway.js';
import { imageInputToPart } from './image.js';
import {
  buildLocalizePrompt,
  buildLocalizeSchema,
  LOCALIZE_PROMPT_VERSION,
  LOCALIZE_SYSTEM_INSTRUCTION,
  validateLocalizeText,
} from './localize.js';
import {
  COUNTING_RULE_VERSION,
  countPixels,
  decodeBinaryMask,
  encodeBinaryMask,
  geminiBoxToPixels,
  type CountedRegion,
} from './masks.js';
import type { Segmenter, SegmenterInfo } from './samClient.js';

export interface MaskAnalysisInput {
  eventId: string;
  attemptId: string;
  /** The normalized capture image; both stages see exactly these bytes. */
  image: { bytes: Uint8Array; mimeType: string };
  geometry: ImageGeometry;
  menu: { menuId: string; menuVersion: number; items: MenuItem[] };
  /** Optional auxiliary baselines; never required for Pixels wasted. */
  baselines?: ReferencePortion[];
  now?: () => Date;
}

export interface MaskAnalysisResult {
  attempt: AnalysisAttempt;
  measurements: FoodMeasurement[];
  /** Validated binary PNG masks to store (full canvas, 255 = food). */
  masks: { regionId: string; png: Uint8Array }[];
  /**
   * One exclusive mask per measurement (the pixels assigned to its bucket).
   * The caller stores the PNG and sets measurement.maskCount =
   * { ...count, maskObjectId }.
   */
  itemMasks: { measurementId: string; png: Uint8Array; count: Omit<MaskPixelCount, 'maskObjectId'> }[];
}

const NOT_RUN: SegmenterInfo = { model: 'not-run', checkpoint: 'not-run', codeRevision: 'not-run', device: 'none', settingsVersion: 'not-run' };

export async function analyzeCaptureWithMasks(
  gateway: GeminiGateway,
  segmenter: Segmenter,
  input: MaskAnalysisInput,
): Promise<MaskAnalysisResult> {
  const now = input.now ?? (() => new Date());
  const { widthPx: W, heightPx: H } = input.geometry;
  const flags = new Set<QualityFlag>(['ai_estimate']);

  const finish = (
    status: AnalysisStatus,
    seg: Omit<SegmentationResult, 'widthPx' | 'heightPx' | 'countingRuleVersion' | 'promptSource' | keyof SegmenterInfo | 'regions'> & {
      info: SegmenterInfo;
      regions: ClassificationRegion[];
    },
    measurements: FoodMeasurement[] = [],
    masks: MaskAnalysisResult['masks'] = [],
    error?: AnalysisAttempt['error'],
    itemMasks: MaskAnalysisResult['itemMasks'] = [],
  ): MaskAnalysisResult => ({
    attempt: {
      eventId: input.eventId,
      attemptId: input.attemptId,
      menuId: input.menu.menuId,
      menuVersion: input.menu.menuVersion,
      baselineVersions: {},
      model: gateway.model,
      promptVersion: LOCALIZE_PROMPT_VERSION,
      status,
      ...(error ? { error } : {}),
      qualityFlags: [...flags],
      createdAt: now().toISOString(),
      segmentation: {
        model: seg.info.model,
        checkpoint: seg.info.checkpoint,
        codeRevision: seg.info.codeRevision,
        promptSource: 'gemini_box',
        settingsVersion: seg.info.settingsVersion,
        countingRuleVersion: COUNTING_RULE_VERSION,
        status: seg.status,
        countStatus: seg.countStatus,
        ...(seg.capturePixelsWasted !== undefined ? { capturePixelsWasted: seg.capturePixelsWasted } : {}),
        widthPx: W,
        heightPx: H,
        regions: seg.regions,
      },
    },
    measurements,
    masks,
    itemMasks,
  });

  // 1. Classification + localization.
  const allowed = new Set(input.menu.items.map((i) => i.itemId));
  let text: string;
  try {
    const imagePart = await imageInputToPart({ kind: 'bytes', bytes: input.image.bytes, mimeType: input.image.mimeType });
    text = await gateway.generateStructured({
      parts: [imagePart, { text: buildLocalizePrompt(input.menu.items, input.geometry) }],
      systemInstruction: LOCALIZE_SYSTEM_INSTRUCTION,
      responseSchema: buildLocalizeSchema([...allowed]),
      temperature: 0,
    });
  } catch (err) {
    const error = err instanceof GatewayError ? err.apiError : makeApiError('VISION_INTERNAL', 'Unexpected classification error.', false);
    return finish('failed', { info: NOT_RUN, status: 'skipped', countStatus: 'unavailable', regions: [] }, [], [], error);
  }
  const located = validateLocalizeText(text, allowed);
  if (!located.ok) {
    return finish(
      'failed',
      { info: NOT_RUN, status: 'skipped', countStatus: 'unavailable', regions: [] },
      [],
      [],
      makeApiError('VISION_INVALID_RESPONSE', 'The classification answer was unusable.', true, { reason: located.reason }),
    );
  }
  if (located.ambiguous) flags.add('ambiguous_items');

  // Explicit empty plate: a real zero, with no segmentation needed.
  if (located.plateEmpty) {
    flags.add('empty_plate');
    return finish('succeeded', { info: NOT_RUN, status: 'skipped', countStatus: 'empty', capturePixelsWasted: 0, regions: [] });
  }
  if (located.regions.length === 0) {
    flags.add('ambiguous_items');
    return finish(
      'needs_review',
      { info: NOT_RUN, status: 'skipped', countStatus: 'unavailable', regions: [] },
      [],
      [],
      makeApiError('NO_FOOD_REGIONS', 'Food was reported but no regions were located.', true),
    );
  }

  // 2. Box conversion + validation.
  const regions: ClassificationRegion[] = located.regions.map((r, n) => {
    const converted = geminiBoxToPixels(r.box2d, W, H);
    const base = {
      regionId: `${input.attemptId}_r${n + 1}`,
      eventId: input.eventId,
      attemptId: input.attemptId,
      itemId: r.itemId,
      visualLabel: r.visualLabel,
    };
    return converted.ok
      ? { ...base, box: converted.box, segmentationStatus: 'skipped' as const }
      : {
          ...base,
          box: { gemini: [0, 0, 0, 0], pixelXyxy: [0, 0, 0, 0], convention: 'gemini-yxyx-1000_to_xyxy-px_v1' },
          segmentationStatus: 'failed' as const,
          error: makeApiError('INVALID_BOX', 'The food box was not usable.', false, { reason: converted.reason, raw: String(r.box2d).slice(0, 80) }),
        };
  });
  const toSegment = regions.filter((r) => r.segmentationStatus === 'skipped');

  // 3. Segmentation (one call, one image embedding).
  let info = NOT_RUN;
  const masks: MaskAnalysisResult['masks'] = [];
  const counted: CountedRegion[] = [];
  if (toSegment.length > 0) {
    try {
      const res = await segmenter.segment(input.image.bytes, toSegment.map((r) => r.box.pixelXyxy));
      info = res;
      if (res.widthPx !== W || res.heightPx !== H || res.results.length !== toSegment.length) {
        flags.add('incompatible_geometry');
        throw new GatewayError(
          makeApiError('MASK_MISALIGNED', 'Segmentation output does not match the analyzed image.', false, {
            expected: [W, H, toSegment.length],
            got: [res.widthPx, res.heightPx, res.results.length],
          }),
        );
      }
      // 4. Validate every mask before counting.
      toSegment.forEach((region, k) => {
        const out = res.results[k]!;
        const decoded = decodeBinaryMask(out.maskPng, W, H);
        const reason = !decoded.ok
          ? decoded.reason
          : decoded.pixels === 0
            ? 'mask_empty'
            : decoded.pixels !== out.foregroundPx
              ? 'mask_count_mismatch'
              : undefined;
        if (reason || !decoded.ok) {
          region.segmentationStatus = 'failed';
          region.error = makeApiError('MASK_INVALID', 'The segmentation mask failed validation.', false, { reason });
          return;
        }
        region.segmentationStatus = 'succeeded';
        region.maskPixels = decoded.pixels;
        if (Number.isFinite(out.score)) region.score = out.score;
        counted.push({ regionId: region.regionId, itemId: region.itemId, bitmap: decoded.bitmap });
        masks.push({ regionId: region.regionId, png: out.maskPng });
      });
    } catch (err) {
      const error = err instanceof GatewayError ? err.apiError : makeApiError('SEGMENTATION_FAILED', 'Segmentation failed.', true);
      for (const region of toSegment) {
        region.segmentationStatus = 'failed';
        region.error = error;
      }
    }
  }

  const failed = regions.filter((r) => r.segmentationStatus === 'failed').length;
  if (failed > 0) flags.add('segmentation_failed');
  if (counted.length === 0) {
    const firstError = regions.find((r) => r.error)?.error;
    return finish(
      'failed',
      { info, status: 'failed', countStatus: 'unavailable', regions },
      [],
      [],
      makeApiError('SEGMENTATION_FAILED', 'No valid food mask was produced, so no pixels were counted.', firstError?.retryable ?? true, {
        cause: firstError?.code,
      }),
    );
  }

  // 5. Count pixels.
  const counts = countPixels(counted, W * H);
  if (counts.contestedPx > 0) flags.add('overlapping_masks');
  const baselineFor = new Map((input.baselines ?? []).filter((b) => b.expectedAreaPx > 0).map((b) => [b.itemId, b]));
  const measurements: FoodMeasurement[] = [];
  const itemMasks: MaskAnalysisResult['itemMasks'] = [];
  const provenance = {
    geometry: input.geometry,
    menuId: input.menu.menuId,
    menuVersion: input.menu.menuVersion,
    classificationVersion: `${gateway.model}/${LOCALIZE_PROMPT_VERSION}`,
    segmentationVersion: `${info.model}/${info.checkpoint}/${info.settingsVersion}`,
    processingVersion: COUNTING_RULE_VERSION,
    assignment: 'exclusive' as const,
    validated: true as const,
  };
  let seq = 0;
  const push = (itemId: string | null, pixels: number, regionIds: string[], bitmap: Uint8Array, extra: QualityFlag[] = []) => {
    const qualityFlags: QualityFlag[] = ['ai_estimate', ...extra];
    const ref = itemId ? baselineFor.get(itemId) : undefined;
    const aux: Partial<FoodMeasurement> = {};
    if (ref) {
      const raw = pixels / ref.expectedAreaPx;
      Object.assign(aux, {
        baselineId: ref.baselineId,
        baselineAreaPx: ref.expectedAreaPx,
        rawWasteFraction: raw,
        displayWastePercent: 100 * Math.min(1, Math.max(0, raw)),
      });
      if (raw > 1) qualityFlags.push('above_baseline');
    } else {
      aux.unavailableReason = itemId ? 'no_baseline_auxiliary_only' : 'unclassified_food';
    }
    const measurementId = `meas_${input.attemptId}_${++seq}`;
    itemMasks.push({ measurementId, png: encodeBinaryMask(bitmap, W, H), count: { ...provenance, pixelsWasted: pixels } });
    measurements.push({
      measurementId,
      eventId: input.eventId,
      attemptId: input.attemptId,
      itemId,
      remainingAreaPx: pixels,
      regionIds,
      ...aux,
      method: 'mask_pixel_count',
      qualityFlags,
    });
  };
  for (const [itemId, pixels] of counts.perItem) {
    push(itemId, pixels, counts.regionsPerItem.get(itemId) ?? [], counts.itemBitmaps.get(itemId)!);
  }
  if (counts.unclassifiedPx > 0) {
    push(null, counts.unclassifiedPx, counts.unclassifiedRegionIds, counts.unclassifiedBitmap, counts.contestedPx > 0 ? ['overlapping_masks'] : []);
  }

  const partial = failed > 0;
  const countStatus: CountStatus = partial ? 'partial' : 'complete';
  const status: AnalysisStatus = partial || located.ambiguous ? 'needs_review' : 'succeeded';
  return finish(
    status,
    { info, status: partial ? 'partial' : 'succeeded', countStatus, capturePixelsWasted: counts.capturePx, regions },
    measurements,
    masks,
    undefined,
    itemMasks,
  );
}
