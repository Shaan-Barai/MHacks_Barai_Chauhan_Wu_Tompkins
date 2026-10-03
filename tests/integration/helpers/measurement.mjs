/**
 * AGENTS.md §7 measurement helpers used by Agent 8 fixture checks.
 * Mirror of contract rules — not the production analytics implementation.
 */

export function isFinitePositive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

export function isFiniteNonNegative(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** Compute raw fraction and display percent from areas. */
export function computeWasteParts(remainingAreaPx, baselineAreaPx) {
  if (!isFinitePositive(baselineAreaPx)) {
    return {
      rawWasteFraction: undefined,
      displayWastePercent: undefined,
      unavailableReason: baselineAreaPx === 0 ? 'baseline_invalid' : 'baseline_missing',
    };
  }
  if (!isFiniteNonNegative(remainingAreaPx)) {
    return {
      rawWasteFraction: undefined,
      displayWastePercent: undefined,
      unavailableReason: 'remaining_area_invalid',
    };
  }
  const rawWasteFraction = remainingAreaPx / baselineAreaPx;
  const displayWastePercent = 100 * Math.min(1, Math.max(0, rawWasteFraction));
  return { rawWasteFraction, displayWastePercent };
}

export function hasFlag(measurement, flag) {
  return Array.isArray(measurement.qualityFlags) && measurement.qualityFlags.includes(flag);
}

/**
 * Eligible for ordinary aggregates: known menu item, valid baseline,
 * not above_baseline, not unknown.
 */
export function isEligibleForOrdinaryAggregate(m) {
  if (m == null) return false;
  if (m.itemId == null) return false;
  if (!isFinitePositive(m.baselineAreaPx)) return false;
  if (!isFiniteNonNegative(m.remainingAreaPx)) return false;
  if (hasFlag(m, 'above_baseline')) return false;
  if (hasFlag(m, 'missing_baseline')) return false;
  if (typeof m.rawWasteFraction === 'number' && m.rawWasteFraction > 1) return false;
  return true;
}

export function findOverlappingPixelIds(regionAssignments) {
  const seen = new Map();
  const overlaps = new Set();
  for (const region of regionAssignments) {
    for (const pid of region.pixelIds) {
      if (seen.has(pid)) overlaps.add(pid);
      else seen.set(pid, region.itemId);
    }
  }
  return [...overlaps].sort();
}
