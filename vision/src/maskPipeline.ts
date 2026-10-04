/**
 * Classification -> segmentation -> Pixels wasted (contracts/measurement.md,
 * MVP_AI.md "Proposed image-processing flow"), with target-dish counting
 * (BIG-PLAN v2, V3: each capture counts only the dish being scanned).
 *
 *   1. Gemini (1 or 2 passes, default 2, merged by IoU) classifies leftover
 *      food against the numbered menu, boxes every piece, names the TARGET
 *      DISH (the plate/bowl most centered and most fully in frame) and marks
 *      each food box as on or off that dish (localize.ts, prompt v4). This is
 *      the only Gemini stage: `passes` calls per capture (the old separate
 *      plate-box call is gone).
 *   2. Boxes convert from Gemini [ymin, xmin, ymax, xmax] (0-1000) to pixel
 *      XYXY on the exact analyzed image; invalid boxes fail their region.
 *      Boxes overlapping by IoU > 0.5 are one piece; the smaller box (and its
 *      on/off-dish mark) is kept. Food boxes marked off the target dish are
 *      excluded (`OTHER_DISH`): recorded as skipped regions, never counted.
 *   3. SAM 2.1 segments the target-food boxes, the excluded boxes (for the
 *      overlay/diagnostics only), and the target-dish box on that same image
 *      in one request (one embedding; chunks of 128 boxes if ever needed).
 *   4. Masks are decoded and validated (exact size, strictly binary, nonempty).
 *   5. Target-dish clip (targetDish.ts): the dish mask becomes a filled,
 *      dilated region; every food mask is clipped to it. No dish, no valid
 *      dish mask, or an implausible region (tiny or nearly the whole frame)
 *      => no clipping, flag `target_dish_unavailable`, counts kept.
 *   6. Pixels are counted in code (rule target-dish-v1 = the clip above +
 *      smallest-first-v1 overlap resolution, masks.ts). Each bucket's
 *      exclusive mask is returned for storage and backs maskCount.
 *   7. A segmented overlay JPEG (overlay.ts) is rendered for the backend to
 *      store: counted food tinted per item, other-dish food hatched grey,
 *      target dish outlined. A rendering failure leaves `overlay: null`.
 *
 *   8. Optional physical stage (IT_4 I6, `input.physical`): with an
 *      active camera calibration of the SAME resolution, every measurement
 *      gets `physical` = calibrated area (pixels × k, area.ts). A different
 *      resolution ⇒ no physical numbers, reason `incompatible_geometry`; no
 *      calibration ⇒ `no_calibration`. Pixels are never changed by this stage.
 *
 * No per-capture plate-size calibration (BIG-PLAN v2, V1): pixels are the
 * measurement; physical numbers come only from a camera calibration (IT_4).
 *
 * Stage outcomes stay separate: classification failure, explicit empty
 * plate, partial segmentation, and total segmentation failure each produce a
 * distinct, contract-valid attempt. A failed stage never becomes zero pixels.
 */

import type {
  AnalysisAttempt,
  AnalysisStatus,
  ApiError,
  CameraIntrinsics,
  ClassificationRegion,
  CountStatus,
  FoodMeasurement,
  ImageGeometry,
  MaskPixelCount,
  MenuItem,
  PhysicalEstimate,
  PhysicalMethod,
  QualityFlag,
  ReferencePortion,
  RegionBox,
  SegmentationResult,
} from './contracts.js';
import { NEIGHBOR_FOOD_EXCLUDED, TARGET_DISH_UNAVAILABLE } from './contracts.js';
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
  type LocalizedDish,
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
import type { Segmenter, SegmenterInfo, SegmentResponse } from './samClient.js';
import { buildDishRegion, clipToRegion, dishDilatePx } from './targetDish.js';
import { colorForIndex, renderOverlay, UNKNOWN_COLOR, type LabelSuffix, type OverlayBucket, type OverlayImage } from './overlay.js';
import { AREA_METHOD, computeAreaEstimate } from './area.js';

/** The calibration fields the physical stage needs (a stored CameraCalibration satisfies it). */
export interface PhysicalCalibration {
  calibrationId: string;
  widthPx: number;
  heightPx: number;
  cm2PerPx: number;
}

/** IT_4 optional physical stage input (the hall's active calibration). */
export interface PhysicalStageInput {
  /** The hall's active calibration; null ⇒ reason `no_calibration`. */
  calibration: PhysicalCalibration | null;
}

export type PhysicalUnavailable = 'no_calibration' | 'incompatible_geometry' | 'analysis_unavailable' | 'no_measurements';

export interface PhysicalStageResult {
  status: 'applied' | 'unavailable' | 'not_requested';
  reason?: PhysicalUnavailable;
  calibrationId?: string;
  /** Always 'area-calibrated-v1' when applied. */
  method?: PhysicalMethod;
}

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
  /** DEPRECATED (BIG-PLAN v2): plate calibration was removed. Accepted and ignored. */
  calibration?: unknown;
  /** Render the segmented overlay JPEG. Default true. */
  renderOverlay?: boolean;
  /** IT_4: calibrated area per measurement. Omitted ⇒ pixels only. */
  physical?: PhysicalStageInput;
  /** IT_4 I8: text after each food's pixels in the overlay legend (backend-supplied, e.g. grams · CO2e · water). */
  labelSuffix?: LabelSuffix;
}

/** Target-dish counting outcome for one capture (BIG-PLAN v2, V3). Field names are stable. */
export interface TargetDishInfo {
  /** Gemini named a target dish with a usable box. */
  found: boolean;
  dishType?: 'plate' | 'bowl' | 'other';
  /** False when Gemini says the rim is cut off by the frame. */
  fullyVisible?: boolean;
  /** Gemini box [ymin, xmin, ymax, xmax] 0-1000 + pixel XYXY on the analyzed image. */
  box?: RegionBox;
  /** IoU of the two passes' dish boxes when both passes named one (agreement check). */
  passAgreementIoU?: number;
  /** Food masks were clipped to the dish region. */
  clipApplied: boolean;
  /**
   * Why no clip: 'no_food' (nothing to count), 'not_found' | 'bad_target_dish' |
   * 'bad_dish_type' | 'legacy_array' | 'dish_box_invalid' (no usable dish),
   * 'segmentation_failed' | 'dish_mask_invalid' | 'dish_mask_empty' |
   * 'region_too_small' | 'region_too_large' | 'region_incomplete' (no plausible region).
   */
  clipUnavailableReason?: string;
  /** Pixels in the filled, dilated dish region (also reported for implausible regions). */
  regionPx?: number;
  /** Dilation applied to the dish region, in pixels. */
  dilatePx: number;
  /** Food boxes Gemini placed on another dish (after the two-pass merge); never counted. */
  excludedBoxes: number;
  /** Not-counted food pixels outside the target dish: other-dish masks plus clipped-off pixels, minus counted pixels. */
  otherDishPx: number;
  /** Target-food mask pixels removed by the dish clip (subset of otherDishPx). */
  clippedPx: number;
}

export interface MaskAnalysisDiagnostics {
  /** Why `overlay` is null, when rendering was attempted or skipped. */
  overlayError?: string;
}

/** Per-plate localization diagnostics (box counts per pass and after merge). */
export interface LocalizationStats {
  passes: 1 | 2;
  /** Gemini requests made for this capture (= passes; no separate plate call). */
  geminiCalls: number;
  /** Boxes returned by each pass; null when that pass failed. */
  passBoxes: (number | null)[];
  /** Why a pass failed (error code or validation reason). */
  failedPasses: string[];
  /** Valid boxes kept after the IoU merge (target food + other-dish food). */
  mergedBoxes: number;
}

export interface MaskAnalysisResult {
  attempt: AnalysisAttempt;
  measurements: FoodMeasurement[];
  /** Validated binary PNG masks to store (full canvas, 255 = food), as counted (after the dish clip). */
  masks: { regionId: string; png: Uint8Array }[];
  /**
   * One exclusive mask per measurement (the pixels assigned to its bucket).
   * The caller stores the PNG and sets measurement.maskCount =
   * { ...count, maskObjectId }.
   */
  itemMasks: { measurementId: string; png: Uint8Array; count: Omit<MaskPixelCount, 'maskObjectId'> }[];
  /** Target-dish counting outcome (always present). */
  targetDish: TargetDishInfo;
  /**
   * Segmented overlay JPEG (counted food tinted per item, other-dish food
   * hatched grey, target dish outlined, pixel legend) for the backend to store
   * as an `overlay` image object. null when analysis produced nothing
   * countable or rendering failed (see diagnostics).
   */
  overlay: OverlayImage | null;
  diagnostics: MaskAnalysisDiagnostics;
  localization: LocalizationStats;
  /** IT_4 physical stage outcome (status 'not_requested' when input.physical was omitted). */
  physical: PhysicalStageResult;
}

type StagesResult = Omit<MaskAnalysisResult, 'overlay' | 'diagnostics' | 'physical'>;
interface Stages {
  result: StagesResult;
  buckets: { itemId: string | null; pixels: number; bitmap: Uint8Array; regionIds: string[] }[];
  otherBitmap: Uint8Array | null;
  dishRegion: Uint8Array | null;
  dishBoxPx: [number, number, number, number] | null;
}

/** Boxes from the two passes overlapping more than this are the same piece; the smaller is kept. */
const MERGE_IOU = 0.5;
/** The SAM worker's per-request box limit (vision/sam/worker.py MAX_BOXES). */
const SAM_MAX_BOXES = 128;
/** Clipped-off pixels at or above this fraction of the frame set `neighbor_food_excluded` (0.1% = 1,049 px on 1024²). */
export const NEIGHBOR_CLIP_MIN_FRACTION = 0.001;

const NOT_RUN: SegmenterInfo = { model: 'not-run', checkpoint: 'not-run', codeRevision: 'not-run', device: 'none', settingsVersion: 'not-run' };

/**
 * Classification -> segmentation -> target-dish clip -> Pixels wasted, plus
 * the segmented overlay.
 */
export async function analyzeCaptureWithMasks(
  gateway: GeminiGateway,
  segmenter: Segmenter,
  input: MaskAnalysisInput,
): Promise<MaskAnalysisResult> {
  const { widthPx: W, heightPx: H } = input.geometry;
  const phys = input.physical;
  const cal = phys?.calibration ?? null;
  const compatible = !!cal && cal.widthPx === W && cal.heightPx === H;
  const stages = await runStages(gateway, segmenter, input);
  const countStatus = stages.result.attempt.segmentation?.countStatus;
  const analyzable = countStatus === 'complete' || countStatus === 'partial' || countStatus === 'empty';

  // IT_4 physical stage (pixels untouched).
  const physical: PhysicalStageResult = { status: 'not_requested' };
  const physicalByBucket: (PhysicalEstimate | null)[] = stages.buckets.map(() => null);
  if (phys) {
    if (!cal) Object.assign(physical, { status: 'unavailable', reason: 'no_calibration' });
    else if (!compatible) {
      Object.assign(physical, { status: 'unavailable', reason: 'incompatible_geometry', calibrationId: cal.calibrationId });
    } else if (!analyzable) Object.assign(physical, { status: 'unavailable', reason: 'analysis_unavailable', calibrationId: cal.calibrationId });
    else if (stages.result.measurements.length === 0) {
      Object.assign(physical, { status: 'unavailable', reason: 'no_measurements', calibrationId: cal.calibrationId });
    } else {
      physical.calibrationId = cal.calibrationId;
      const estimates = stages.buckets.map((b) => computeAreaEstimate(b.pixels, cal));
      estimates.forEach((e, k) => {
        physicalByBucket[k] = e;
        stages.result.measurements[k]!.physical = e;
      });
      physical.status = 'applied';
      physical.method = AREA_METHOD;
      stages.result.attempt.calibrationId = cal.calibrationId;
      stages.result.attempt.physicalMethod = physical.method;
    }
  }

  const diagnostics: MaskAnalysisDiagnostics = {};
  let overlay: OverlayImage | null = null;
  if (input.renderOverlay === false) diagnostics.overlayError = 'disabled';
  else if (!analyzable) diagnostics.overlayError = 'analysis_unavailable';
  else {
    const menuIndex = new Map(input.menu.items.map((item, k) => [item.itemId, k]));
    const regionLabel = new Map((stages.result.attempt.segmentation?.regions ?? []).map((r) => [r.regionId, r.visualLabel]));
    const buckets: OverlayBucket[] = stages.buckets
      .map((b, idx) => ({ b, physical: physicalByBucket[idx] ?? null }))
      .sort((x, y) => y.b.pixels - x.b.pixels)
      .map(({ b, physical: est }) => {
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
          physical: est,
        };
      });
    const rendered = await renderOverlay({
      image: input.image,
      widthPx: W,
      heightPx: H,
      buckets,
      otherDish: stages.otherBitmap ? { bitmap: stages.otherBitmap, pixels: stages.result.targetDish.otherDishPx } : null,
      dishRegion: stages.dishRegion,
      dishBox: stages.dishBoxPx,
      emptyText: countStatus === 'empty' ? 'No leftover food on the target dish' : 'No food pixels counted',
      ...(input.labelSuffix ? { labelSuffix: input.labelSuffix } : {}),
    });
    if (rendered.ok) overlay = rendered.overlay;
    else diagnostics.overlayError = rendered.reason;
  }
  return { ...stages.result, overlay, diagnostics, physical };
}

/** Clamp a rim box that comes back a hair outside 0-1000 (a dish touching the frame edge). */
function clampBox(box: unknown): unknown {
  return Array.isArray(box) && box.every((v) => typeof v === 'number' && Number.isFinite(v))
    ? box.map((v: number) => Math.min(1000, Math.max(0, v)))
    : box;
}

/** One SAM request, or 128-box chunks merged in order (dimensions must agree). */
async function segmentAll(segmenter: Segmenter, image: Uint8Array, boxes: [number, number, number, number][]): Promise<SegmentResponse> {
  if (boxes.length <= SAM_MAX_BOXES) return segmenter.segment(image, boxes);
  let merged: SegmentResponse | undefined;
  for (let k = 0; k < boxes.length; k += SAM_MAX_BOXES) {
    const res = await segmenter.segment(image, boxes.slice(k, k + SAM_MAX_BOXES));
    if (!merged) merged = { ...res, results: [...res.results] };
    else {
      if (res.widthPx !== merged.widthPx || res.heightPx !== merged.heightPx) merged.widthPx = -1;
      merged.results.push(...res.results);
    }
  }
  return merged!;
}

async function runStages(gateway: GeminiGateway, segmenter: Segmenter, input: MaskAnalysisInput): Promise<Stages> {
  const buckets: Stages['buckets'] = [];
  const now = input.now ?? (() => new Date());
  const { widthPx: W, heightPx: H } = input.geometry;
  const flags = new Set<QualityFlag>(['ai_estimate']);
  const passes: 1 | 2 = input.geminiPasses ?? (Number(process.env.GEMINI_PASSES ?? 2) === 1 ? 1 : 2);
  const promptVersion = passes === 2 ? `${LOCALIZE_PROMPT_VERSION}+closeup` : LOCALIZE_PROMPT_VERSION;
  const localization: LocalizationStats = { passes, geminiCalls: 0, passBoxes: [], failedPasses: [], mergedBoxes: 0 };
  const targetDish: TargetDishInfo = { found: false, clipApplied: false, dilatePx: dishDilatePx(W, H), excludedBoxes: 0, otherDishPx: 0, clippedPx: 0 };
  let otherBitmap: Uint8Array | null = null;
  let dishRegion: Uint8Array | null = null;
  let dishBoxPx: [number, number, number, number] | null = null;

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
  ): Stages => ({
    buckets,
    otherBitmap,
    dishRegion,
    dishBoxPx,
    result: {
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
      targetDish,
      localization,
    },
  });

  // 1. Classification + localization + target dish: 1 or 2 Gemini passes, in parallel.
  //    Pass 1 = the scrap-localize prompt; pass 2 = the same prompt plus
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
  localization.geminiCalls = prompts.length;
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

  // Target dish: the first usable pass with a usable dish box (pass 1 preferred).
  const dishBoxes: { dish: LocalizedDish; box: RegionBox }[] = [];
  let dishMissingReason: string | undefined;
  for (const l of usable) {
    if (!l.targetDish) {
      dishMissingReason ??= l.targetDishReason ?? 'not_found';
      continue;
    }
    const converted = geminiBoxToPixels(clampBox(l.targetDish.box2d), W, H);
    if (converted.ok) dishBoxes.push({ dish: l.targetDish, box: converted.box });
    else dishMissingReason ??= 'dish_box_invalid';
  }
  if (dishBoxes.length > 0) {
    const { dish, box } = dishBoxes[0]!;
    Object.assign(targetDish, { found: true, dishType: dish.dishType, fullyVisible: dish.fullyVisible, box });
    if (dishBoxes.length === 2) targetDish.passAgreementIoU = Number(boxIoU(box.pixelXyxy, dishBoxes[1]!.box.pixelXyxy).toFixed(3));
    dishBoxPx = box.pixelXyxy;
  }

  // Explicit empty plate only when every usable pass returned no pieces (a pass with pieces wins).
  const withPieces = usable.filter((l) => l.regions.length > 0);
  if (withPieces.length === 0) {
    flags.add('empty_plate');
    targetDish.clipUnavailableReason = 'no_food';
    return finish('succeeded', { info: NOT_RUN, status: 'skipped', countStatus: 'empty', capturePixelsWasted: 0, regions: [] });
  }

  // 2. Box conversion + validation, then merge across passes: keep every
  //    box, except where two boxes overlap heavily (IoU > 0.5) keep only the
  //    smaller one — same menu_id (duplicate) or different (more specific
  //    piece). The kept box's on/off-target-dish mark decides.
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
  const keptFood = kept.filter((c) => c.r.onTargetDish);
  const keptOther = kept.filter((c) => !c.r.onTargetDish);
  // An unusable target-food box fails its region (-> partial count) only when it is the sole source;
  // with two passes contributing pieces, the other pass's boxes cover that area. Unusable
  // other-dish boxes are ignored: they would never be counted anyway.
  const invalid = withPieces.length === 1 ? candidates.filter((c) => !c.converted.ok && c.r.onTargetDish) : [];
  let n = 0;
  const base = (r: (typeof candidates)[number]['r']) => ({
    regionId: `${input.attemptId}_r${++n}`,
    eventId: input.eventId,
    attemptId: input.attemptId,
    itemId: r.itemId,
    visualLabel: r.visualLabel,
  });
  const regions: ClassificationRegion[] = [...keptFood, ...invalid].map(({ r, converted }) =>
    converted.ok
      ? { ...base(r), box: converted.box, segmentationStatus: 'skipped' as const }
      : {
          ...base(r),
          box: { gemini: [0, 0, 0, 0], pixelXyxy: [0, 0, 0, 0], convention: 'gemini-yxyx-1000_to_xyxy-px_v1' },
          segmentationStatus: 'failed' as const,
          error: makeApiError('INVALID_BOX', 'The food box was not usable.', false, { reason: converted.reason, raw: String(r.box2d).slice(0, 80) }),
        },
  );
  const toSegment = regions.filter((r) => r.segmentationStatus === 'skipped');
  const excluded: ClassificationRegion[] = keptOther.map(({ r, converted }) => ({
    ...base(r),
    box: converted.ok ? converted.box : { gemini: [0, 0, 0, 0], pixelXyxy: [0, 0, 0, 0], convention: 'gemini-yxyx-1000_to_xyxy-px_v1' },
    segmentationStatus: 'skipped' as const,
    error: makeApiError('OTHER_DISH', 'This food is on another dish, so it was not counted for this capture.', false, { reason: 'other_dish' }),
  }));
  regions.push(...excluded);
  targetDish.excludedBoxes = excluded.length;
  if (excluded.length > 0) flags.add(NEIGHBOR_FOOD_EXCLUDED);

  // 3. Segmentation: target food + other-dish food + the target dish, one request.
  const dishIndex = dishBoxPx ? toSegment.length + excluded.length : -1;
  const boxes = [...toSegment.map((r) => r.box.pixelXyxy), ...excluded.map((r) => r.box.pixelXyxy), ...(dishBoxPx ? [dishBoxPx] : [])];
  let info = NOT_RUN;
  let res: SegmentResponse | undefined;
  let samError: ApiError | undefined;
  if (toSegment.length > 0 || excluded.length > 0) {
    try {
      res = await segmentAll(segmenter, input.image.bytes, boxes);
      info = res;
      if (res.widthPx !== W || res.heightPx !== H || res.results.length !== boxes.length) {
        flags.add('incompatible_geometry');
        throw new GatewayError(
          makeApiError('MASK_MISALIGNED', 'Segmentation output does not match the analyzed image.', false, {
            expected: [W, H, boxes.length],
            got: [res.widthPx, res.heightPx, res.results.length],
          }),
        );
      }
    } catch (err) {
      samError = err instanceof GatewayError ? err.apiError : makeApiError('SEGMENTATION_FAILED', 'Segmentation failed.', true);
      res = undefined;
    }
  }

  // 4. Validate every food mask before counting.
  const decodedFood: { region: ClassificationRegion; bitmap: Uint8Array; png: Uint8Array }[] = [];
  if (samError) {
    for (const region of toSegment) {
      region.segmentationStatus = 'failed';
      region.error = samError;
    }
  } else if (res) {
    toSegment.forEach((region, k) => {
      const out = res!.results[k]!;
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
      decodedFood.push({ region, bitmap: decoded.bitmap, png: out.maskPng });
    });
  }
  // Other-dish masks: diagnostics + overlay only.
  const other = new Uint8Array(W * H);
  let anyOther = false;
  if (res) {
    excluded.forEach((region, k) => {
      const out = res!.results[toSegment.length + k]!;
      const decoded = decodeBinaryMask(out.maskPng, W, H);
      if (!decoded.ok) return;
      region.maskPixels = decoded.pixels;
      for (let i = 0; i < other.length; i++) if (decoded.bitmap[i]) other[i] = 1;
      anyOther ||= decoded.pixels > 0;
    });
  }

  // 5. Target-dish region and clip.
  const hasFood = toSegment.length > 0 || invalid.length > 0;
  if (!hasFood) targetDish.clipUnavailableReason = 'no_food';
  else if (!dishBoxPx) targetDish.clipUnavailableReason = dishMissingReason ?? 'not_found';
  else if (!res) targetDish.clipUnavailableReason = 'segmentation_failed';
  else {
    const decoded = decodeBinaryMask(res.results[dishIndex]!.maskPng, W, H);
    if (!decoded.ok) targetDish.clipUnavailableReason = 'dish_mask_invalid';
    else {
      const built = buildDishRegion(decoded.bitmap, W, H, dishBoxPx);
      targetDish.regionPx = built.regionPx;
      if (built.ok) {
        dishRegion = built.region;
        targetDish.clipApplied = true;
      } else targetDish.clipUnavailableReason = built.reason;
    }
  }
  if (hasFood && !targetDish.clipApplied) flags.add(TARGET_DISH_UNAVAILABLE);

  const masks: MaskAnalysisResult['masks'] = [];
  const counted: CountedRegion[] = [];
  for (const { region, bitmap, png } of decodedFood) {
    let use = bitmap;
    let usePng = png;
    if (dishRegion) {
      const clip = clipToRegion(bitmap, dishRegion);
      if (clip.removed > 0) {
        targetDish.clippedPx += clip.removed;
        for (let i = 0; i < bitmap.length; i++) if (bitmap[i] && !dishRegion[i]) other[i] = 1;
        anyOther = true;
      }
      if (clip.kept === 0) {
        region.segmentationStatus = 'skipped';
        region.error = makeApiError('OUTSIDE_TARGET_DISH', 'This food mask lies outside the scanned dish, so it was not counted.', false, {
          reason: 'outside_target_dish',
          maskPixels: region.maskPixels,
        });
        delete region.maskPixels;
        delete region.score;
        continue;
      }
      if (clip.removed > 0) {
        use = clip.bitmap;
        usePng = encodeBinaryMask(use, W, H);
        region.maskPixels = clip.kept;
      }
    }
    counted.push({ regionId: region.regionId, itemId: region.itemId, bitmap: use });
    masks.push({ regionId: region.regionId, png: usePng });
  }
  if (targetDish.clippedPx >= NEIGHBOR_CLIP_MIN_FRACTION * W * H) flags.add(NEIGHBOR_FOOD_EXCLUDED);
  // Not-counted pixels: other-dish masks + clipped-off pixels, minus anything counted.
  const settleOther = (countedUnion: Uint8Array | null) => {
    if (!anyOther) return;
    let px = 0;
    for (let i = 0; i < other.length; i++) {
      if (other[i] && countedUnion?.[i]) other[i] = 0;
      px += other[i]!;
    }
    targetDish.otherDishPx = px;
    otherBitmap = px > 0 ? other : null;
  };

  const failed = regions.filter((r) => r.segmentationStatus === 'failed').length;
  if (failed > 0) flags.add('segmentation_failed');
  if (counted.length === 0) {
    settleOther(null);
    if (failed === 0) {
      // Nothing on the target dish to count: every food box was on another dish
      // (a real zero for this dish), or every target mask fell outside the dish
      // region (Gemini and the clip disagree: zero, but needs review).
      const clippedOut = toSegment.length > 0;
      if (!clippedOut) flags.add('empty_plate');
      return finish(clippedOut ? 'needs_review' : 'succeeded', {
        info,
        status: clippedOut ? 'succeeded' : 'skipped',
        countStatus: 'empty',
        capturePixelsWasted: 0,
        regions,
      });
    }
    const firstRegionError = regions.find((r) => r.segmentationStatus === 'failed')?.error;
    return finish(
      'failed',
      { info, status: 'failed', countStatus: 'unavailable', regions },
      [],
      [],
      makeApiError('SEGMENTATION_FAILED', 'No valid food mask was produced, so no pixels were counted.', firstRegionError?.retryable ?? true, {
        cause: firstRegionError?.code,
      }),
    );
  }

  // 6. Count pixels.
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
  const countedUnion = new Uint8Array(W * H);
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
    for (let i = 0; i < bitmap.length; i++) if (bitmap[i]) countedUnion[i] = 1;
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
  settleOther(countedUnion);

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
