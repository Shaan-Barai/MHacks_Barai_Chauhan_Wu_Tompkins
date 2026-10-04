/**
 * Read-side normalization for IT_4 physical data (2026-10-04).
 *
 * Depth Anything V2 was removed. A few `scrap` rows from the brief depth trial
 * still carry method 'volume-dav2-v1', volume/height fields, flags, a
 * depthObjectId, calibration `depth`, or settings with depthEnabled /
 * plateThicknessCm. The SpacetimeDB columns stay (they cannot be dropped
 * without a wipe), so every repository read goes through these helpers:
 *
 * - Physical area comes ONLY from the snapshotted camera calibration:
 *   areaCm2 = pixels × calibration.cm2PerPx (vision computeAreaEstimate,
 *   rounded to 4 decimals), method 'area-calibrated-v1'. A stored estimate is
 *   recomputed from the measurement's pixels; the stored areaCm2 (which a
 *   volume-trial row computed from depth footprints) is never trusted.
 * - No usable calibration (missing, not succeeded, k not > 0, or a different
 *   calibrationId) ⇒ no physical estimate on that measurement.
 * - Volume/depth/height fields, flags, depthObjectId, calibration depth and
 *   the depth settings are dropped from what the API returns.
 */

import { AREA_METHOD, computeAreaEstimate } from '@scrap/vision';
import type { AnalysisAttempt, CameraCalibration, FoodMeasurement, MeasurementSettings, PhysicalEstimate } from '../types.js';

type Loose = Record<string, unknown>;

/** A calibration whose k can produce area: succeeded, finite k > 0. */
export function usableCalibration(cal: CameraCalibration | null | undefined): cal is CameraCalibration {
  return !!cal && cal.status === 'succeeded' && typeof cal.cm2PerPx === 'number' && Number.isFinite(cal.cm2PerPx) && cal.cm2PerPx > 0;
}

/** Stored physical (any legacy shape) + the measurement's pixels → contract PhysicalEstimate, or undefined. */
export function physicalFromStored(
  stored: unknown,
  pixels: unknown,
  cal: CameraCalibration | null | undefined,
): PhysicalEstimate | undefined {
  if (!stored || typeof stored !== 'object') return undefined;
  const calibrationId = (stored as Loose).calibrationId;
  if (typeof calibrationId !== 'string' || !usableCalibration(cal) || cal.calibrationId !== calibrationId) return undefined;
  if (typeof pixels !== 'number' || !Number.isInteger(pixels) || pixels < 0) return undefined;
  return computeAreaEstimate(pixels, cal);
}

/** Measurement read: physical recomputed from pixels × the snapshotted calibration's k (see the header). */
export function measurementFromStored(m: FoodMeasurement, cal: CameraCalibration | null | undefined): FoodMeasurement {
  const raw = (m as { physical?: unknown }).physical;
  if (raw === undefined) return m;
  const physical = physicalFromStored(raw, m.remainingAreaPx, cal);
  const { physical: _drop, ...rest } = m;
  return physical ? { ...rest, physical } : (rest as FoodMeasurement);
}

/** Attempt read: no depthObjectId; any stored physical method reads as the area method. */
export function attemptFromStored(a: AnalysisAttempt): AnalysisAttempt {
  const { depthObjectId: _d, ...rest } = a as AnalysisAttempt & { depthObjectId?: unknown };
  const out = rest as AnalysisAttempt;
  if (out.physicalMethod !== undefined && out.physicalMethod !== null) out.physicalMethod = AREA_METHOD;
  return out;
}

/** Calibration read: no `depth` (legacy depth-trial calibrations), and only depth-free flags. */
export function calibrationFromStored(c: CameraCalibration): CameraCalibration {
  const { depth: _d, ...rest } = c as CameraCalibration & { depth?: unknown };
  const out = rest as CameraCalibration;
  if (Array.isArray(out.flags)) {
    out.flags = out.flags.filter((f) => f === 'reference_not_found' || f === 'reference_low_confidence' || f === 'reference_touches_edge');
  }
  return out;
}

/** Settings read: {hallId, activeCalibrationId, updatedAt}; legacy depthEnabled / plateThicknessCm are ignored. */
export function settingsFromStored(s: Loose): MeasurementSettings {
  return {
    hallId: s.hallId as string,
    activeCalibrationId: typeof s.activeCalibrationId === 'string' ? s.activeCalibrationId : null,
    updatedAt: s.updatedAt as string,
  };
}
