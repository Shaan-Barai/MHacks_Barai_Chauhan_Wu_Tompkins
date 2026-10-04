/**
 * Classification -> segmentation -> Pixels wasted (contracts/measurement.md,
 * MVP_AI.md "Proposed image-processing flow").
 *
 *   1. Gemini classifies leftover foods against the menu and boxes them.
 *   2. Boxes convert from Gemini [ymin, xmin, ymax, xmax] (0-1000) to pixel
 *      XYXY on the exact analyzed image; invalid boxes fail their region.
 *   3. SAM 2.1 segments every valid box on that same image (one embedding).
 *   4. Masks are decoded and validated (exact size, strictly binary, nonempty).
 *   5. Pixels are counted in code (rule smallest-first-v1, masks.ts). Each bucket's
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
  CLOSEUP_LINE,
  LOCALIZE_PROMPT_VERSION,
  LOCALIZE_SYSTEM_INSTRUCTION,
  validateLocalizeText,
} from './localize.js';
import {
  boxIoU,
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
  /** Gemini localization passes (1 or 2). Default: env GEMINI_PASSES, else 2. */
  geminiPasses?: 1 | 2;
  now?: () => Date;
}

/** Per-plate localization diagnostics (box counts per pass and after merge). */
export interface LocalizationStats {
  passes: 1 | 2;
  /** Boxes returned by each pass; null when that pass failed. */
  passBoxes: (number | null)[];
  /** Why a pass failed (error code or validation reason). */
  failedPasses: string[];
  /** Valid boxes kept after the IoU merge (sent to SAM). */
  mergedBoxes: number;
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
  localization: LocalizationStats;
}

/** Boxes from the two passes overlapping more than this are the same piece; the smaller is kept. */
const MERGE_IOU = 0.5;

const NOT_RUN: SegmenterInfo = { model: 'not-run', checkpoint: 'not-run', codeRevision: 'not-run', device: 'none', settingsVersion: 'not-run' };

export async function analyzeCaptureWithMasks(
  gateway: GeminiGateway,
  segmenter: Segmenter,
  input: MaskAnalysisInput,
): Promise<MaskAnalysisResult> {
  const now = input.now ?? (() => new Date());
  const { widthPx: W, heightPx: H } = input.geometry;
  const flags = new Set<QualityFlag>(['ai_estimate']);
  const passes: 1 | 2 = input.geminiPasses ?? (Number(process.env.GEMINI_PASSES ?? 2) === 1 ? 1 : 2);
  const promptVersion = passes === 2 ? `${LOCALIZE_PROMPT_VERSION}+closeup` : LOCALIZE_PROMPT_VERSION;
  const localization: LocalizationStats = { passes, passBoxes: [], failedPasses: [], mergedBoxes: 0 };

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
      promptVersion,
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
    localization,
  });

  // 1. Classification + localization: 1 or 2 Gemini passes, in parallel.
  //    Pass 1 = scrap-localize-v2 unchanged; pass 2 = the same prompt plus
  //    CLOSEUP_LINE (a different prompt, so it can find different boxes).
  const menuIds = input.menu.items.map((i) => i.itemId);
  const basePrompt = buildLocalizePrompt(input.menu.items, input.geometry);
  const prompts = passes === 2 ? [basePrompt, `${basePrompt}\n${CLOSEUP_LINE}`] : [basePrompt];
  let imagePart;
  try {
    imagePart = await imageInputToPart({ kind: 'bytes', bytes: input.image.bytes, mimeType: input.image.mimeType });
  } catch (err) {
    const error = err instanceof GatewayError ? err.apiError : makeApiError('VISION_INTERNAL', 'Unexpected classification error.', false);
    return finish('failed', { info: NOT_RUN, status: 'skipped', countStatus: 'unavailable', regions: [] }, [], [], error);
  }
  const settled = await Promise.allSettled(
    prompts.map((text) =>
      gateway.generateStructured({
        parts: [imagePart, { text }],
        systemInstruction: LOCALIZE_SYSTEM_INSTRUCTION,
        responseSchema: buildLocalizeSchema(menuIds.length),
        temperature: 0,
      }),
    ),
  );
  // A failed, timed-out, or invalid pass is dropped; the plate fails only if every pass did.
  const usable: Extract<ReturnType<typeof validateLocalizeText>, { ok: true }>[] = [];
  let firstError: AnalysisAttempt['error'];
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      const err = outcome.reason;
      const error = err instanceof GatewayError ? err.apiError : makeApiError('VISION_INTERNAL', 'Unexpected classification error.', false);
      firstError ??= error;
      localization.passBoxes.push(null);
      localization.failedPasses.push(error.code);
      continue;
    }
    const located = validateLocalizeText(outcome.value, menuIds);
    if (!located.ok) {
      firstError ??= makeApiError('VISION_INVALID_RESPONSE', 'The classification answer was unusable.', true, { reason: located.reason });
      localization.passBoxes.push(null);
      localization.failedPasses.push(`invalid:${located.reason}`);
      continue;
    }
    localization.passBoxes.push(located.regions.length);
    usable.push(located);
  }
  if (usable.length === 0) {
    return finish('failed', { info: NOT_RUN, status: 'skipped', countStatus: 'unavailable', regions: [] }, [], [], firstError);
  }
  const ambiguous = usable.some((l) => l.ambiguous);
  if (ambiguous) flags.add('ambiguous_items');

  // Explicit empty plate only when every usable pass returned [] (a pass with pieces wins).
  const withPieces = usable.filter((l) => l.regions.length > 0);
  if (withPieces.length === 0) {
    flags.add('empty_plate');
    return finish('succeeded', { info: NOT_RUN, status: 'skipped', countStatus: 'empty', capturePixelsWasted: 0, regions: [] });
  }

  // 2. Box conversion + validation, then merge across passes: keep every
  //    box, except where two boxes overlap heavily (IoU > 0.5) keep only the
  //    smaller one — same menu_id (duplicate) or different (more specific piece).
  const candidates = withPieces.flatMap((l, pass) =>
    l.regions.map((r, idx) => ({ r, pass, idx, converted: geminiBoxToPixels(r.box2d, W, H) })),
  );
  const area = (b: [number, number, number, number]) => (b[2] - b[0]) * (b[3] - b[1]);
  const kept: typeof candidates = [];
  for (const c of candidates.filter((c) => c.converted.ok).sort((x, y) => {
    const ax = x.converted.ok ? area(x.converted.box.pixelXyxy) : 0;
    const ay = y.converted.ok ? area(y.converted.box.pixelXyxy) : 0;
    return ax - ay || x.pass - y.pass || x.idx - y.idx;
  })) {
    if (!c.converted.ok) continue;
    const box = c.converted.box.pixelXyxy;
    if (kept.every((k) => k.converted.ok && boxIoU(k.converted.box.pixelXyxy, box) <= MERGE_IOU)) kept.push(c);
  }
  kept.sort((x, y) => x.pass - y.pass || x.idx - y.idx);
  localization.mergedBoxes = kept.length;
  // An unusable box fails its region (-> partial count) only when it is the sole source;
  // with two passes contributing pieces, the other pass's boxes cover that area.
  const invalid = withPieces.length === 1 ? candidates.filter((c) => !c.converted.ok) : [];
  const regions: ClassificationRegion[] = [...kept, ...invalid].map(({ r, converted }, n) => {
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
  if (counts.overlapPx > 0) flags.add('overlapping_masks');
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
    if (pixels === 0) continue; // every pixel went to smaller overlapping masks
    push(itemId, pixels, counts.regionsPerItem.get(itemId) ?? [], counts.itemBitmaps.get(itemId)!);
  }
  if (counts.unclassifiedPx > 0) {
    push(null, counts.unclassifiedPx, counts.unclassifiedRegionIds, counts.unclassifiedBitmap);
  }

  const partial = failed > 0;
  const countStatus: CountStatus = partial ? 'partial' : 'complete';
  const status: AnalysisStatus = partial || ambiguous ? 'needs_review' : 'succeeded';
  return finish(
    status,
    { info, status: partial ? 'partial' : 'succeeded', countStatus, capturePixelsWasted: counts.capturePx, regions },
    measurements,
    masks,
    undefined,
    itemMasks,
  );
}
