/**
 * Forecast dashboard math (overnight Phase 4): totals and per-dish comparison
 * of our forecasts vs. the FSS forecast vs. what happened, from stored
 * forecast_outcome rows. Same definitions as forecast/model.py `evaluate`:
 *
 *  - WAPE = sum |forecast - consumed| / sum consumed, over meals that did NOT
 *    run out (a ran-out meal's true demand is unknown). Ours is scored on its
 *    demand forecast (before the prep buffer); FSS on its forecast.
 *  - A stockout is a meal where that prep amount would not have covered
 *    demand: below what was consumed, or (ran out) at or below it.
 *  - Pounds and dollars are summed only where known; unknown stays null,
 *    never zero. Simulated inputs keep `simulated: true` all the way up.
 */

export interface ForecastOutcomeInput {
  dishId: string;
  serviceDate: string;
  mealLabel: string;
  /** Our demand forecast (before the buffer); null when not stored. */
  demandLb: number | null;
  /** Our recommended prep. */
  recommendedPrepLb: number;
  fssForecastLb: number | null;
  consumedLb: number;
  /** Ran out: consumedLb is a lower bound. */
  ranOut: boolean;
  panLeftoverLb: number | null;
  leftoverCostUsd: number | null;
  trayWasteLb: number | null;
  trayWasteCostUsd: number | null;
  trayWasteSource: 'calibrated_scans' | 'simulated' | null;
  isSimulated: boolean;
}

export interface ForecastDishInfo {
  dishId: string;
  displayName: string;
  serviceStyle: string;
  isSimulated: boolean;
}

export interface ForecastComparison {
  meals: number;
  ranOutMeals: number;
  ourWape: number | null;
  fssWape: number | null;
  ourStockouts: number;
  fssStockouts: number | null;
  /** What our prep would have left in the pan (meals that did not run out). */
  ourWouldLeaveLb: number;
  panLeftoverLb: number | null;
  panLeftoverUsd: number | null;
  trayWasteLb: number | null;
  trayWasteUsd: number | null;
  trayWasteSources: string[];
  simulated: boolean;
}

export interface ForecastDishRow extends ForecastComparison {
  dishId: string;
  displayName: string;
  serviceStyle: string;
  avgRecommendedPrepLb: number;
  avgFssLb: number | null;
  avgConsumedLb: number;
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function wape(pairs: [number, number][]): number | null {
  const actual = pairs.reduce((s, [, a]) => s + a, 0);
  if (actual <= 0) return null;
  return pairs.reduce((s, [f, a]) => s + Math.abs(f - a), 0) / actual;
}

function stockout(forecast: number, consumed: number, ranOut: boolean): boolean {
  return ranOut ? forecast <= consumed + 1e-9 : forecast < consumed - 1e-9;
}

/** null when no row has the value; otherwise the sum of the known values. */
function sumKnown(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return known.length ? round(known.reduce((s, v) => s + v, 0)) : null;
}

export function compareForecasts(rows: ForecastOutcomeInput[]): ForecastComparison {
  const open = rows.filter((r) => !r.ranOut);
  const withFss = rows.filter((r) => r.fssForecastLb !== null);
  return {
    meals: rows.length,
    ranOutMeals: rows.length - open.length,
    ourWape: wape(open.map((r) => [r.demandLb ?? r.recommendedPrepLb, r.consumedLb])),
    fssWape: withFss.length ? wape(withFss.filter((r) => !r.ranOut).map((r) => [r.fssForecastLb as number, r.consumedLb])) : null,
    ourStockouts: rows.filter((r) => stockout(r.recommendedPrepLb, r.consumedLb, r.ranOut)).length,
    fssStockouts: withFss.length ? withFss.filter((r) => stockout(r.fssForecastLb as number, r.consumedLb, r.ranOut)).length : null,
    ourWouldLeaveLb: round(open.reduce((s, r) => s + Math.max(0, r.recommendedPrepLb - r.consumedLb), 0)),
    panLeftoverLb: sumKnown(rows.map((r) => r.panLeftoverLb)),
    panLeftoverUsd: sumKnown(rows.map((r) => r.leftoverCostUsd)),
    trayWasteLb: sumKnown(rows.map((r) => r.trayWasteLb)),
    trayWasteUsd: sumKnown(rows.map((r) => r.trayWasteCostUsd)),
    trayWasteSources: [...new Set(rows.map((r) => r.trayWasteSource).filter((s): s is 'calibrated_scans' | 'simulated' => s !== null))].sort(),
    simulated: rows.some((r) => r.isSimulated),
  };
}

/** Totals plus one row per dish, biggest pan leftover first. */
export function summarizeForecastOutcomes(
  rows: ForecastOutcomeInput[],
  dishes: ForecastDishInfo[],
): { totals: ForecastComparison; dishes: ForecastDishRow[] } {
  const info = new Map(dishes.map((d) => [d.dishId, d]));
  const byDish = new Map<string, ForecastOutcomeInput[]>();
  for (const r of rows) byDish.set(r.dishId, [...(byDish.get(r.dishId) ?? []), r]);
  const perDish: ForecastDishRow[] = [...byDish.entries()].map(([dishId, list]) => {
    const d = info.get(dishId);
    const fss = list.filter((r) => r.fssForecastLb !== null);
    const cmp = compareForecasts(list);
    return {
      ...cmp,
      simulated: cmp.simulated || (d?.isSimulated ?? false),
      dishId,
      displayName: d?.displayName ?? dishId,
      serviceStyle: d?.serviceStyle ?? 'other',
      avgRecommendedPrepLb: round(list.reduce((s, r) => s + r.recommendedPrepLb, 0) / list.length),
      avgFssLb: fss.length ? round(fss.reduce((s, r) => s + (r.fssForecastLb as number), 0) / fss.length) : null,
      avgConsumedLb: round(list.reduce((s, r) => s + r.consumedLb, 0) / list.length),
    };
  });
  perDish.sort((a, b) => (b.panLeftoverLb ?? 0) - (a.panLeftoverLb ?? 0) || a.displayName.localeCompare(b.displayName));
  return { totals: compareForecasts(rows), dishes: perDish };
}
