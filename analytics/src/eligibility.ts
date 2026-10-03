/**
 * Measurement eligibility for ordinary aggregates (AGENTS.md §7).
 *
 * Eligible measurements contribute to area-weighted waste percentages.
 * Exclusions are counted and reported — never treated as zero waste.
 */

import type { CaptureEvent, FoodMeasurement, QualityFlag } from './contracts.js';

export type ExclusionReason =
  | 'unknown_item'
  | 'missing_baseline'
  | 'invalid_baseline'
  | 'invalid_remaining'
  | 'above_baseline'
  | 'capture_not_succeeded'
  | 'incompatible_geometry';

export interface EligibilityResult {
  eligible: boolean;
  reason?: ExclusionReason;
}

export function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

export function isFinitePositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * A measurement is eligible for ordinary aggregates when it is a known menu
 * item with a valid baseline, finite remaining area, and not above-baseline.
 */
export function classifyMeasurement(m: FoodMeasurement): EligibilityResult {
  if (m.itemId === null || m.itemId === '') {
    return { eligible: false, reason: 'unknown_item' };
  }
  if (!isFiniteNonNegative(m.remainingAreaPx)) {
    return { eligible: false, reason: 'invalid_remaining' };
  }
  if (m.baselineAreaPx === undefined) {
    return { eligible: false, reason: 'missing_baseline' };
  }
  if (!isFinitePositive(m.baselineAreaPx)) {
    return { eligible: false, reason: 'invalid_baseline' };
  }
  if (m.qualityFlags.includes('above_baseline')) {
    return { eligible: false, reason: 'above_baseline' };
  }
  // Defensive: raw fraction > 1 must be excluded even if the flag was omitted.
  if (m.rawWasteFraction !== undefined && Number.isFinite(m.rawWasteFraction) && m.rawWasteFraction > 1) {
    return { eligible: false, reason: 'above_baseline' };
  }
  return { eligible: true };
}

/** Captures that did not succeed are excluded from waste aggregates. */
export function classifyCapture(event: CaptureEvent): EligibilityResult {
  if (event.state !== 'succeeded') {
    return { eligible: false, reason: 'capture_not_succeeded' };
  }
  return { eligible: true };
}

/** Pool only measurements that share this coordinate space (AGENTS.md §7). */
export const AGGREGATE_COORDINATE_SPACE = 'topdown-normalized-v1' as const;

export function geometryCompatible(event: CaptureEvent): boolean {
  return event.geometry.coordinateSpace === AGGREGATE_COORDINATE_SPACE;
}

export function emptyExclusionCounts(): Record<ExclusionReason, number> {
  return {
    unknown_item: 0,
    missing_baseline: 0,
    invalid_baseline: 0,
    invalid_remaining: 0,
    above_baseline: 0,
    capture_not_succeeded: 0,
    incompatible_geometry: 0,
  };
}

/** Quality flags that should never appear on an eligible aggregate row. */
export const DISQUALIFYING_FLAGS: ReadonlySet<QualityFlag> = new Set([
  'above_baseline',
]);
