/** Chart helpers: one bar per day. */
import { formatMedium, formatShort } from './dates'
import type { DailyWastePoint } from '../data/types'

export interface ChartBucket {
  key: string
  /** Short axis label. */
  label: string
  /** Full label for the tooltip. */
  tooltipLabel: string
  /** Value in the chart's unit; null = no data that day. */
  value: number | null
}

/** 'score' is the simulated waste score (data/demoMetrics.ts), carried in pixelsWasted. */
export type ChartUnit = 'grams' | 'pixels' | 'score'

/**
 * Estimated grams when every day with counted plates has them (the backend
 * may not send grams yet); otherwise Pixels wasted, the raw measurement.
 */
export function chartUnit(points: DailyWastePoint[]): ChartUnit {
  const withData = points.filter((p) => p.pixelsWasted !== null)
  return withData.length > 0 && withData.every((p) => typeof p.grams === 'number') ? 'grams' : 'pixels'
}

export function dailyBuckets(points: DailyWastePoint[], unit: ChartUnit = 'pixels'): ChartBucket[] {
  return points.map((p) => ({
    key: p.date,
    label: formatShort(p.date),
    tooltipLabel: formatMedium(p.date),
    value: unit === 'grams' ? (p.pixelsWasted === null ? null : (p.grams ?? null)) : p.pixelsWasted,
  }))
}

/** Round a max up to a clean axis number (1/2/2.5/5 × 10^n). */
export function niceCeil(value: number): number {
  if (value <= 0) return 10
  const exp = Math.floor(Math.log10(value))
  const base = Math.pow(10, exp)
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (value <= m * base) return m * base
  }
  return 10 * base
}
