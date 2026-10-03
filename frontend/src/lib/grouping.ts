/** Presentation-only grouping of the daily series for the chart toggle. */
import { formatMedium, formatMonth, formatShort, startOfMonth, startOfWeek } from './dates'
import type { DailyWastePoint } from '../data/types'

export type Grouping = 'daily' | 'weekly' | 'monthly'

export interface ChartBucket {
  key: string
  /** Short axis label. */
  label: string
  /** Full label for the tooltip. */
  tooltipLabel: string
  /** null = no data in the bucket. */
  pixelsWasted: number | null
}

export function groupPoints(points: DailyWastePoint[], grouping: Grouping): ChartBucket[] {
  if (grouping === 'daily') {
    return points.map((p) => ({
      key: p.date,
      label: formatShort(p.date),
      tooltipLabel: formatMedium(p.date),
      pixelsWasted: p.pixelsWasted,
    }))
  }
  const buckets = new Map<string, { label: string; tooltipLabel: string; sum: number; any: boolean }>()
  for (const p of points) {
    const key = grouping === 'weekly' ? startOfWeek(p.date) : startOfMonth(p.date)
    let b = buckets.get(key)
    if (!b) {
      b = {
        label: grouping === 'weekly' ? formatShort(key) : formatMonth(key).split(' ')[0].slice(0, 3),
        tooltipLabel: grouping === 'weekly' ? `Week of ${formatMedium(key)}` : formatMonth(key),
        sum: 0,
        any: false,
      }
      buckets.set(key, b)
    }
    if (p.pixelsWasted !== null) {
      b.sum += p.pixelsWasted
      b.any = true
    }
  }
  return [...buckets.entries()].map(([key, b]) => ({
    key,
    label: b.label,
    tooltipLabel: b.tooltipLabel,
    pixelsWasted: b.any ? b.sum : null,
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
