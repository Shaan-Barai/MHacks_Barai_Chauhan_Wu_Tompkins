/**
 * ESTIMATED pounds from plate scale (Run 3, `plate-scale-v1`). Pure functions, no I/O.
 *
 *   cm² per pixel  = (plateDiameterCm / plateDiameterPx)²        = π(D/2)² / π(d/2)²
 *   food area cm²  = Pixels wasted × cm² per pixel
 *   grams          = food area × weight_g_per_cm2               (factors CSV, per food)
 *   pounds         = grams / 453.59237
 *
 * Assumptions, returned with every estimate and shown in the UI tooltip:
 * - every scanned plate has the configured diameter (PLATE_DIAMETER_CM, default
 *   26.7 cm = a 10.5" dinner plate); plates come in several sizes, so a
 *   different plate scales the estimate by (true D / assumed D)²;
 * - the plate's pixel diameter comes from Gemini's box around a fully visible,
 *   roughly round plate (vision measurePlate), not from a measured rim;
 * - food lies flat on the plate plane (no height), and weight_g_per_cm2 is a
 *   per-food average from the factors table.
 *
 * Pixels wasted is never changed: these are labeled estimates beside it. A
 * missing plate scale, factor or a non-finite input gives null with a reason,
 * never 0.
 */

export const PLATE_SCALE_METHOD = 'plate-scale-v1' as const;
export const DEFAULT_PLATE_DIAMETER_CM = 26.7;
export const GRAMS_PER_LB = 453.59237;

export interface PlateScale {
  /** The assumed physical plate diameter (config). */
  plateDiameterCm: number;
  /** The plate's diameter in the analyzed image, in pixels. */
  plateDiameterPx: number;
}

export type PlateScaleUnavailableReason = 'no_plate_scale' | 'no_factor' | 'unknown_item' | 'invalid_input';

export interface PlateScaleEstimate {
  isEstimate: true;
  method: typeof PLATE_SCALE_METHOD;
  pixels: number;
  areaCm2: number | null;
  grams: number | null;
  lb: number | null;
  /** Present only when grams is null. */
  unavailableReason?: PlateScaleUnavailableReason;
  assumptions: {
    plateDiameterCm: number | null;
    plateDiameterPx: number | null;
    cm2PerPx: number | null;
    weightGPerCm2: number | null;
    note: string;
  };
}

export const PLATE_SCALE_NOTE =
  'Estimate: assumes every plate is the configured diameter, the plate size in pixels comes from the AI box around a fully visible plate, ' +
  'food is flat on the plate, and each food weighs its average grams per cm² from the factors table. Pixels wasted is the measurement.';

const pos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** (D_cm / d_px)², or null when either is missing or not positive. */
export function cm2PerPixel(scale: PlateScale | null | undefined): number | null {
  if (!scale || !pos(scale.plateDiameterCm) || !pos(scale.plateDiameterPx)) return null;
  return (scale.plateDiameterCm / scale.plateDiameterPx) ** 2;
}

export function plateScaleEstimate(input: {
  pixels: number;
  scale: PlateScale | null | undefined;
  weightGPerCm2: number | null | undefined;
  unknownItem?: boolean;
}): PlateScaleEstimate {
  const k = cm2PerPixel(input.scale);
  const w = pos(input.weightGPerCm2) ? input.weightGPerCm2 : null;
  const base = {
    isEstimate: true as const,
    method: PLATE_SCALE_METHOD,
    pixels: input.pixels,
    assumptions: {
      plateDiameterCm: input.scale?.plateDiameterCm ?? null,
      plateDiameterPx: input.scale?.plateDiameterPx ?? null,
      cm2PerPx: k,
      weightGPerCm2: w,
      note: PLATE_SCALE_NOTE,
    },
  };
  const none = (reason: PlateScaleUnavailableReason, areaCm2: number | null = null): PlateScaleEstimate => ({
    ...base, areaCm2, grams: null, lb: null, unavailableReason: reason,
  });
  if (!(Number.isFinite(input.pixels) && input.pixels >= 0)) return none('invalid_input');
  if (k === null) return none('no_plate_scale');
  const areaCm2 = input.pixels * k;
  if (input.unknownItem) return none('unknown_item', areaCm2);
  if (w === null) return none('no_factor', areaCm2);
  const grams = areaCm2 * w;
  return { ...base, areaCm2, grams, lb: grams / GRAMS_PER_LB };
}

/** Sum of estimates that have pounds; `covered` counts them so a partial total is never shown as complete. */
export function sumPlateScaleLb(estimates: PlateScaleEstimate[]): { lb: number | null; covered: number; total: number } {
  const ok = estimates.filter((e) => e.lb !== null);
  return { lb: ok.length ? ok.reduce((s, e) => s + (e.lb as number), 0) : null, covered: ok.length, total: estimates.length };
}

export interface PlateScaleWeightRow {
  itemId: string | null;
  displayName: string;
  /** Pixels wasted (unchanged measurement) for every eligible capture. */
  pixels: number;
  /** Pixels of captures that have a plate scale (the part the estimate covers). */
  pixelsWithScale: number;
  estimatedLb: number | null;
  estimatedGrams: number | null;
  captures: number;
  capturesWithScale: number;
  weightGPerCm2: number | null;
  /** Why estimatedLb is null, when it is. */
  unavailableReason?: PlateScaleUnavailableReason;
}

export interface PlateScaleWeights {
  isEstimate: true;
  method: typeof PLATE_SCALE_METHOD;
  note: string;
  items: PlateScaleWeightRow[];
  totals: { pixels: number; estimatedLb: number | null; captures: number; capturesWithScale: number };
}

/**
 * Per-food ESTIMATED pounds beside Pixels wasted. `measurements` are the same
 * eligible measurements the dashboard totals use; `scales` maps eventId to that
 * capture's plate scale (absent = none). Pounds cover only captures with a scale.
 */
export function plateScaleWeights(
  measurements: { eventId: string; itemId: string | null; displayName: string; pixels: number }[],
  scales: Map<string, PlateScale | null>,
  weightGPerCm2For: (displayName: string) => number | null,
): PlateScaleWeights {
  const rows = new Map<string, PlateScaleWeightRow & { events: Set<string>; scaled: Set<string> }>();
  for (const m of measurements) {
    const key = m.itemId ?? '__unknown__';
    let r = rows.get(key);
    if (!r) {
      const w = m.itemId === null ? null : weightGPerCm2For(m.displayName);
      r = { itemId: m.itemId, displayName: m.displayName, pixels: 0, pixelsWithScale: 0, estimatedLb: null, estimatedGrams: null,
            captures: 0, capturesWithScale: 0, weightGPerCm2: pos(w) ? w : null, events: new Set(), scaled: new Set() };
      rows.set(key, r);
    }
    r.pixels += m.pixels;
    r.events.add(m.eventId);
    const scale = scales.get(m.eventId) ?? null;
    const e = plateScaleEstimate({ pixels: m.pixels, scale, weightGPerCm2: r.weightGPerCm2, unknownItem: m.itemId === null });
    if (cm2PerPixel(scale) !== null) {
      r.scaled.add(m.eventId);
      r.pixelsWithScale += m.pixels;
    }
    if (e.grams !== null) r.estimatedGrams = (r.estimatedGrams ?? 0) + e.grams;
    else if (e.unavailableReason && !r.unavailableReason) r.unavailableReason = e.unavailableReason;
  }
  const items: PlateScaleWeightRow[] = [...rows.values()].map(({ events, scaled, ...r }) => {
    const out: PlateScaleWeightRow = { ...r, captures: events.size, capturesWithScale: scaled.size,
      estimatedLb: r.estimatedGrams === null ? null : r.estimatedGrams / GRAMS_PER_LB };
    if (out.estimatedGrams !== null) delete out.unavailableReason;
    return out;
  });
  items.sort((a, b) => b.pixels - a.pixels);
  const events = new Set(measurements.map((m) => m.eventId));
  const scaledEvents = [...events].filter((e) => cm2PerPixel(scales.get(e) ?? null) !== null);
  const lbs = items.map((i) => i.estimatedLb).filter((x): x is number => x !== null);
  return {
    isEstimate: true,
    method: PLATE_SCALE_METHOD,
    note: PLATE_SCALE_NOTE,
    items,
    totals: { pixels: items.reduce((s, i) => s + i.pixels, 0), estimatedLb: lbs.length ? lbs.reduce((s, x) => s + x, 0) : null,
              captures: events.size, capturesWithScale: scaledEvents.length },
  };
}
