/**
 * View-model types the dashboard renders. They mirror the payloads the
 * backend (Agent 5) is expected to serve from Agent 6's analytics, and reuse
 * the shared contract types wherever they overlap.
 */
import type { ApiError, Insight, MealLabel } from '../../../contracts/types'

export type { ApiError, MealLabel }

export const MEALS: MealLabel[] = ['breakfast', 'lunch', 'dinner']

/** Local date in the hall's timezone, YYYY-MM-DD. */
export type IsoDate = string

export interface MealTime {
  start: string // HH:MM
  end: string // HH:MM
}

export interface HallSettings {
  hallId: string
  name: string
  timezone: string
  mealTimes: Record<MealLabel, MealTime>
}

/** Menu item names for one local date, grouped by meal. */
export type DayMenu = Record<MealLabel, string[]>

export interface MenuApiConnection {
  url: string
  connectedAt: string
}

export interface DateRange {
  start: IsoDate
  end: IsoDate // inclusive; equal to start for a single day
}

export type Grouping = 'daily' | 'weekly' | 'monthly'

/**
 * "Waste units" = observed estimated leftover food area in pixels
 * (sum of FoodMeasurement.remainingAreaPx). Always an AI estimate.
 */
export interface PeriodWaste {
  wasteUnits: number
  /** Same-length previous period; null when there is no data to compare. */
  previousWasteUnits: number | null
}

export interface SummaryCards {
  today: PeriodWaste
  week: PeriodWaste
  month: PeriodWaste
}

export interface TrendPoint {
  /** First local date of the bucket. */
  bucketStart: IsoDate
  label: string
  /** null when no plates were analyzed in the bucket (a gap, not zero waste). */
  wasteUnits: number | null
  platesScanned: number
}

export interface ItemWaste {
  itemId: string
  displayName: string
  wasteUnits: number
  /** Percent (0–100) of this meal's menu-item waste. */
  sharePercent: number
}

export type ServiceStatus =
  | 'ok'
  | 'no_menu' // no menu uploaded for this date/meal
  | 'no_scans' // menu exists but no plates analyzed yet
  | 'upcoming' // meal hasn't happened yet

export interface ServiceDetail {
  date: IsoDate
  meal: MealLabel
  status: ServiceStatus
  wasteUnits: number
  platesScanned: number
  /** Captures whose analysis failed or needs review; excluded, never zero. */
  platesExcluded: number
  /** Leftover area Gemini could not match to a menu item (excluded from shares). */
  unknownWasteUnits: number
  attendance: { count: number; source: 'simulated' } | null
  /** Sorted most-wasted first. */
  items: ItemWaste[]
  insight: Pick<Insight, 'recommendation' | 'source' | 'generatedAt'> | null
}

/** Result wrapper so screens can render provider errors instead of throwing. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError }
