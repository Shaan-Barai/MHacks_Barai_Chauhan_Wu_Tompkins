/** Chart helpers: one point per day. */
import { formatMedium, formatShort } from './dates'
import type { DailyImpactPoint, DailyWastePoint } from '../data/types'

export interface ChartBucket {
  key: string
  /** Short axis label. */
  label: string
  /** Full label for the tooltip. */
  tooltipLabel: string
  /** The day's value (kg CO2e or pixels); null = no data that day. */
  value: number | null
}

/** One point per day of Pixels wasted (the chart is pixels only, BIG-PLAN v2). */
export function dailyBuckets(points: DailyWastePoint[]): ChartBucket[] {
  return points.map((p) => ({
    key: p.date,
    label: formatShort(p.date),
    tooltipLabel: formatMedium(p.date),
    value: p.pixelsWasted,
  }))
}

/** One point per day of estimated kg CO2e. */
export function carbonBuckets(points: DailyImpactPoint[]): ChartBucket[] {
  return points.map((p) => ({
    key: p.date,
    label: formatShort(p.date),
    tooltipLabel: formatMedium(p.date),
    value: p.kgCo2e,
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
