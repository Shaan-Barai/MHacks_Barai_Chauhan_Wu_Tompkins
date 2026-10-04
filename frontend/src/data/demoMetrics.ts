/**
 * Simulated numbers for the dashboard's summary cards and daily chart while
 * real plate scans are scarce. The last 30 days (today included) each get a
 * waste score of 100-500 and 900-1400 plates scanned; other days have none.
 *
 * Values are random but fixed per hall and date (seeded), so reloads, the
 * cards and the chart agree, and each dining hall gets its own numbers.
 * Same signatures as liveApi's getDailyWaste / getSummaryCards; api.ts
 * picks this module unless VITE_DEMO_METRICS=0.
 */
import type { DailyWastePoint, IsoDate, PeriodSummary, SummaryCards } from './types'
import { addDays, eachDay, startOfMonth, startOfWeek, todayIso } from '../lib/dates'

export const DEMO_DAYS = 30
export const WASTE_SCORE_RANGE = [100, 500] as const
export const PLATES_RANGE = [900, 1400] as const

/** FNV-1a hash of the key, then one mulberry32 step: a stable value in [0, 1). */
function seeded(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  let t = (h + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const between = (key: string, [lo, hi]: readonly [number, number]) => lo + Math.floor(seeded(key) * (hi - lo + 1))

/** One hall's simulated day, or null outside the last 30 days. */
export function demoDay(hallId: string, date: IsoDate, today: IsoDate = todayIso()): { wasteScore: number; plates: number } | null {
  if (date > today || date < addDays(today, -(DEMO_DAYS - 1))) return null
  return { wasteScore: between(`${hallId}|${date}|score`, WASTE_SCORE_RANGE), plates: between(`${hallId}|${date}|plates`, PLATES_RANGE) }
}

/** Every hall's simulated day added together, or null when none has data. */
function demoTotal(hallIds: string[], date: IsoDate, today: IsoDate) {
  const days = hallIds.map((id) => demoDay(id, date, today)).filter((d) => d !== null)
  if (days.length === 0) return null
  return { wasteScore: days.reduce((s, d) => s + d.wasteScore, 0), plates: days.reduce((s, d) => s + d.plates, 0) }
}

/** Chart points; the waste score rides in `pixelsWasted` (chart unit 'score'). */
export async function getDailyWaste(start: IsoDate, end: IsoDate, hallIds: string[] = ['hall-main']): Promise<DailyWastePoint[]> {
  const today = todayIso()
  return eachDay(start, end).map((date) => ({ date, pixelsWasted: demoTotal(hallIds, date, today)?.wasteScore ?? null }))
}

export async function getSummaryCards(hallIds: string[] = ['hall-main']): Promise<SummaryCards> {
  const today = todayIso()
  const sum = (start: IsoDate, end: IsoDate) => {
    const days = eachDay(start, end).map((d) => demoTotal(hallIds, d, today)).filter((d) => d !== null)
    return days.length === 0 ? null : { wasteScore: days.reduce((s, d) => s + d.wasteScore, 0), plates: days.reduce((s, d) => s + d.plates, 0) }
  }
  // Same windows as the backend's cards: the period so far, compared with the same number of days just before.
  const period = (start: IsoDate): PeriodSummary => {
    const length = eachDay(start, today).length
    const prevEnd = addDays(start, -1)
    const now = sum(start, today)
    return {
      start,
      end: today,
      pixelsWasted: now?.wasteScore ?? 0,
      previousPixelsWasted: sum(addDays(prevEnd, -(length - 1)), prevEnd)?.wasteScore ?? null,
      averagePlateWastePercent: null,
      platesCounted: now?.plates ?? 0,
    }
  }
  return { today: period(today), thisWeek: period(startOfWeek(today)), thisMonth: period(startOfMonth(today)) }
}
