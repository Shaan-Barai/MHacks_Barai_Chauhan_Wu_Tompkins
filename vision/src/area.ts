/**
 * Calibrated area (IT_4 I6, `area-calibrated-v1`). Pure, deterministic code:
 * no model calls, no I/O.
 *
 *   area_cm2 = pixels × k   (k = calibration cm²/px at the base plane)
 *
 * The food is treated as lying on the base plane (the table surface the
 * reference object was on). Pixels wasted stays the raw stored measurement;
 * the area is an estimate derived from it.
 */

import type { PhysicalEstimate } from './contracts.js';

export const AREA_METHOD = 'area-calibrated-v1' as const;

export interface AreaCalibration {
  calibrationId: string;
  /** k, cm² per pixel at the base plane. */
  cm2PerPx: number;
}

/** IT_4 I6: area_cm2 = pixels × k. */
export function computeAreaEstimate(pixels: number, calibration: AreaCalibration): PhysicalEstimate {
  return {
    calibrationId: calibration.calibrationId,
    method: AREA_METHOD,
    areaCm2: round(pixels * calibration.cm2PerPx, 4),
  };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
