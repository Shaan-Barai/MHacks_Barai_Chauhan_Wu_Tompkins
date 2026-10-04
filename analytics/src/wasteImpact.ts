/**
 * Waste impact estimates (BIG-PLAN D2, D3, D5).
 *
 * Pixels wasted stays the raw stored measurement. Everything here is a
 * labeled ESTIMATE derived at read time:
 *
 *   cm²        = pixels × calibration.cm2PerPx          (per-capture plate fit)
 *   grams      = cm² × factor.weightGPerCm2
 *   kg CO2e    = kg × factor.kgCo2ePerKg                (C)
 *   water m³   = kg × factor.waterM3PerKg               (W)
 *   impact $   = kg × factor.impactUsdPerKg             (0.19·C + 1.50·W, no nutrition)
 *   nutrient-days lost = kg × nutrition.nutrientDaysPerKg   (separate; never added to impact $)
 *
 * Waste per portion (D5, AGENTS.md §7) is sum-then-divide: Σ grams ÷ Σ
 * portions served over the same service / menu version / item. Missing or
 * zero portions make the rate unavailable; unknown food has no rate.
 *
 * Pure functions only: the factor tables live in scrap-data and are passed in
 * by the caller, so this package has no dependency on them.
 */

import type {
  CaptureEvent,
  FoodMeasurement,
  ImpactDashboard,
  ImpactUnavailableReason,
  ItemImpactRow,
  MealService,
  MenuItem,
  NutritionFactor,
  PerPortion,
  PlateCalibration,
  PortionsServed,
  WasteFactor,
  WasteImpact,
} from './contracts.js';
import { validMaskCount } from './portions.js';

/**
 * Must equal scrap-data's WASTE_FACTORS_VERSION (the factor tables it stamps).
 * Callers may override it per call when they pass a different table version.
 */
export const WASTE_FACTORS_VERSION = 'waste-factors-v2';

/** Display name for the unclassified / not-on-the-menu food bucket. */
export const UNKNOWN_FOOD_LABEL = 'Food not on the menu';

export interface ComputeImpactOptions {
  /** True for unclassified food: it keeps pixels and area but never gets a factor. */
  unknownItem?: boolean;
  wasteFactorsVersion?: string;
}

function usableCalibration(c: PlateCalibration | null): c is PlateCalibration {
  return c !== null && typeof c.cm2PerPx === 'number' && Number.isFinite(c.cm2PerPx) && c.cm2PerPx > 0;
}

function usableFactor(f: WasteFactor | null): f is WasteFactor {
  return (
    f !== null &&
    [f.weightGPerCm2, f.kgCo2ePerKg, f.waterM3PerKg, f.impactUsdPerKg].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0,
    )
  );
}

function usableNutrition(n: NutritionFactor | null): n is NutritionFactor {
  return n !== null && typeof n.nutrientDaysPerKg === 'number' && Number.isFinite(n.nutrientDaysPerKg) && n.nutrientDaysPerKg >= 0;
}

/**
 * Impact estimate for one set of counted pixels.
 *
 * - Unknown food: area only (when calibrated), reason `unknown_item`.
 * - No usable calibration: no area, no grams, reason `no_calibration`.
 * - No usable waste factor: area only, reason `no_factor`.
 * - Nutrition is optional and never affects `impactUsd`; without a nutrition
 *   row `nutrientDaysLost` is null.
 *
 * Throws RangeError when `pixels` is not a finite nonnegative number: counts
 * must be validated before they reach analytics.
 */
export function computeWasteImpact(
  pixels: number,
  calibration: PlateCalibration | null,
  factor: WasteFactor | null,
  nutrition: NutritionFactor | null,
  opts: ComputeImpactOptions = {},
): WasteImpact {
  if (typeof pixels !== 'number' || !Number.isFinite(pixels) || pixels < 0) {
    throw new RangeError(`pixels must be a finite nonnegative number (got ${String(pixels)})`);
  }
  const version = opts.wasteFactorsVersion ?? WASTE_FACTORS_VERSION;
  const unavailable = (cm2: number | null, reason: ImpactUnavailableReason): WasteImpact => ({
    pixels,
    cm2,
    grams: null,
    kgCo2e: null,
    waterM3: null,
    impactUsd: null,
    nutrientDaysLost: null,
    wasteFactorsVersion: version,
    unavailableReason: reason,
  });

  const cm2 = usableCalibration(calibration) ? pixels * calibration.cm2PerPx : null;
  if (opts.unknownItem === true) return unavailable(cm2, 'unknown_item');
  if (cm2 === null) return unavailable(null, 'no_calibration');
  if (!usableFactor(factor)) return unavailable(cm2, 'no_factor');

  const grams = cm2 * factor.weightGPerCm2;
  const kg = grams / 1000;
  return {
    pixels,
    cm2,
    grams,
    kgCo2e: kg * factor.kgCo2ePerKg,
    waterM3: kg * factor.waterM3PerKg,
    impactUsd: kg * factor.impactUsdPerKg,
    nutrientDaysLost: usableNutrition(nutrition) ? kg * nutrition.nutrientDaysPerKg : null,
    wasteFactorsVersion: version,
  };
}

type NullableKey = 'cm2' | 'grams' | 'kgCo2e' | 'waterM3' | 'impactUsd' | 'nutrientDaysLost';
const NULLABLE_KEYS: NullableKey[] = ['cm2', 'grams', 'kgCo2e', 'waterM3', 'impactUsd', 'nutrientDaysLost'];

/**
 * Sum several impacts.
 *
 * Rule: `pixels` sums every input. Each estimate field (cm², grams, CO2e,
 * water, $, nutrient-days) sums only the inputs where it is available; it is
 * null only when no input has it. Unavailable inputs are never treated as
 * zero: the result carries the most common `unavailableReason` among inputs
 * without grams (ties: unknown_item, no_calibration, no_factor), and callers
 * report how many were unavailable via `impactCoverage` / dashboard coverage.
 * So a total's grams cover only the pixels that had a calibration and factor.
 * An empty list is a true zero (nothing observed).
 */
export function sumImpacts(list: readonly WasteImpact[], wasteFactorsVersion?: string): WasteImpact {
  const version = wasteFactorsVersion ?? list[0]?.wasteFactorsVersion ?? WASTE_FACTORS_VERSION;
  const out: WasteImpact = {
    pixels: 0,
    cm2: null,
    grams: null,
    kgCo2e: null,
    waterM3: null,
    impactUsd: null,
    nutrientDaysLost: null,
    wasteFactorsVersion: version,
  };
  if (list.length === 0) {
    for (const k of NULLABLE_KEYS) out[k] = 0;
    return out;
  }
  for (const impact of list) {
    out.pixels += impact.pixels;
    for (const k of NULLABLE_KEYS) {
      const v = impact[k];
      if (v !== null) out[k] = (out[k] ?? 0) + v;
    }
  }
  const missing = impactCoverage(list).unavailable;
  const reasons = (['unknown_item', 'no_calibration', 'no_factor'] as const).filter((r) => missing[r] > 0);
  const top = reasons.sort((a, b) => missing[b] - missing[a])[0];
  if (top !== undefined) out.unavailableReason = top;
  return out;
}

/** How many impacts have grams, and why the rest do not. */
export function impactCoverage(list: readonly WasteImpact[]): {
  withGrams: number;
  unavailable: Record<ImpactUnavailableReason, number>;
} {
  const unavailable: Record<ImpactUnavailableReason, number> = { unknown_item: 0, no_calibration: 0, no_factor: 0 };
  let withGrams = 0;
  for (const i of list) {
    if (i.grams !== null) withGrams++;
    else unavailable[i.unavailableReason ?? 'no_factor']++;
  }
  return { withGrams, unavailable };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** One eligible (validated) mask measurement, already joined to its menu item name. */
export interface ImpactMeasurementInput {
  eventId: string;
  serviceId: string;
  menuVersion: number;
  /** null = unclassified / not-on-the-menu food. */
  itemId: string | null;
  displayName: string;
  /** Validated mask pixel count (integer, ≥ 0). */
  pixels: number;
}

/** Factor lookups by menu display name, e.g. scrap-data's findWasteFactor / findNutritionFactor. */
export interface FactorLookups {
  findWasteFactor(displayName: string): WasteFactor | null;
  findNutritionFactor(displayName: string): NutritionFactor | null;
}

export interface ImpactDashboardInput {
  window: ImpactDashboard['window'];
  measurements: readonly ImpactMeasurementInput[];
  /** eventId → per-capture calibration; missing/null ⇒ grams unavailable for that capture. */
  calibrations: ReadonlyMap<string, PlateCalibration | null> | Readonly<Record<string, PlateCalibration | null>>;
  captures: { captures: number; analyzed: number; excluded: number };
  menuItems: readonly MenuItem[];
  portions: readonly PortionsServed[];
  factors: FactorLookups;
  wasteFactorsVersion?: string;
}

function calibrationFor(
  map: ImpactDashboardInput['calibrations'],
  eventId: string,
): PlateCalibration | null {
  if (map instanceof Map) return map.get(eventId) ?? null;
  const rec = map as Readonly<Record<string, PlateCalibration | null>>;
  return Object.prototype.hasOwnProperty.call(rec, eventId) ? (rec[eventId] ?? null) : null;
}

function calibrationEntries(map: ImpactDashboardInput['calibrations']): Array<PlateCalibration | null> {
  return map instanceof Map ? [...map.values()] : Object.values(map as Record<string, PlateCalibration | null>);
}

const portionKey = (serviceId: string, menuVersion: number, itemId: string) =>
  JSON.stringify([serviceId, menuVersion, itemId]);

/**
 * Build the contract `ImpactDashboard`.
 *
 * Rows: one per food that has eligible measurements in the window, plus one
 * unknown-food row (itemId null) when unclassified pixels exist. A food served
 * on several days (different itemIds, same name) is one row, grouped by its
 * factorKey (or its normalized display name when it has no factor); the row's
 * itemId is the latest such itemId. Foods absent from the photos get no row
 * (no inferred zero).
 *
 * Per portion (D5): sum-then-divide over the (serviceId, menuVersion, itemId)
 * snapshots that contributed measurements. `portionsServed` is null when any
 * of them has no (or an ambiguous) snapshot; `perPortion` is null when
 * portions are missing or any contributing snapshot is zero. `perPortion.grams`
 * (and `impactUsd`) are null unless every measurement in the row has grams, so
 * a rate never mixes calibrated and uncalibrated photos.
 *
 * `targets` ("Foods to target") lists named foods only, ranked by grams per
 * portion desc; rows without a gram rate follow (by pixels per portion), then
 * rows with no rate. `mostWasted` lists every row (unknown food included) by
 * total grams desc (no grams last), then pixels desc.
 */
export function buildImpactDashboard(input: ImpactDashboardInput): ImpactDashboard {
  const version = input.wasteFactorsVersion ?? WASTE_FACTORS_VERSION;
  const hallId = input.window.hallId;

  const portionIndex = new Map<string, PortionsServed[]>();
  for (const p of input.portions) {
    if (hallId !== undefined && p.hallId !== hallId) continue;
    const k = portionKey(p.serviceId, p.menuVersion, p.itemId);
    portionIndex.set(k, [...(portionIndex.get(k) ?? []), p]);
  }

  interface Group {
    itemIds: Set<string>;
    displayName: string;
    factor: WasteFactor | null;
    impacts: WasteImpact[];
    snapshots: Set<string>;
  }
  const groups = new Map<string, Group>();
  const allImpacts: WasteImpact[] = [];

  for (const m of input.measurements) {
    const unknown = m.itemId === null;
    const factor = unknown ? null : input.factors.findWasteFactor(m.displayName);
    const nutrition = unknown ? null : input.factors.findNutritionFactor(m.displayName);
    const impact = computeWasteImpact(m.pixels, calibrationFor(input.calibrations, m.eventId), factor, nutrition, {
      unknownItem: unknown,
      wasteFactorsVersion: version,
    });
    allImpacts.push(impact);

    const key = unknown ? '\u0000unknown' : factor ? `f:${factor.factorKey}` : `n:${m.displayName.trim().toLowerCase()}`;
    const g = groups.get(key) ?? {
      itemIds: new Set<string>(),
      displayName: unknown ? UNKNOWN_FOOD_LABEL : m.displayName,
      factor,
      impacts: [],
      snapshots: new Set<string>(),
    };
    g.impacts.push(impact);
    if (m.itemId !== null) {
      g.itemIds.add(m.itemId);
      g.snapshots.add(portionKey(m.serviceId, m.menuVersion, m.itemId));
    }
    groups.set(key, g);
  }

  let demoPortions = false;
  const rows: ItemImpactRow[] = [...groups.values()].map((g) => {
    const impact = sumImpacts(g.impacts, version);
    const itemId = g.itemIds.size > 0 ? [...g.itemIds].sort().at(-1)! : null;
    let portionsServed: number | null = null;
    let portionsSource: ItemImpactRow['portionsSource'] = null;
    let perPortion: PerPortion | null = null;

    if (itemId !== null && g.snapshots.size > 0) {
      const found = [...g.snapshots].map((k) => {
        const rows = portionIndex.get(k) ?? [];
        return rows.length === 1 && Number.isSafeInteger(rows[0]!.count) && rows[0]!.count >= 0 ? rows[0]! : null;
      });
      if (found.every((p) => p !== null)) {
        const snaps = found as PortionsServed[];
        portionsServed = snaps.reduce((s, p) => s + p.count, 0);
        const sources = new Set(snaps.map((p) => p.source));
        portionsSource = sources.has('demo') ? 'demo' : sources.has('csv') ? 'csv' : 'manual';
        if (portionsSource === 'demo') demoPortions = true;
        if (portionsServed > 0 && snaps.every((p) => p.count > 0)) {
          const gramsComplete = g.impacts.every((i) => i.grams !== null);
          perPortion = {
            grams: gramsComplete && impact.grams !== null ? impact.grams / portionsServed : null,
            pixels: impact.pixels / portionsServed,
            impactUsd: gramsComplete && impact.impactUsd !== null ? impact.impactUsd / portionsServed : null,
          };
        }
      }
    }
    return {
      itemId,
      displayName: g.displayName,
      factorKey: g.factor?.factorKey ?? null,
      impact,
      portionsServed,
      portionsSource,
      perPortion,
    };
  });

  const byName = (a: ItemImpactRow, b: ItemImpactRow) =>
    a.displayName.localeCompare(b.displayName) || (a.itemId ?? '').localeCompare(b.itemId ?? '');
  const desc = (a: number | null | undefined, b: number | null | undefined) => {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return b - a;
  };

  const targets = rows
    .filter((r) => r.itemId !== null)
    .sort(
      (a, b) =>
        desc(a.perPortion?.grams, b.perPortion?.grams) ||
        desc(a.perPortion?.pixels, b.perPortion?.pixels) ||
        byName(a, b),
    );
  const mostWasted = [...rows].sort(
    (a, b) => desc(a.impact.grams, b.impact.grams) || b.impact.pixels - a.impact.pixels || byName(a, b),
  );

  const named = rows.filter((r) => r.itemId !== null);
  const totalsImpact = sumImpacts(allImpacts, version);
  return {
    window: { ...input.window },
    totals: {
      ...totalsImpact,
      captures: input.captures.captures,
      analyzedCaptures: input.captures.analyzed,
      excludedCaptures: input.captures.excluded,
    },
    targets,
    mostWasted,
    coverage: {
      itemsWithFactor: named.filter((r) => r.factorKey !== null).length,
      itemsWithoutFactor: named.filter((r) => r.factorKey === null).length,
      itemsWithPortions: named.filter((r) => r.portionsServed !== null && r.portionsServed > 0).length,
      capturesWithDefaultCalibration: calibrationEntries(input.calibrations).filter(
        (c) => c !== null && (c.method === 'configured-default' || c.flags.includes('calibration_default')),
      ).length,
    },
    labels: { estimate: true, demoPortions },
  };
}

// ---------------------------------------------------------------------------
// Eligibility helper (reuses validMaskCount)
// ---------------------------------------------------------------------------

export interface SelectImpactInput {
  services: readonly MealService[];
  captures: readonly CaptureEvent[];
  /** Measurements of the counted (latest succeeded) attempt per capture. */
  measurements: readonly FoodMeasurement[];
  menuItems: readonly MenuItem[];
}

export interface SelectedImpactMeasurements {
  measurements: ImpactMeasurementInput[];
  captures: { captures: number; analyzed: number; excluded: number };
  excludedMeasurements: number;
}

/**
 * Picks the measurements that count toward impact, with the same rules as the
 * Pixels-wasted-per-portion benchmark (`validMaskCount`): succeeded capture,
 * one analysis attempt, validated exclusive mask for the service's menu
 * version, capture total within the image. A succeeded capture whose
 * measurements are all valid (including none: a clean plate) is analyzed;
 * every other capture is excluded and never counted as zero waste. Named
 * items must belong to the service's menu; null itemId is unknown food.
 */
export function selectImpactMeasurements(input: SelectImpactInput): SelectedImpactMeasurements {
  const services = new Map(input.services.map((s) => [s.serviceId, s]));
  const names = new Map(input.menuItems.map((i) => [i.itemId, i]));
  const byEvent = new Map<string, FoodMeasurement[]>();
  const seen = new Set<string>();
  for (const m of input.measurements) {
    if (seen.has(m.measurementId)) continue;
    seen.add(m.measurementId);
    byEvent.set(m.eventId, [...(byEvent.get(m.eventId) ?? []), m]);
  }

  const out: ImpactMeasurementInput[] = [];
  let captures = 0;
  let analyzed = 0;
  let excludedMeasurements = 0;
  for (const capture of input.captures) {
    const service = services.get(capture.serviceId);
    if (!service || service.hallId !== capture.hallId) continue;
    captures++;
    const rows = byEvent.get(capture.eventId) ?? [];
    if (capture.state !== 'succeeded' || new Set(rows.map((m) => m.attemptId)).size > 1) {
      excludedMeasurements += rows.length;
      continue;
    }
    const valid = rows.filter(
      (m) =>
        validMaskCount(m, capture, service) &&
        (m.itemId === null || names.get(m.itemId)?.menuId === service.menuId),
    );
    const total = valid.reduce((s, m) => s + m.maskCount!.pixelsWasted, 0);
    if (total > capture.geometry.widthPx * capture.geometry.heightPx || (rows.length > 0 && valid.length === 0)) {
      excludedMeasurements += rows.length;
      continue;
    }
    analyzed++;
    excludedMeasurements += rows.length - valid.length;
    for (const m of valid) {
      out.push({
        eventId: m.eventId,
        serviceId: service.serviceId,
        menuVersion: service.menuVersion,
        itemId: m.itemId,
        displayName: m.itemId === null ? UNKNOWN_FOOD_LABEL : names.get(m.itemId)!.displayName,
        pixels: m.maskCount!.pixelsWasted,
      });
    }
  }
  return { measurements: out, captures: { captures, analyzed, excluded: captures - analyzed }, excludedMeasurements };
}
