/**
 * Per-plate waste percent for the dashboard cards (user request 2026-10-03).
 *
 * plate_percent = 100 * sum(min(remaining, baseline)) / sum(baseline)
 *   over the plate's known menu items with a valid baseline.
 * average_plate_percent = mean(plate_percent) over plates that have one.
 *
 * - A succeeded plate with no food measurements is a clean plate: 0%.
 * - An item measured above its full serving counts as fully wasted (100%),
 *   not as more than the serving.
 * - Unknown foods have no baseline and do not enter the percent.
 * - Failed/pending plates, incompatible geometry, and plates with no usable
 *   item are unavailable, never 0%.
 *
 * This is an auxiliary AI-estimated percent of visible area relative to a
 * reference serving, not physical mass. It never gates Pixels wasted.
 */

import type { CaptureEvent, FoodMeasurement } from './contracts.js';
import { classifyCapture, geometryCompatible, isFiniteNonNegative, isFinitePositive } from './eligibility.js';

/** null = this plate has no usable percent. */
export function plateWastePercent(capture: CaptureEvent, measurements: FoodMeasurement[]): number | null {
  if (!classifyCapture(capture).eligible || !geometryCompatible(capture)) return null;
  const own = measurements.filter((m) => m.eventId === capture.eventId);
  if (own.length === 0) return 0;
  let remaining = 0;
  let baseline = 0;
  for (const m of own) {
    if (m.itemId === null || m.itemId === '') continue;
    if (!isFiniteNonNegative(m.remainingAreaPx) || !isFinitePositive(m.baselineAreaPx)) continue;
    remaining += Math.min(m.remainingAreaPx, m.baselineAreaPx);
    baseline += m.baselineAreaPx;
  }
  if (baseline === 0) return null;
  return (100 * remaining) / baseline;
}

export interface PlateWasteAverage {
  /** Mean plate percent, one decimal; null when no plate has one. */
  averagePlateWastePercent: number | null;
  /** Plates included in the average. */
  platesCounted: number;
  /** Scanned plates without a usable percent (not counted as 0%). */
  platesWithoutPercent: number;
}

export function averagePlateWaste(percents: (number | null)[]): PlateWasteAverage {
  const counted = percents.filter((p): p is number => p !== null);
  const average = counted.length === 0 ? null : counted.reduce((a, b) => a + b, 0) / counted.length;
  return {
    averagePlateWastePercent: average === null ? null : Math.round(average * 10) / 10,
    platesCounted: counted.length,
    platesWithoutPercent: percents.length - counted.length,
  };
}
