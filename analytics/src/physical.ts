/**
 * ESTIMATED physical amounts (IT_4 I1, I7, I8): grams, kg CO2e and litres of
 * water for one food measurement, derived at read time from its calibrated
 * `PhysicalEstimate` and the factor row. Pure functions, no I/O.
 *
 *   area method (`area-calibrated-v1`):
 *       grams       = areaCm2 × weightGPerCm2
 *       kgCo2e      = grams / 1000 × C            (C: kg CO2e per kg)
 *       waterLitres = grams / 1000 × W × 1000 = grams × W   (W: m³ per kg)
 *
 * Legacy: estimates stored during the brief Depth Anything V2 trial carry
 * method 'volume-dav2-v1' and extra fields. Any stored estimate with a finite
 * areaCm2 ≥ 0 is read as the area method; everything else is ignored.
 *
 * Unavailable amounts are null with a reason, never 0:
 *   unknown_item (unclassified food) > no_calibration / incompatible_geometry
 *   (the capture has no usable PhysicalEstimate) > no_factor (no usable
 *   C, W or weight_g_per_cm2).
 * Pixels wasted stays the raw measurement; these are labeled estimates.
 */

import type { PhysicalEstimate, PhysicalMethod, PhysicalUnavailableReason, WasteFactor } from './contracts.js';

export const AREA_METHOD: PhysicalMethod = 'area-calibrated-v1';

/** Method string written during the removed Depth Anything V2 trial; read as area (legacy only). */
export const LEGACY_VOLUME_METHOD = 'volume-dav2-v1';

/** Capture-level reasons a measurement has no PhysicalEstimate. */
export type CapturePhysicalReason = Extract<PhysicalUnavailableReason, 'no_calibration' | 'incompatible_geometry'>;

/** The physical part of a WasteImpact. */
export interface PhysicalAmounts {
  grams: number | null;
  kgCo2e: number | null;
  waterLitres: number | null;
  /** Method actually behind `grams`; null when unavailable. */
  physicalMethod: PhysicalMethod | null;
  /** Present only when grams is null. */
  physicalUnavailableReason?: PhysicalUnavailableReason;
}

export interface PhysicalInput {
  /** The measurement's stored estimate (FoodMeasurement.physical); absent ⇒ uncalibrated. */
  physical?: PhysicalEstimate | null | undefined;
  factor: WasteFactor | null;
  /** Unclassified food: its area may be known, but it never gets grams. */
  unknownItem?: boolean | undefined;
  /** Why `physical` is absent (default 'no_calibration'). */
  captureReason?: CapturePhysicalReason | undefined;
}

const finiteNonNeg = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * A stored estimate analytics can use: area method (or the legacy volume
 * method, read as area) with a finite area ≥ 0. Anything else is treated as
 * absent (reason `no_calibration`): ingestion must validate before storing.
 */
export function usablePhysical(p: PhysicalEstimate | null | undefined): p is PhysicalEstimate {
  if (p == null) return false;
  const method: string = p.method;
  return (method === AREA_METHOD || method === LEGACY_VOLUME_METHOD) && finiteNonNeg(p.areaCm2);
}

const unavailable = (reason: PhysicalUnavailableReason): PhysicalAmounts => ({
  grams: null,
  kgCo2e: null,
  waterLitres: null,
  physicalMethod: null,
  physicalUnavailableReason: reason,
});

/** Estimated grams, kg CO2e and litres of water for one measurement (see file header). */
export function computePhysicalAmounts(input: PhysicalInput): PhysicalAmounts {
  if (input.unknownItem === true) return unavailable('unknown_item');
  const p = input.physical;
  if (!usablePhysical(p)) return unavailable(input.captureReason ?? 'no_calibration');
  const f = input.factor;
  if (f === null || !finiteNonNeg(f.weightGPerCm2) || !finiteNonNeg(f.kgCo2ePerKg) || !finiteNonNeg(f.waterM3PerKg)) {
    return unavailable('no_factor');
  }
  const grams = p.areaCm2 * f.weightGPerCm2;
  return {
    grams,
    kgCo2e: (grams / 1000) * f.kgCo2ePerKg,
    waterLitres: grams * f.waterM3PerKg,
    physicalMethod: AREA_METHOD,
  };
}

/** Per-food numbers for the plate gallery (contracts CaptureListItem.items[]). */
export interface CaptureItemPhysical extends PhysicalAmounts {
  /** Calibrated area (cm²); null when the capture has no usable estimate. */
  areaCm2: number | null;
}

/**
 * Grams / kg CO2e / litres plus the calibrated area for one gallery food row.
 * Area is a measurement, so it is shown for unknown food and foods without a
 * factor too; grams need a factor (I7).
 */
export function captureItemPhysical(input: PhysicalInput): CaptureItemPhysical {
  const amounts = computePhysicalAmounts(input);
  const p = input.physical;
  return { ...amounts, areaCm2: usablePhysical(p) ? p.areaCm2 : null };
}

// ---------------------------------------------------------------------------
// Formatting (I8): "38 g · 1.1 kg CO2e · 18 L water (est.)"
// ---------------------------------------------------------------------------

/** Two significant digits, en-US grouping: 131.69 → "130", 1234 → "1,200", 0.0456 → "0.046". */
function sig2(n: number): string {
  if (n === 0) return '0';
  return Number(n.toPrecision(2)).toLocaleString('en-US', { maximumFractionDigits: 20 });
}

/** Whole grams: "38 g", "1,234 g". */
export function formatGrams(grams: number): string {
  return `${Math.round(grams).toLocaleString('en-US')} g`;
}

/** 2 significant digits; below 0.1 kg switches to grams: "1.1 kg CO2e", "34 g CO2e". */
export function formatCo2e(kgCo2e: number): string {
  return kgCo2e >= 0.1 ? `${sig2(kgCo2e)} kg CO2e` : `${sig2(kgCo2e * 1000)} g CO2e`;
}

/** 2 significant digits: "18 L water", "0.52 L water", "1,200 L water". */
export function formatWaterLitres(litres: number): string {
  return `${sig2(litres)} L water`;
}

export interface PhysicalLabelOptions {
  /** Append " (est.)" (default true). Turn off only where the UI labels the estimate itself. */
  estimated?: boolean;
}

/**
 * Overlay-legend / food-label suffix, e.g. "38 g · 1.1 kg CO2e · 18 L water (est.)".
 * null when grams are unavailable (show nothing, never "0 g").
 */
export function formatPhysicalLabel(
  amounts: Pick<PhysicalAmounts, 'grams' | 'kgCo2e' | 'waterLitres'>,
  opts: PhysicalLabelOptions = {},
): string | null {
  if (!finiteNonNeg(amounts.grams)) return null;
  const parts = [formatGrams(amounts.grams)];
  if (finiteNonNeg(amounts.kgCo2e)) parts.push(formatCo2e(amounts.kgCo2e));
  if (finiteNonNeg(amounts.waterLitres)) parts.push(formatWaterLitres(amounts.waterLitres));
  return parts.join(' · ') + (opts.estimated === false ? '' : ' (est.)');
}
