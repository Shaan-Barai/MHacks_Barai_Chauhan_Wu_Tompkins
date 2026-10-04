/**
 * Frontend view types. Field names and conventions mirror contracts/types.ts
 * and the backend GET endpoints (backend/README.md): meal labels, service
 * dates (local YYYY-MM-DD), item/menu IDs. The primary metric is Pixels wasted
 * (contracts/measurement.md): foreground pixels counted in AI-generated
 * leftover-food masks, not grams or servings. Attendance is always labeled
 * "simulated".
 */
import type { IsoDate } from '../lib/dates'

export type { IsoDate }

export type MealLabel = 'breakfast' | 'lunch' | 'dinner'
export const MEALS: MealLabel[] = ['breakfast', 'lunch', 'dinner']
export const MEAL_NAME: Record<MealLabel, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
}

export interface MealHours {
  start: string // "07:00"
  end: string // "10:30"
}

/** Days of the week, Monday first. */
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
export const WEEKDAY_NAME: Record<Weekday, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
}

/** One set of meal times and the days it applies to, e.g. "Weekdays". */
export interface MealTimeSet {
  id: string
  name: string
  days: Weekday[]
  meals: Record<MealLabel, MealHours>
}

/** A one-off event with its own hours, e.g. a football game. */
export interface SpecialEvent {
  id: string
  name: string
  date: IsoDate
  start: string
  end: string
}

/** Saved by first-time setup and Settings (localStorage). */
export interface HallSettings {
  hallId: string
  name: string
  timeSets: MealTimeSet[]
  events: SpecialEvent[]
}

export interface MenuItemLite {
  itemId: string
  displayName: string
}

/** One day's menu across the three meals (GET /api/menus?date=…). */
export interface DayMenu {
  date: IsoDate
  menuId: string
  source: 'mock' | 'user'
  meals: Record<MealLabel, MenuItemLite[]>
}

/** One point of the main chart (dashboard summary series). */
export interface DailyWastePoint {
  date: IsoDate
  /** Pixels wasted that day (counted mask pixels); null = no counted plates. */
  pixelsWasted: number | null
}

export interface ItemWaste {
  itemId: string
  displayName: string
  /** Mask pixels counted for this item across the meal. */
  pixelsWasted: number
  /** Share of the meal's wasted pixels, 0–100 (not % of food served). */
  shareOfMealPixelsPercent: number
}

/** AI-generated tip (contract Insight), from mock data in the prototype. */
export interface MealTip {
  recommendation: string
  source: 'gemini' | 'fallback_rules'
}

/** Day-details data per meal (GET /api/dashboard/meal). */
export interface MealDetail {
  portionBenchmark?: PortionBenchmark;
  serviceId: string
  date: IsoDate
  meal: MealLabel
  /** Union of counted mask pixels across the meal's counted plates. */
  pixelsWasted: number
  /** Food pixels not attributable to a menu item (unknown food or overlapping masks). */
  unclassifiedPixels: number
  platesScanned: number
  /**
   * Coverage (AGENTS.md §9.7): plates in the total (incl. validated empty
   * plates) and plates left out (failed, partial, or still processing).
   * Left-out plates are never counted as zero.
   */
  coverage: { platesCounted: number; emptyPlates: number; platesLeftOut: number }
  /** Simulated attendance (contract Attendance; source is always "simulated"). */
  mealSwipes: { count: number; source: 'simulated' }
  /** Sorted by pixelsWasted, descending. Empty when no plate was counted. */
  items: ItemWaste[]
  /** Null when no item counted yet (nothing to ground a tip in). */
  tip: MealTip | null
}

export interface PortionBenchmarkItem {
  itemId: string
  displayName: string
  portionsServed: number | null
  portionsSource: 'manual' | 'csv' | 'demo' | null
  pixelsWasted: number | null
  pixelsWastedPerPortion: number | null
  measuredCaptures: number
  unavailableReason: string | null
}

export interface PortionBenchmark {
  hallId: string
  serviceId: string
  serviceDate: string
  menuVersion: number
  items: PortionBenchmarkItem[]
  capturedDishes: number
  measuredDishes: number
  excludedMeasurements: number
  label: 'Pixels wasted per portion'
  unit: 'pixels/portion'
  coverageNote: string
}

export interface PortionService {
  serviceId: string
  menuVersion: number
  items: MenuItemLite[]
  portions: { itemId: string; count: number; source: 'manual' | 'csv' | 'demo' }[]
}

export interface PortionEntry { itemId: string; count: number | null }

export interface PeriodSummary {
  /** Inclusive local-date window the number covers. */
  start: IsoDate
  end: IsoDate
  pixelsWasted: number
  /** Same-length window immediately before; null when it has no data. */
  previousPixelsWasted: number | null
  /** Mean percent of a full serving left per plate (clean plates 0%); null without plates. */
  averagePlateWastePercent: number | null
  platesCounted: number
}

/** One food label on a scanned plate ("Behind the scenes"). */
export interface PlateFood {
  itemId: string | null
  name: string
  /** Counted leftover pixels for this food (mask pixels, or a legacy estimate). */
  pixelsWasted: number
  /** Leftover as a percent of a full serving (capped at 100); null without a reference serving. */
  percentOfServing: number | null
  flags: string[]
}

/** One scanned plate with its photo reference and labels. */
export interface PlateRecord {
  eventId: string
  capturedAt: string
  source: string
  state: 'pending' | 'processing' | 'succeeded' | 'needs_review' | 'failed'
  imageObjectId: string
  plateWastePercent: number | null
  foods: PlateFood[]
}

/** The three summary cards (Today / This week / This month). */
export interface SummaryCards {
  today: PeriodSummary
  thisWeek: PeriodSummary
  thisMonth: PeriodSummary
}
