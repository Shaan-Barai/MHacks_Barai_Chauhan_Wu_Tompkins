/**
 * Aggregate formulas from AGENTS.md §7 for Agent 8 verification.
 */

import { isEligibleForOrdinaryAggregate, isFinitePositive } from './measurement.mjs';

export function aggregateEligibleMeasurements(measurements) {
  const eligible = [];
  const excluded = [];
  for (const m of measurements) {
    if (isEligibleForOrdinaryAggregate(m)) eligible.push(m);
    else excluded.push(m);
  }

  if (eligible.length === 0) {
    return {
      eligibleMeasurementCount: 0,
      excludedMeasurementCount: excluded.length,
      observedRemainingAreaPx: null,
      sumBaselineAreaPx: null,
      overallWastePercent: null,
      unavailableReason: 'aggregate_baseline_denominator_zero',
      eligible,
      excluded,
    };
  }

  const observedRemainingAreaPx = eligible.reduce((s, m) => s + m.remainingAreaPx, 0);
  const sumBaselineAreaPx = eligible.reduce((s, m) => s + m.baselineAreaPx, 0);
  if (!isFinitePositive(sumBaselineAreaPx)) {
    return {
      eligibleMeasurementCount: eligible.length,
      excludedMeasurementCount: excluded.length,
      observedRemainingAreaPx: null,
      sumBaselineAreaPx: null,
      overallWastePercent: null,
      unavailableReason: 'aggregate_baseline_denominator_zero',
      eligible,
      excluded,
    };
  }

  return {
    eligibleMeasurementCount: eligible.length,
    excludedMeasurementCount: excluded.length,
    observedRemainingAreaPx,
    sumBaselineAreaPx,
    overallWastePercent: (100 * observedRemainingAreaPx) / sumBaselineAreaPx,
    unavailableReason: undefined,
    eligible,
    excluded,
  };
}

export function perAttendee(observedRemainingAreaPx, attendanceCount) {
  if (observedRemainingAreaPx == null) return null;
  if (!isFinitePositive(attendanceCount)) return null;
  return observedRemainingAreaPx / attendanceCount;
}

export function assertClose(actual, expected, eps = 1e-9) {
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    if (actual !== expected) {
      throw new Error(`Expected ${expected}, got ${actual}`);
    }
    return;
  }
  if (Math.abs(actual - expected) > eps) {
    throw new Error(`Expected ${expected}, got ${actual} (eps=${eps})`);
  }
}
