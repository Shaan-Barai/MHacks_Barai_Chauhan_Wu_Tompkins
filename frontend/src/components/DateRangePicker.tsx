/** Dashboard lookback: today, or the last 7, 30, or 90 days. Nothing else. */
import { addDays, todayIso } from '../lib/dates'
import type { IsoDate } from '../data/types'

export interface DateRange {
  start: IsoDate
  end: IsoDate
}

export const DEFAULT_RANGE_DAYS = 30

const PRESETS: { label: string; days: number }[] = [
  { label: 'Today', days: 1 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
]

export function rangeForDays(days: number): DateRange {
  const today = todayIso()
  return { start: addDays(today, -(days - 1)), end: today }
}

export function defaultRange(): DateRange {
  return rangeForDays(DEFAULT_RANGE_DAYS)
}

export function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const isActive = (days: number) => {
    const p = rangeForDays(days)
    return p.start === value.start && p.end === value.end
  }
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Days to show">
      {PRESETS.map((p) => (
        <button
          key={p.label}
          type="button"
          aria-pressed={isActive(p.days)}
          onClick={() => onChange(rangeForDays(p.days))}
          className={`rounded-btn border border-ink px-3 py-1.5 text-base ${
            isActive(p.days) ? 'bg-ink font-semibold text-cream' : 'bg-cream text-ink hover:underline'
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}
