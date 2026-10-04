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
 *   6. Plate calibration plate-fit-v1 (calibration.ts, BIG-PLAN D2): Gemini's
 *      plate box is requested concurrently with step 1; after the food masks,
 *      SAM masks the plate and a rim circle gives cm^2/px. Any failure falls
 *      back to a `configured-default` calibration flagged
 *      `calibration_default`. Calibration never changes pixel counts (food
 *      outside the dish is reported as a diagnostic, not subtracted).
 *   7. A segmented overlay JPEG (overlay.ts, D7) is rendered for the backend
 *      to store; a rendering failure leaves `overlay: null`.
 *
 * Stage outcomes stay separate: classification failure, explicit empty
 * plate, partial segmentation, and total segmentation failure each produce a
 * distinct, contract-valid attempt. A failed stage never becomes zero pixels.
 */

import type {
  AnalysisAttempt,
  ApiError,
  AnalysisStatus,
  ClassificationRegion,
  CountStatus,
  FoodMeasurement,
  ImageGeometry,
  MaskPixelCount,
  MenuItem,
  PlateCalibration,
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
import {
  defaultCalibration,
  fitPlate,
  locatePlate,
  pixelsOutsideCircle,
  type CalibrationOptions,
  type CalibrationOutcome,
} from './calibration.js';
import { colorForIndex, renderOverlay, UNKNOWN_COLOR, type OverlayBucket, type OverlayImage } from './overlay.js';

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
  /** Plate calibration (plate-fit-v1) settings; `{ enabled: false }` uses the configured default. */
  calibration?: CalibrationOptions;
  /** Render the segmented overlay JPEG. Default true. */
  renderOverlay?: boolean;
}

export interface MaskAnalysisDiagnostics {
  /** Why the configured-default calibration was used (absent after a successful fit). */
  calibrationError?: ApiError;
  calibrationPromptVersion: string;
  plateRimPoints?: number;
  plateRimInliers?: number;
  /** Counted food pixels lying outside the fitted dish circle (diagnostic; not subtracted). */
  pixelsOutsideDish?: number;
  /** Why `overlay` is null, when rendering was attempted or skipped. */
  overlayError?: string;
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
  /** Per-capture pixel -> cm^2 calibration; also set on attempt.calibration. Never missing. */
  calibration: PlateCalibration;
  /**
   * Segmented overlay JPEG (food masks tinted per food, plate rim, legend) for
   * the backend to store as an `overlay` image object. null when analysis
   * produced nothing countable or rendering failed (see diagnostics).
   */
  overlay: OverlayImage | null;
  diagnostics: MaskAnalysisDiagnostics;
}

type FoodStagesResult = Omit<MaskAnalysisResult, 'calibration' | 'overlay' | 'diagnostics'>;
interface FoodStages {
  result: FoodStagesResult;
  buckets: { itemId: string | null; pixels: number; bitmap: Uint8Array; regionIds: string[] }[];
}

const NOT_RUN: SegmenterInfo = { model: 'not-run', checkpoint: 'not-run', codeRevision: 'not-run', device: 'none', settingsVersion: 'not-run' };

/**
 * Classification -> segmentation -> Pixels wasted, plus plate calibration and
 * the segmented overlay. Backward compatible: callers that ignore the new
 * `calibration` / `overlay` / `diagnostics` fields see the same attempt,
 * measurements, and masks as before (attempt additionally carries
 * `calibration`).
 */
export async function analyzeCaptureWithMasks(
  gateway: GeminiGateway,
  segmenter: Segmenter,
  input: MaskAnalysisInput,
): Promise<MaskAnalysisResult> {
  const { widthPx: W, heightPx: H } = input.geometry;
  const calOptions = input.calibration ?? {};
  const calibrate = calOptions.enabled !== false;
  // Gemini's plate box runs concurrently with classification (never rejects).
  const located = calibrate ? locatePlate(gateway, input.image, W, H) : null;

  const food = await runFoodStages(gateway, segmenter, input);
  const countStatus = food.result.attempt.segmentation?.countStatus;
  const analyzable = countStatus === 'complete' || countStatus === 'partial' || countStatus === 'empty';

  let outcome: CalibrationOutcome;
  if (!located) outcome = defaultCalibration(calOptions);
  else if (!analyzable) {
    outcome = defaultCalibration(
      calOptions,
      makeApiError('CALIBRATION_SKIPPED', 'Plate calibration was skipped because the food analysis was unavailable.', true),
    );
  } else outcome = await fitPlate(segmenter, input.image, W, H, await located, calOptions);

  const diagnostics: MaskAnalysisDiagnostics = {
    calibrationPromptVersion: outcome.promptVersion,
    ...(outcome.error ? { calibrationError: outcome.error } : {}),
    ...(outcome.rimPoints !== undefined ? { plateRimPoints: outcome.rimPoints } : {}),
    ...(outcome.rimInliers !== undefined ? { plateRimInliers: outcome.rimInliers } : {}),
  };
  if (outcome.circle && food.buckets.length > 0) {
    const union = new Uint8Array(W * H);
    for (const b of food.buckets) for (let i = 0; i < union.length; i++) if (b.bitmap[i]) union[i] = 1;
    diagnostics.pixelsOutsideDish = pixelsOutsideCircle(union, W, H, outcome.circle);
  }

  let overlay: OverlayImage | null = null;
  if (input.renderOverlay === false) diagnostics.overlayError = 'disabled';
  else if (!analyzable) diagnostics.overlayError = 'analysis_unavailable';
  else {
    const menuIndex = new Map(input.menu.items.map((item, k) => [item.itemId, k]));
    const regionLabel = new Map((food.result.attempt.segmentation?.regions ?? []).map((r) => [r.regionId, r.visualLabel]));
    const buckets: OverlayBucket[] = [...food.buckets]
      .sort((a, b) => b.pixels - a.pixels)
      .map((b) => {
        const k = b.itemId === null ? undefined : menuIndex.get(b.itemId);
        const labels = [...new Set(b.regionIds.map((id) => regionLabel.get(id)).filter((l): l is string => !!l))];
        return {
          itemId: b.itemId,
          label:
            b.itemId === null
              ? `Unclassified food${labels.length ? ` (${labels.slice(0, 3).join('; ')})` : ''}`
              : (input.menu.items[k!]?.displayName ?? b.itemId),
          pixels: b.pixels,
          bitmap: b.bitmap,
          color: k === undefined ? UNKNOWN_COLOR : colorForIndex(k),
        };
      });
    const rendered = await renderOverlay({
      image: input.image,
      widthPx: W,
      heightPx: H,
      buckets,
      calibration: outcome.calibration,
      rim: outcome.circle,
      emptyText: countStatus === 'empty' ? 'No leftover food detected' : 'No food pixels counted',
    });
    if (rendered.ok) overlay = rendered.overlay;
    else diagnostics.overlayError = rendered.reason;
  }

  return {
    ...food.result,
    attempt: { ...food.result.attempt, calibration: outcome.calibration },
    calibration: outcome.calibration,
    overlay,
    diagnostics,
  };
}

async function runFoodStages(gateway: GeminiGateway, segmenter: Segmenter, input: MaskAnalysisInput): Promise<FoodStages> {
  const buckets: FoodStages['buckets'] = [];
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
  ): FoodStages => ({ buckets, result: {
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
  } });

  // 1. Classification + localization.
  const menuIds = input.menu.items.map((i) => i.itemId);
  let text: string;
  try {
    const imagePart = await imageInputToPart({ kind: 'bytes', bytes: input.image.bytes, mimeType: input.image.mimeType });
    text = await gateway.generateStructured({
      parts: [imagePart, { text: buildLocalizePrompt(input.menu.items, input.geometry) }],
      systemInstruction: LOCALIZE_SYSTEM_INSTRUCTION,
      responseSchema: buildLocalizeSchema(menuIds.length),
      temperature: 0,
    });
  } catch (err) {
    const error = err instanceof GatewayError ? err.apiError : makeApiError('VISION_INTERNAL', 'Unexpected classification error.', false);
    return finish('failed', { info: NOT_RUN, status: 'skipped', countStatus: 'unavailable', regions: [] }, [], [], error);
  }
  const located = validateLocalizeText(text, menuIds);
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
    buckets.push({ itemId, pixels, bitmap, regionIds });
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
