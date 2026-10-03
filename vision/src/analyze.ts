/**
 * Capture analysis orchestration: image + menu/baseline context in,
 * contract-valid AnalysisAttempt + FoodMeasurement[] (or explicit failure) out.
 * AGENTS.md §5 Agent 4 and §7 (canonical math) govern this module.
 */

import type {
  AnalysisAttempt,
  AnalysisStatus,
  FoodMeasurement,
  ImageGeometry,
  MenuItem,
  QualityFlag,
  ReferencePortion,
} from './contracts.js';
import { GatewayError, makeApiError } from './errors.js';
import type { GeminiGateway } from './gateway.js';
import { imageInputToPart, type ImageInput } from './image.js';
import {
  baselineFromReference,
  computeMeasurement,
  computeUnknownMeasurement,
  type BaselineInput,
} from './measurement.js';
import {
  buildClassificationPrompt,
  buildResponseSchema,
  CLASSIFICATION_SYSTEM_INSTRUCTION,
  PROMPT_VERSION,
} from './prompt.js';
import { validateClassificationText } from './validate.js';

export interface AnalyzeCaptureInput {
  eventId: string;
  attemptId: string;
  /** Image bytes or an authorized temporary read URL (from Agent 5). */
  image: ImageInput;
  /** Geometry of the normalized observation image (topdown-normalized-v1). */
  geometry: ImageGeometry;
  menu: { menuId: string; menuVersion: number; items: MenuItem[] };
  /** Compatible uneaten reference portions from Agent 2 (may be empty). */
  baselines: ReferencePortion[];
  /**
   * When true, Gemini is asked to estimate an uneaten baseline for menu items
   * that lack one; such baselines are flagged 'gemini_estimated_baseline'.
   */
  estimateMissingBaselines?: boolean;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface AnalyzeCaptureResult {
  attempt: AnalysisAttempt;
  /** Empty when the attempt failed or the plate was empty. */
  measurements: FoodMeasurement[];
}

function geometriesCompatible(a: ImageGeometry, b: ImageGeometry): boolean {
  // §7.3: same coordinate space and same normalized resolution. The capture
  // pipeline (Agent 3) normalizes both sides identically.
  return a.coordinateSpace === b.coordinateSpace && a.widthPx === b.widthPx && a.heightPx === b.heightPx;
}

function validateInput(input: AnalyzeCaptureInput): string | undefined {
  const g = input.geometry;
  if (!Number.isFinite(g.widthPx) || g.widthPx <= 0 || !Number.isFinite(g.heightPx) || g.heightPx <= 0) {
    return 'invalid_geometry';
  }
  if (g.coordinateSpace !== 'topdown-normalized-v1') return 'unsupported_coordinate_space';
  const ids = new Set<string>();
  for (const item of input.menu.items) {
    if (item.itemId.trim() === '') return 'empty_menu_item_id';
    if (ids.has(item.itemId)) return 'duplicate_menu_item_id';
    ids.add(item.itemId);
  }
  return undefined;
}

export async function analyzeCapture(
  gateway: GeminiGateway,
  input: AnalyzeCaptureInput,
): Promise<AnalyzeCaptureResult> {
  const now = input.now ?? (() => new Date());

  const baseAttempt = {
    eventId: input.eventId,
    attemptId: input.attemptId,
    menuId: input.menu.menuId,
    menuVersion: input.menu.menuVersion,
    model: gateway.model,
    promptVersion: PROMPT_VERSION,
  };

  const fail = (
    status: Exclude<AnalysisStatus, 'succeeded'>,
    error: AnalysisAttempt['error'],
    flags: QualityFlag[] = [],
  ): AnalyzeCaptureResult => ({
    attempt: {
      ...baseAttempt,
      baselineVersions: {},
      status,
      ...(error !== undefined ? { error } : {}),
      qualityFlags: flags,
      createdAt: now().toISOString(),
    },
    measurements: [],
  });

  const inputProblem = validateInput(input);
  if (inputProblem !== undefined) {
    return fail(
      'failed',
      makeApiError('VISION_INVALID_INPUT', 'The analysis request was malformed and was not sent to Gemini.', false, {
        reason: inputProblem,
      }),
    );
  }

  // Resolve the compatible baseline (highest version wins) per menu item.
  const baselineByItem = new Map<string, ReferencePortion>();
  for (const ref of input.baselines) {
    if (!Number.isFinite(ref.expectedAreaPx) || ref.expectedAreaPx <= 0) continue; // invalid => treated as missing
    if (!geometriesCompatible(ref.geometry, input.geometry)) continue; // §7.3: never pool incompatible geometries
    const existing = baselineByItem.get(ref.itemId);
    if (existing === undefined || ref.baselineVersion > existing.baselineVersion) {
      baselineByItem.set(ref.itemId, ref);
    }
  }

  const itemIdsNeedingBaselineEstimate =
    input.estimateMissingBaselines === true
      ? input.menu.items.map((i) => i.itemId).filter((id) => !baselineByItem.has(id))
      : [];

  // 1. Call Gemini (image + menu-constrained structured output).
  let rawText: string;
  try {
    const imagePart = await imageInputToPart(input.image);
    rawText = await gateway.generateStructured({
      parts: [
        imagePart,
        { text: buildClassificationPrompt({ menuItems: input.menu.items, geometry: input.geometry, itemIdsNeedingBaselineEstimate }) },
      ],
      systemInstruction: CLASSIFICATION_SYSTEM_INSTRUCTION,
      responseSchema: buildResponseSchema(input.menu.items.map((i) => i.itemId)),
      temperature: 0,
    });
  } catch (err) {
    const apiError =
      err instanceof GatewayError
        ? err.apiError
        : makeApiError('VISION_INTERNAL', 'Unexpected error while requesting analysis.', false);
    return fail('failed', apiError);
  }

  // 2. Validate the untrusted model output.
  const allowedIds = new Set(input.menu.items.map((i) => i.itemId));
  const outcome = validateClassificationText(rawText, allowedIds, input.geometry);
  if (!outcome.ok) {
    return fail(outcome.severity, outcome.error);
  }
  const result = outcome.value;

  // 3. Build measurements per §7.
  const attemptFlags = new Set<QualityFlag>(['ai_estimate']);
  const measurements: FoodMeasurement[] = [];
  const baselineVersions: Record<string, number> = {};
  let status: AnalysisStatus = 'succeeded';
  let seq = 0;
  const identity = () => ({
    measurementId: `meas_${input.attemptId}_${++seq}`,
    eventId: input.eventId,
    attemptId: input.attemptId,
  });

  if (result.plateEmpty) {
    // A clean plate is a valid capture, but it does not prove which menu items
    // were served (§6) — so it yields no per-item measurements, never zeros.
    attemptFlags.add('empty_plate');
  } else {
    for (const item of result.items) {
      const ref = baselineByItem.get(item.itemId);
      let baseline: BaselineInput | undefined;
      if (ref !== undefined) {
        baseline = baselineFromReference(ref);
        baselineVersions[item.itemId] = ref.baselineVersion;
      } else if (item.estimatedUneatenAreaPx !== undefined && input.estimateMissingBaselines === true) {
        // Gemini-estimated baseline: explicitly labeled, never stored as a reference.
        baseline = { areaPx: item.estimatedUneatenAreaPx, geminiEstimated: true };
      }
      const measurement = computeMeasurement(identity(), item.itemId, item.remainingAreaPx, baseline);
      for (const flag of measurement.qualityFlags) {
        if (flag === 'above_baseline' || flag === 'missing_baseline' || flag === 'gemini_estimated_baseline') {
          attemptFlags.add(flag);
        }
      }
      measurements.push(measurement);
    }
    for (const u of result.unknown) {
      measurements.push(computeUnknownMeasurement(identity(), u.remainingAreaPx));
    }

    if (result.ambiguous) {
      attemptFlags.add('ambiguous_items');
      status = 'needs_review';
    }
    if (attemptFlags.has('above_baseline')) {
      // §7.2: flag above-baseline results for review; aggregates exclude them.
      status = 'needs_review';
    }
    if (measurements.length === 0) {
      // Model says the plate is not empty yet reports no food at all.
      attemptFlags.add('ambiguous_items');
      status = 'needs_review';
    }
  }

  return {
    attempt: {
      ...baseAttempt,
      baselineVersions,
      status,
      qualityFlags: [...attemptFlags],
      createdAt: now().toISOString(),
    },
    measurements,
  };
}
