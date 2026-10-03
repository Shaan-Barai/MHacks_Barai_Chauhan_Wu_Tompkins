/**
 * Frontend view types. Field names and conventions mirror contracts/types.ts
 * and the backend GET endpoints (backend/README.md): meal labels, service
 * dates (local YYYY-MM-DD), item/menu IDs, "waste units" = observed estimated
 * leftover food area (AI estimate), attendance always labeled "simulated".
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

/** Saved by first-time setup (localStorage); mirrors contract MealService hall fields. */
export interface HallSettings {
  hallId: string
  name: string
  mealTimes: Record<MealLabel, MealHours>
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
  /** Observed estimated leftover food area (AI estimate); null = no data that day. */
  wasteUnits: number | null
}

export interface ItemWaste {
  itemId: string
  displayName: string
  /** AI-estimated leftover area for this item across the meal. */
  wasteUnits: number
  /** Share of the meal's total waste, 0–100. */
  shareOfMealWastePercent: number
}

/** AI-generated tip (contract Insight), from mock data in the prototype. */
export interface MealTip {
  recommendation: string
  source: 'gemini' | 'fallback_rules'
}

/** Right-panel data per meal (GET /api/dashboard/summary per service). */
export interface MealDetail {
  serviceId: string
  date: IsoDate
  meal: MealLabel
  totalWasteUnits: number
  platesScanned: number
  /**
   * Analysis coverage (AGENTS.md §9.7): plates whose analysis counted, and
   * plates/food items left out of the totals (failed or needing review,
   * unknown food, missing or above-baseline estimates). Never counted as zero.
   */
  coverage: { platesAnalyzed: number; platesLeftOut: number; itemsLeftOut: number }
  /** Simulated attendance (contract Attendance; source is always "simulated"). */
  mealSwipes: { count: number; source: 'simulated' }
  /** Sorted by wasteUnits, descending. Empty when every estimate was left out. */
  items: ItemWaste[]
  /** Null when no item counted yet (nothing to ground a tip in). */
  tip: MealTip | null
}

export interface PeriodSummary {
  /** Inclusive local-date window the number covers. */
  start: IsoDate
  end: IsoDate
  wasteUnits: number
  /** Same-length window immediately before; null when it has no data. */
  previousWasteUnits: number | null
}

/** The three summary cards (Today / This week / This month). */
export interface SummaryCards {
  today: PeriodSummary
  thisWeek: PeriodSummary
  thisMonth: PeriodSummary
}
