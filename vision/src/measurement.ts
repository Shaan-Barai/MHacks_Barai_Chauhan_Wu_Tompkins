/**
 * Pixel-area waste measurement math — AGENTS.md §7 is canonical.
 *
 *   raw_waste_fraction   = remainingAreaPx / baselineAreaPx   (baseline finite, > 0)
 *   display_waste_percent = 100 * clamp(raw_waste_fraction, 0, 1)
 *
 * - Missing/invalid baseline => no percentage + unavailableReason +
 *   'missing_baseline' flag. Never a guessed zero.
 * - fraction > 1 => keep the raw value, clamp the display value, and flag
 *   'above_baseline' so aggregates exclude it until reviewed.
 * - Every measurement is method 'gemini_area_estimate' and carries 'ai_estimate'.
 * - A baseline estimated by Gemini (source 'gemini_estimate' or an in-response
 *   estimate) additionally carries 'gemini_estimated_baseline'.
 */

import type { FoodMeasurement, QualityFlag, ReferencePortion } from './contracts.js';

export const MEASUREMENT_METHOD = 'gemini_area_estimate' as const;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface BaselineInput {
  /** Omitted for Gemini in-response estimates (no stored reference exists). */
  baselineId?: string;
  areaPx: number;
  /** True when the baseline came from Gemini rather than a reference record. */
  geminiEstimated: boolean;
}

export function baselineFromReference(ref: ReferencePortion): BaselineInput {
  return {
    baselineId: ref.baselineId,
    areaPx: ref.expectedAreaPx,
    geminiEstimated: ref.source === 'gemini_estimate',
  };
}

export interface MeasurementIdentity {
  measurementId: string;
  eventId: string;
  attemptId: string;
}

/**
 * Build one contract-valid FoodMeasurement for a classified menu item.
 * `remainingAreaPx` must already be validated finite and >= 0.
 */
export function computeMeasurement(
  identity: MeasurementIdentity,
  itemId: string,
  remainingAreaPx: number,
  baseline: BaselineInput | undefined,
  extraFlags: QualityFlag[] = [],
): FoodMeasurement {
  const flags = new Set<QualityFlag>(['ai_estimate', ...extraFlags]);

  const base: FoodMeasurement = {
    ...identity,
    itemId,
    remainingAreaPx,
    method: MEASUREMENT_METHOD,
    qualityFlags: [], // replaced below once flags are final
  };

  if (baseline === undefined || !Number.isFinite(baseline.areaPx) || baseline.areaPx <= 0) {
    // §7.1: denominator must be finite and > 0; otherwise no percentage, with a reason.
    flags.add('missing_baseline');
    return {
      ...base,
      unavailableReason:
        baseline === undefined ? 'missing_baseline' : 'invalid_baseline',
      qualityFlags: [...flags],
    };
  }

  if (baseline.geminiEstimated) flags.add('gemini_estimated_baseline');

  const rawWasteFraction = remainingAreaPx / baseline.areaPx;
  if (rawWasteFraction > 1) flags.add('above_baseline'); // §7.2: flag, exclude from ordinary aggregates
  const displayWastePercent = 100 * clamp(rawWasteFraction, 0, 1);

  return {
    ...base,
    ...(baseline.baselineId !== undefined ? { baselineId: baseline.baselineId } : {}),
    baselineAreaPx: baseline.areaPx,
    rawWasteFraction,
    displayWastePercent,
    qualityFlags: [...flags],
  };
}

/**
 * Measurement for food that matches no menu item (§6: keeps its area estimate
 * but is excluded from menu percentages until identified).
 */
export function computeUnknownMeasurement(
  identity: MeasurementIdentity,
  remainingAreaPx: number,
): FoodMeasurement {
  return {
    ...identity,
    itemId: null,
    remainingAreaPx,
    unavailableReason: 'unknown_item',
    method: MEASUREMENT_METHOD,
    qualityFlags: ['ai_estimate'],
  };
}
