/**
 * Range toggles. Every page opens on the last 30 days; the last 7 days is one
 * click away. Today on the dashboard and plates, 90 days on Statistics and Admin.
 */
import { addDays, todayIso } from '../lib/dates'
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

/** Where every page's range picker starts. */
export const defaultRange = (): DateRange => rangeForDays(30)

const TODAY: RangePreset = { label: 'Today', range: () => rangeForDays(1) }
const LAST_7: RangePreset = { label: 'Last 7 days', range: () => rangeForDays(7) }
const LAST_30: RangePreset = { label: 'Last 30 days', range: defaultRange }
const LAST_90: RangePreset = { label: 'Last 90 days', range: () => rangeForDays(90) }

export const DASHBOARD_PRESETS: RangePreset[] = [TODAY, LAST_7, LAST_30]

export const STATISTICS_PRESETS: RangePreset[] = [LAST_7, LAST_30, LAST_90]

export function DateRangePicker({
  value,
  onChange,
  presets = DASHBOARD_PRESETS,
}: {
  value: DateRange
  onChange: (r: DateRange) => void
  presets?: RangePreset[]
}) {
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
