/** Range toggles: Today / This week on the dashboard, Last 30 / 90 days on Statistics. */
import { addDays, startOfWeek, todayIso } from '../lib/dates'
import type { IsoDate } from '../data/types'

export interface DateRange {
  start: IsoDate
  end: IsoDate
}

export interface RangePreset {
  label: string
  range: () => DateRange
}

export function rangeForDays(days: number): DateRange {
  const today = todayIso()
  return { start: addDays(today, -(days - 1)), end: today }
}

/** Monday to today. */
export function thisWeek(): DateRange {
  const today = todayIso()
  return { start: startOfWeek(today), end: today }
}

export const DASHBOARD_PRESETS: RangePreset[] = [
  { label: 'Today', range: () => rangeForDays(1) },
  { label: 'This week', range: thisWeek },
]

export const STATISTICS_PRESETS: RangePreset[] = [
  { label: 'Last 30 days', range: () => rangeForDays(30) },
  { label: 'Last 90 days', range: () => rangeForDays(90) },
]

export function DateRangePicker({
  value,
  onChange,
  presets = DASHBOARD_PRESETS,
}: {
  value: DateRange
  onChange: (r: DateRange) => void
  presets?: RangePreset[]
}) {
  // On a Monday "Today" and "This week" are the same range: only the first match is pressed.
  const active = presets.find((p) => {
    const r = p.range()
    return r.start === value.start && r.end === value.end
  })
  const isActive = (p: RangePreset) => p === active
  return (
    <div className="inline-flex rounded-full border border-ink p-0.5" role="group" aria-label="Days to show">
      {presets.map((p) => (
        <button
          key={p.label}
          type="button"
          aria-pressed={isActive(p)}
          onClick={() => onChange(p.range())}
          className={`rounded-full px-4 py-1.5 text-sm font-medium ${isActive(p) ? 'bg-ink text-cream' : 'bg-cream text-ink hover:opacity-70'}`}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}
