/** Chart helpers: one bar per day. */
import { formatMedium, formatShort } from './dates'
import type { DailyWastePoint } from '../data/types'

export interface ChartBucket {
  key: string
  /** Short axis label. */
  label: string
  /** Full label for the tooltip. */
  tooltipLabel: string
  /** null = no data that day. */
  pixelsWasted: number | null
}

export function dailyBuckets(points: DailyWastePoint[]): ChartBucket[] {
  return points.map((p) => ({
    key: p.date,
    label: formatShort(p.date),
    tooltipLabel: formatMedium(p.date),
    pixelsWasted: p.pixelsWasted,
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
