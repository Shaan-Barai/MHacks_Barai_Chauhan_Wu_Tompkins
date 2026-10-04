/**
 * Waste impact in pixels and relative impact points (BIG-PLAN v2 V1/V2,
 * contracts/decisions.md 2026-10-04).
 *
 * Pixels wasted is the measurement and the headline unit. There is no plate
 * calibration and there are no grams. Relative impact points are derived at
 * read time from pixels and the factor tables:
 *
 *   base            = pixels / 1000 × factor.weightGPerCm2
 *   co2Points       = base × factor.kgCo2ePerKg        (C)
 *   waterPoints     = base × factor.waterM3PerKg       (W)
 *   impactPoints    = base × factor.impactUsdPerKg     (0.19·C + 1.50·W)
 *   nutritionPoints = base × nutrition.nutrientDaysPerKg  (separate; never in impactPoints)
 *
 * Points are UNITLESS: they only compare foods with each other (beef weighs
 * more than rice for the same pixels). They are never kg, litres or dollars.
 *
 * Waste per portion (AGENTS.md §7) is sum-then-divide: Σ pixels ÷ Σ portions
 * served over the same service / menu version / item. Missing or zero
 * portions make the rate unavailable; unknown food has no rate.
 *
 * IT_4 I7: every WasteImpact also carries ESTIMATED grams / kg CO2e / litres
 * of water when the measurement has a calibrated PhysicalEstimate (see
 * physical.ts). They are null with `physicalUnavailableReason`, never 0, when
 * the capture is uncalibrated, the food is unknown, or it has no factor.
 * Points are unchanged and nutrition never enters CO2/water.
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
  PhysicalEstimate,
  PhysicalMethod,
  PhysicalUnavailableReason,
  PortionsServed,
  WasteFactor,
  WasteImpact,
} from './contracts.js';
import { validMaskCount } from './portions.js';
import { AREA_METHOD, computePhysicalAmounts, usablePhysical, type CapturePhysicalReason } from './physical.js';

/**
 * Must equal scrap-data's WASTE_FACTORS_VERSION (the factor tables it stamps).
 * Callers may override it per call when they pass a different table version.
 */
export const WASTE_FACTORS_VERSION = 'waste-factors-v5';

/** Display name for the unclassified / not-on-the-menu food bucket. */
export const UNKNOWN_FOOD_LABEL = 'Food not on the menu';

/** points = pixels / PIXELS_PER_POINT_UNIT × weight_g_per_cm2 × factor. */
export const PIXELS_PER_POINT_UNIT = 1000;

/**
 * Vision quality flag on an analysis attempt meaning food on a dish other than
 * the scanned (target) dish was dropped before counting (BIG-PLAN v2 V3,
 * counting rule `target-dish-v1`). Agreed name with workstream V; matched as a
 * string until it is added to contracts QualityFlag.
 */
export const NEIGHBOR_FOOD_EXCLUDED_FLAG = 'neighbor_food_excluded';

export interface ComputeImpactOptions {
  /** True for unclassified food: it keeps its pixels but never gets a factor. */
  unknownItem?: boolean | undefined;
  wasteFactorsVersion?: string;
  /** IT_4: the measurement's calibrated estimate (FoodMeasurement.physical). Absent ⇒ physical fields null. */
  physical?: PhysicalEstimate | null | undefined;
  /** Why `physical` is absent (default 'no_calibration'). */
  physicalUnavailableReason?: CapturePhysicalReason | undefined;
}

const finiteNonNeg = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function usableFactor(f: WasteFactor | null): f is WasteFactor {
  return f !== null && [f.weightGPerCm2, f.kgCo2ePerKg, f.waterM3PerKg, f.impactUsdPerKg].every(finiteNonNeg);
}

function usableNutrition(n: NutritionFactor | null): n is NutritionFactor {
  return n !== null && finiteNonNeg(n.nutrientDaysPerKg);
}

/**
 * Relative impact (and, when calibrated, estimated physical amounts) for one
 * set of counted pixels.
 *
 * - Unknown food: pixels only, reason `unknown_item`.
 * - No usable waste factor: pixels only, reason `no_factor`.
 * - Nutrition is optional and never affects `impactPoints`; without a
 *   nutrition row `nutritionPoints` is null.
 * - grams / kgCo2e / waterLitres / physicalMethod come from `opts.physical`
 *   (physical.ts `computePhysicalAmounts`); null + `physicalUnavailableReason`
 *   otherwise.
 *
 * Missing values are null, never 0. Throws RangeError when `pixels` is not a
 * finite nonnegative number: counts must be validated before analytics.
 */
export function computeWasteImpact(
  pixels: number,
  factor: WasteFactor | null,
  nutrition: NutritionFactor | null,
  opts: ComputeImpactOptions = {},
): WasteImpact {
  if (!finiteNonNeg(pixels)) {
    throw new RangeError(`pixels must be a finite nonnegative number (got ${String(pixels)})`);
  }
  const version = opts.wasteFactorsVersion ?? WASTE_FACTORS_VERSION;
  const physical = computePhysicalAmounts({
    physical: opts.physical,
    factor,
    unknownItem: opts.unknownItem,
    captureReason: opts.physicalUnavailableReason,
  });
  const unavailable = (reason: ImpactUnavailableReason): WasteImpact => ({
    pixels,
    co2Points: null,
    waterPoints: null,
    impactPoints: null,
    nutritionPoints: null,
    wasteFactorsVersion: version,
    unavailableReason: reason,
    ...physical,
  });
  if (opts.unknownItem === true) return unavailable('unknown_item');
  if (!usableFactor(factor)) return unavailable('no_factor');

  const base = (pixels / PIXELS_PER_POINT_UNIT) * factor.weightGPerCm2;
  return {
    pixels,
    co2Points: base * factor.kgCo2ePerKg,
    waterPoints: base * factor.waterM3PerKg,
    impactPoints: base * factor.impactUsdPerKg,
    nutritionPoints: usableNutrition(nutrition) ? base * nutrition.nutrientDaysPerKg : null,
    wasteFactorsVersion: version,
    ...physical,
  };
}

type PointKey = 'co2Points' | 'waterPoints' | 'impactPoints' | 'nutritionPoints';
const POINT_KEYS: PointKey[] = ['co2Points', 'waterPoints', 'impactPoints', 'nutritionPoints'];
type PhysicalKey = 'grams' | 'kgCo2e' | 'waterLitres';
const PHYSICAL_KEYS: PhysicalKey[] = ['grams', 'kgCo2e', 'waterLitres'];
/** Tie order for a sum's physicalUnavailableReason (capture-level reasons first). */
const PHYSICAL_REASONS: PhysicalUnavailableReason[] = ['no_calibration', 'incompatible_geometry', 'unknown_item', 'no_factor'];

/**
 * Sum several impacts.
 *
 * Rule: `pixels` sums every input. Each points field sums only the inputs
 * where it is available, and is null only when no input has it. Unavailable
 * inputs are never treated as zero: the result carries the most common
 * `unavailableReason` among inputs without impactPoints (ties: unknown_item,
 * then no_factor), and callers report how many were unavailable via
 * `impactCoverage` / dashboard coverage. So a total's points cover only the
 * pixels of foods that have a factor, while its pixels cover everything.
 * An empty list has pixels 0 and null points (nothing to score).
 *
 * Physical (IT_4): grams / kgCo2e / waterLitres sum only the calibrated
 * inputs (same rule as points). `physicalMethod` is 'area-calibrated-v1' when
 * any input has grams, null otherwise. `physicalUnavailableReason` is the most
 * common reason among inputs without grams (ties: no_calibration,
 * incompatible_geometry, unknown_item, no_factor); see `physicalImpactCoverage`.
 */
export function sumImpacts(list: readonly WasteImpact[], wasteFactorsVersion?: string): WasteImpact {
  const version = wasteFactorsVersion ?? list[0]?.wasteFactorsVersion ?? WASTE_FACTORS_VERSION;
  const out: WasteImpact = {
    pixels: 0,
    co2Points: null,
    waterPoints: null,
    impactPoints: null,
    nutritionPoints: null,
    wasteFactorsVersion: version,
    grams: null,
    kgCo2e: null,
    waterLitres: null,
    physicalMethod: null,
  };
  // Nothing to score: pixels are a true 0, but every points field stays null
  // (missing is never zero). A caller that KNOWS zero was measured (e.g.
  // analyzed clean plates) sets the zeros itself.
  if (list.length === 0) return out;
  let anyGrams = false;
  for (const impact of list) {
    out.pixels += impact.pixels;
    for (const k of POINT_KEYS) {
      const v = impact[k];
      if (v !== null) out[k] = (out[k] ?? 0) + v;
    }
    if (impact.grams != null) {
      for (const k of PHYSICAL_KEYS) {
        const v = impact[k];
        if (v != null) out[k] = (out[k] ?? 0) + v;
      }
      anyGrams = true;
    }
  }
  const missing = impactCoverage(list).unavailable;
  const reasons = (['unknown_item', 'no_factor'] as const).filter((r) => missing[r] > 0);
  const top = reasons.sort((a, b) => missing[b] - missing[a])[0];
  if (top !== undefined) out.unavailableReason = top;

  out.physicalMethod = anyGrams ? AREA_METHOD : null;
  const physMissing = physicalImpactCoverage(list).unavailable;
  const physTop = PHYSICAL_REASONS.filter((r) => physMissing[r] > 0).sort((a, b) => physMissing[b] - physMissing[a])[0];
  if (physTop !== undefined) out.physicalUnavailableReason = physTop;
  return out;
}

/** How many impacts have estimated grams, and why the rest do not (IT_4). */
export function physicalImpactCoverage(list: readonly WasteImpact[]): {
  withGrams: number;
  unavailable: Record<PhysicalUnavailableReason, number>;
} {
  const unavailable: Record<PhysicalUnavailableReason, number> = {
    no_calibration: 0,
    incompatible_geometry: 0,
    unknown_item: 0,
    no_factor: 0,
  };
  let withGrams = 0;
  for (const i of list) {
    if (i.grams != null) withGrams++;
    else {
      const r = i.physicalUnavailableReason;
      unavailable[r !== undefined && r in unavailable ? r : 'no_calibration']++;
    }
  }
  return { withGrams, unavailable };
}

/** How many impacts have impact points, and why the rest do not. */
export function impactCoverage(list: readonly WasteImpact[]): {
  withPoints: number;
  unavailable: Record<ImpactUnavailableReason, number>;
} {
  const unavailable: Record<ImpactUnavailableReason, number> = { unknown_item: 0, no_factor: 0 };
  let withPoints = 0;
  for (const i of list) {
    if (i.impactPoints !== null) withPoints++;
    else unavailable[i.unavailableReason ?? 'no_factor']++;
  }
  return { withPoints, unavailable };
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
  /** IT_4: the measurement's calibrated estimate; absent/null ⇒ uncalibrated. */
  physical?: PhysicalEstimate | null | undefined;
  /** IT_4: why `physical` is absent (default 'no_calibration'). */
  physicalUnavailableReason?: CapturePhysicalReason | undefined;
}

/** IT_4: ImpactDashboard.totals.physicalCoverage. */
export interface PhysicalCoverage {
  /** Analyzed captures measured with a compatible calibration. */
  calibratedCaptures: number;
  analyzedCaptures: number;
}

/** Factor lookups by menu display name, e.g. scrap-data's findWasteFactor / findNutritionFactor. */
export interface FactorLookups {
  findWasteFactor(displayName: string): WasteFactor | null;
  findNutritionFactor(displayName: string): NutritionFactor | null;
}

export type AttemptFlagMap = ReadonlyMap<string, readonly string[]> | Readonly<Record<string, readonly string[]>>;

export interface ImpactDashboardInput {
  window: ImpactDashboard['window'];
  measurements: readonly ImpactMeasurementInput[];
  captures: { captures: number; analyzed: number; excluded: number };
  menuItems: readonly MenuItem[];
  portions: readonly PortionsServed[];
  factors: FactorLookups;
  /**
   * eventId → quality flags of that capture's counted analysis attempt, for
   * the captures in the window. Feeds `coverage.capturesWithNeighborFoodExcluded`;
   * omitted ⇒ 0.
   */
  attemptQualityFlags?: AttemptFlagMap;
  wasteFactorsVersion?: string;
  /**
   * IT_4: calibrated capture count, normally
   * `selectImpactMeasurements(...).physicalCoverage` (which also sees
   * calibrated clean plates). Omitted ⇒ derived from the measurements:
   * distinct eventIds with a usable `physical`.
   * `analyzedCaptures` always comes from `captures.analyzed`.
   */
  physicalCoverage?: Pick<PhysicalCoverage, 'calibratedCaptures'>;
}

/** Captures whose counted attempt carries NEIGHBOR_FOOD_EXCLUDED_FLAG. */
export function countNeighborFoodExcluded(flags: AttemptFlagMap | undefined): number {
  if (flags === undefined) return 0;
  const lists = flags instanceof Map ? [...flags.values()] : Object.values(flags as Record<string, readonly string[]>);
  return lists.filter((l) => l.includes(NEIGHBOR_FOOD_EXCLUDED_FLAG)).length;
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
 * Per portion: sum-then-divide over the (serviceId, menuVersion, itemId)
 * snapshots that contributed measurements. `portionsServed` is null when any
 * of them has no (or an ambiguous) snapshot; `perPortion` is null when
 * portions are missing or any contributing snapshot is zero.
 * `perPortion.impactPoints` is null unless every measurement in the row has
 * impact points (a food without a factor has none). Likewise
 * `perPortion.grams` = Σ grams ÷ Σ portions only when EVERY measurement in the
 * row has estimated grams; a row mixing calibrated and uncalibrated captures
 * gets null, because dividing partial grams by all portions would understate
 * the rate.
 *
 * Totals (IT_4): grams / kgCo2e / waterLitres sum the calibrated measurements
 * only, with `totals.physicalCoverage` saying how many analyzed captures that
 * is. When calibrated captures exist but none has a measurement with an
 * estimate (all clean plates), the physical totals are a measured 0.
 *
 * `targets` ("Foods to target") lists named foods only, ranked by pixels per
 * portion desc; rows with no rate follow. `mostWasted` lists every row
 * (unknown food included) by total pixels desc. Ties break by name.
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
    const impact = computeWasteImpact(m.pixels, factor, nutrition, {
      unknownItem: unknown,
      wasteFactorsVersion: version,
      physical: m.physical,
      physicalUnavailableReason: m.physicalUnavailableReason,
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
        const snaps = portionIndex.get(k) ?? [];
        return snaps.length === 1 && Number.isSafeInteger(snaps[0]!.count) && snaps[0]!.count >= 0 ? snaps[0]! : null;
      });
      if (found.every((p) => p !== null)) {
        const snaps = found as PortionsServed[];
        portionsServed = snaps.reduce((s, p) => s + p.count, 0);
        const sources = new Set(snaps.map((p) => p.source));
        portionsSource = sources.has('demo') ? 'demo' : sources.has('csv') ? 'csv' : 'manual';
        if (portionsSource === 'demo') demoPortions = true;
        if (portionsServed > 0 && snaps.every((p) => p.count > 0)) {
          const pointsComplete = g.impacts.every((i) => i.impactPoints !== null);
          const gramsComplete = g.impacts.every((i) => i.grams != null);
          perPortion = {
            pixels: impact.pixels / portionsServed,
            impactPoints: pointsComplete && impact.impactPoints !== null ? impact.impactPoints / portionsServed : null,
            grams: gramsComplete && impact.grams !== null ? impact.grams / portionsServed : null,
          };
        }
      }
    }
    return {
      itemId,
      displayName: g.displayName,
      factorKey: g.factor?.factorKey ?? null,
      factorTable: g.factor ? (g.factor.table ?? 'east-quad') : null,
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
    .sort((a, b) => desc(a.perPortion?.pixels, b.perPortion?.pixels) || byName(a, b));
  const mostWasted = [...rows].sort((a, b) => b.impact.pixels - a.impact.pixels || byName(a, b));

  const named = rows.filter((r) => r.itemId !== null);
  const totalsImpact = sumImpacts(allImpacts, version);
  // Only analyzed clean plates make an empty total a measured zero; with no
  // analyzed capture the points stay null (never zero for missing).
  if (allImpacts.length === 0 && input.captures.analyzed > 0) {
    for (const k of POINT_KEYS) totalsImpact[k] = 0;
  }
  const physicalCoverage: PhysicalCoverage = {
    calibratedCaptures: (input.physicalCoverage ?? derivePhysicalCoverage(input.measurements)).calibratedCaptures,
    analyzedCaptures: input.captures.analyzed,
  };
  // Calibrated captures without any calibrated measurement are clean plates: a measured 0.
  if (
    totalsImpact.grams === null &&
    physicalCoverage.calibratedCaptures > 0 &&
    !input.measurements.some((m) => usablePhysical(m.physical))
  ) {
    for (const k of PHYSICAL_KEYS) totalsImpact[k] = 0;
    totalsImpact.physicalMethod = AREA_METHOD;
    delete totalsImpact.physicalUnavailableReason;
  }
  return {
    window: { ...input.window },
    totals: {
      ...totalsImpact,
      captures: input.captures.captures,
      analyzedCaptures: input.captures.analyzed,
      excludedCaptures: input.captures.excluded,
      physicalCoverage,
    },
    targets,
    mostWasted,
    coverage: {
      itemsWithFactor: named.filter((r) => r.factorKey !== null).length,
      itemsWithoutFactor: named.filter((r) => r.factorKey === null).length,
      itemsWithPortions: named.filter((r) => r.portionsServed !== null && r.portionsServed > 0).length,
      capturesWithNeighborFoodExcluded: countNeighborFoodExcluded(input.attemptQualityFlags),
    },
    labels: { relativeImpact: true, demoPortions },
  };
}

/** Capture counts from the measurements alone (cannot see calibrated clean plates). */
function derivePhysicalCoverage(
  measurements: readonly ImpactMeasurementInput[],
): Pick<PhysicalCoverage, 'calibratedCaptures'> {
  const calibrated = new Set<string>();
  for (const m of measurements) if (usablePhysical(m.physical)) calibrated.add(m.eventId);
  return { calibratedCaptures: calibrated.size };
}

// ---------------------------------------------------------------------------
// Eligibility helper (reuses validMaskCount)
// ---------------------------------------------------------------------------

export interface SelectImpactInput {
  services: readonly MealService[];
  captures: readonly CaptureEvent[];
  /** Measurements of the counted (latest succeeded) attempt per capture. */
  measurements: readonly FoodMeasurement[];
  /** Items of every menu version the measurements may use (e.g. current items plus resolved older ones). */
  menuItems: readonly MenuItem[];
  /**
   * eventId -> the menuVersion its counted attempt froze. A capture analyzed
   * against an earlier version of its service's menu is validated (and its
   * per-portion snapshot looked up) against THAT version, so a later menu
   * revision never silently drops or rewrites historical counts. Omitted ⇒
   * the service's current version.
   */
  attemptMenuVersions?: ReadonlyMap<string, number>;
  /**
   * IT_4: eventId -> the counted attempt's physical snapshot
   * (AnalysisAttempt.physicalMethod; null when it had no compatible
   * calibration, with the reason). Omitted for a capture ⇒ derived from its
   * measurements' `physical`.
   */
  capturePhysical?: ReadonlyMap<string, CapturePhysicalContext>;
}

/** IT_4: a counted attempt's physical snapshot (I9). */
export interface CapturePhysicalContext {
  /**
   * null = no compatible calibration at analysis time: its measurements get no
   * grams. Any non-null value (including a legacy 'volume-dav2-v1' snapshot)
   * means calibrated; grams always use the area method.
   */
  physicalMethod: PhysicalMethod | null;
  /** Why physicalMethod is null (default 'no_calibration'); e.g. 'incompatible_geometry' for a resolution mismatch. */
  unavailableReason?: CapturePhysicalReason;
}

export interface SelectedImpactMeasurements {
  measurements: ImpactMeasurementInput[];
  captures: { captures: number; analyzed: number; excluded: number };
  excludedMeasurements: number;
  /** IT_4: pass to buildImpactDashboard({ physicalCoverage }); counts calibrated clean plates too. */
  physicalCoverage: PhysicalCoverage;
}

/**
 * Picks the measurements that count toward impact, with the same rules as the
 * Pixels-wasted-per-portion benchmark (`validMaskCount`): succeeded capture,
 * one analysis attempt, validated exclusive mask for the service's menu
 * version, capture total within the image. A succeeded capture whose
 * measurements are all valid (including none: a clean plate) is analyzed;
 * every other capture is excluded and never counted as zero waste. Named
 * items must belong to the service's menu (same menuId, any version listed in
 * `menuItems`); null itemId is unknown food. Each output carries the menu
 * version the capture was analyzed against (`attemptMenuVersions`).
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
  let calibratedCaptures = 0;
  for (const capture of input.captures) {
    const current = services.get(capture.serviceId);
    if (!current || current.hallId !== capture.hallId) continue;
    const frozen = input.attemptMenuVersions?.get(capture.eventId);
    const service = frozen !== undefined && Number.isSafeInteger(frozen) && frozen >= 1 ? { ...current, menuVersion: frozen } : current;
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
    const ctx = input.capturePhysical?.get(capture.eventId);
    const uncalibrated = ctx !== undefined && ctx.physicalMethod === null;
    const calibrated = !uncalibrated && (ctx?.physicalMethod != null || valid.some((m) => usablePhysical(m.physical)));
    if (calibrated) calibratedCaptures++;
    for (const m of valid) {
      const row: ImpactMeasurementInput = {
        eventId: m.eventId,
        serviceId: service.serviceId,
        menuVersion: service.menuVersion,
        itemId: m.itemId,
        displayName: m.itemId === null ? UNKNOWN_FOOD_LABEL : names.get(m.itemId)!.displayName,
        pixels: m.maskCount!.pixelsWasted,
      };
      if (uncalibrated) row.physicalUnavailableReason = ctx.unavailableReason ?? 'no_calibration';
      else if (m.physical != null) row.physical = m.physical;
      out.push(row);
    }
  }
  return {
    measurements: out,
    captures: { captures, analyzed, excluded: captures - analyzed },
    excludedMeasurements,
    physicalCoverage: { calibratedCaptures, analyzedCaptures: analyzed },
  };
}
