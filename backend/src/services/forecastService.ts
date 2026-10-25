/**
 * Forecast dashboard read model (overnight Phase 4). Reads what the forecast
 * worker wrote (forecast, forecast_outcome, dish) and summarizes it with the
 * formulas in analytics/ (compareForecasts / summarizeForecastOutcomes).
 * Forecasting tables exist only in Supabase; other setups report unavailable.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { summarizeForecastOutcomes, type ForecastDishInfo, type ForecastOutcomeInput } from '@scrap/analytics';
import { badRequest } from '../errors.js';

export const FORECAST_MODEL = 'baseline-v1';
/** The simulator's stand-in for the existing system's forecast is never shown as plain "FSS". */
export const SIMULATED_FSS_LABEL = 'Simulated FSS (assumed +25% over-prep)';
export const REAL_FSS_LABEL = 'FSS';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface UpcomingForecast {
  serviceDate: string;
  mealLabel: string;
  dishId: string;
  displayName: string;
  recommendedPrepLb: number;
  lowLb: number | null;
  highLb: number | null;
  fssForecastLb: number | null;
  expectedDiners: number | null;
  why: string | null;
  simulated: boolean;
}

export interface ForecastSource {
  outcomes(hallId: string, start: string, end: string): Promise<ForecastOutcomeInput[]>;
  dishes(): Promise<ForecastDishInfo[]>;
  upcoming(hallId: string, from: string, to: string): Promise<Omit<UpcomingForecast, 'displayName'>[]>;
  /** True when any comparison (FSS) forecast in the range is the simulator's stand-in. */
  comparisonSimulated(hallId: string, from: string, to: string): Promise<boolean>;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export class SupabaseForecastSource implements ForecastSource {
  private readonly db: SupabaseClient;
  constructor(config: { url: string; serviceRoleKey: string; client?: SupabaseClient }) {
    this.db = config.client ?? createClient(config.url, config.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private async all<T>(build: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build(from);
      if (error) throw new Error(`Supabase forecast read failed: ${error.message}`);
      out.push(...(data ?? []));
      if ((data ?? []).length < 1000) return out;
    }
  }

  async outcomes(hallId: string, start: string, end: string): Promise<ForecastOutcomeInput[]> {
    const rows = await this.all<Record<string, unknown>>((from) =>
      this.db
        .from('forecast_outcome')
        .select('*, forecast(demand_lb)')
        .eq('hall_id', hallId)
        .eq('model_version', FORECAST_MODEL)
        .gte('service_date', start)
        .lte('service_date', end)
        .order('forecast_outcome_id')
        .range(from, from + 999),
    );
    return rows.map((r) => ({
      dishId: String(r.dish_id),
      serviceDate: String(r.service_date),
      mealLabel: String(r.meal_label),
      demandLb: num((r.forecast as { demand_lb?: unknown } | null)?.demand_lb),
      recommendedPrepLb: Number(r.recommended_prep_lb),
      fssForecastLb: num(r.fss_forecast_lb),
      consumedLb: Number(r.consumed_lb),
      ranOut: r.ran_out === true || r.consumed_is_lower_bound === true,
      panLeftoverLb: num(r.pan_leftover_lb),
      leftoverCostUsd: num(r.leftover_cost_usd),
      trayWasteLb: num(r.tray_waste_lb),
      trayWasteCostUsd: num(r.tray_waste_cost_usd),
      trayWasteSource: (r.tray_waste_source as ForecastOutcomeInput['trayWasteSource']) ?? null,
      isSimulated: r.is_simulated === true,
    }));
  }

  async dishes(): Promise<ForecastDishInfo[]> {
    const { data, error } = await this.db.from('dish').select('dish_id, display_name, service_style, is_simulated');
    if (error) throw new Error(`Supabase dish read failed: ${error.message}`);
    return (data ?? []).map((d) => ({ dishId: d.dish_id, displayName: d.display_name, serviceStyle: d.service_style, isSimulated: d.is_simulated }));
  }

  async comparisonSimulated(hallId: string, from: string, to: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('forecast')
      .select('forecast_id')
      .eq('hall_id', hallId)
      .eq('model_version', 'fss')
      .eq('is_simulated', true)
      .gte('service_date', from)
      .lte('service_date', to)
      .limit(1);
    if (error) throw new Error(`Supabase forecast read failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  async upcoming(hallId: string, from: string, to: string) {
    const rows = await this.all<Record<string, unknown>>((start) =>
      this.db
        .from('forecast')
        .select('service_date, meal_label, dish_id, recommended_prep_lb, low_lb, high_lb, fss_forecast_lb, expected_diners, why, is_simulated')
        .eq('hall_id', hallId)
        .eq('model_version', FORECAST_MODEL)
        .gte('service_date', from)
        .lte('service_date', to)
        .order('service_date')
        .order('meal_label')
        .range(start, start + 999),
    );
    return rows.map((r) => ({
      serviceDate: String(r.service_date),
      mealLabel: String(r.meal_label),
      dishId: String(r.dish_id),
      recommendedPrepLb: Number(r.recommended_prep_lb),
      lowLb: num(r.low_lb),
      highLb: num(r.high_lb),
      fssForecastLb: num(r.fss_forecast_lb),
      expectedDiners: num(r.expected_diners),
      why: (r.why as string | null) ?? null,
      simulated: r.is_simulated === true,
    }));
  }
}


const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export class ForecastService {
  constructor(private readonly source: ForecastSource | undefined) {}

  async summary(hallId: string, start: string, end: string, today: string) {
    if (!hallId) throw badRequest('MISSING_PARAMETER', "'hallId' is required.");
    if (![start, end, today].every((d) => DATE_RE.test(d)) || start > end) {
      throw badRequest('INVALID_PARAMETER', "'start', 'end' and 'today' must be YYYY-MM-DD with start <= end.");
    }
    if (!this.source) {
      return { available: false as const, hallId, window: { start, end }, model: FORECAST_MODEL };
    }
    const [outcomes, dishes, upcomingRaw, comparisonSimulated] = await Promise.all([
      this.source.outcomes(hallId, start, end),
      this.source.dishes(),
      this.source.upcoming(hallId, today, addDays(today, 6)),
      this.source.comparisonSimulated(hallId, start < today ? start : today, addDays(end > today ? end : today, 6)),
    ]);
    const names = new Map(dishes.map((d) => [d.dishId, d]));
    const { totals, dishes: perDish } = summarizeForecastOutcomes(outcomes, dishes);
    const upcoming: UpcomingForecast[] = upcomingRaw.map((u) => ({
      ...u,
      displayName: names.get(u.dishId)?.displayName ?? u.dishId,
      simulated: u.simulated || (names.get(u.dishId)?.isSimulated ?? false),
    }));
    return {
      available: true as const,
      hallId,
      window: { start, end },
      model: FORECAST_MODEL,
      /** How to name the comparison forecast everywhere it is shown. */
      comparisonLabel: comparisonSimulated ? SIMULATED_FSS_LABEL : REAL_FSS_LABEL,
      /** True whenever anything shown comes from simulated rows: the dashboard shows a banner. */
      simulated: totals.simulated || upcoming.some((u) => u.simulated) || comparisonSimulated,
      totals,
      dishes: perDish,
      upcoming,
    };
  }
}
