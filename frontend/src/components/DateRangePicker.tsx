/**
 * Top-bar date picker (UI.md): accepts a single date or a range.
 * Presets first (dataviz interaction spec), custom inputs after.
 */
import { useId } from 'react'
import { addDays, todayIso } from '../lib/dates'
import type { IsoDate } from '../data/types'

export interface DateRange {
  start: IsoDate
  end: IsoDate
}

export const DEFAULT_RANGE_DAYS = 30

export function defaultRange(): DateRange {
  const today = todayIso()
  return { start: addDays(today, -(DEFAULT_RANGE_DAYS - 1)), end: today }
}

/** A single picked day is a range whose start and end match. */
export function isSingleDay(range: DateRange): boolean {
  return range.start === range.end
}

const PRESETS: { label: string; days: number }[] = [
  { label: 'Today', days: 1 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
]

export function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const fromId = useId()
  const toId = useId()
  const today = todayIso()

  const presetDays = (days: number): DateRange => ({ start: addDays(today, -(days - 1)), end: today })
  const isActive = (days: number) => {
    const p = presetDays(days)
    return p.start === value.start && p.end === value.end
  }

  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3" role="group" aria-label="Date range for the dashboard">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            aria-pressed={isActive(p.days)}
            onClick={() => onChange(presetDays(p.days))}
            className={`rounded-btn border px-3 py-1.5 text-base transition-colors ${
              isActive(p.days)
                ? 'border-basil bg-basil font-semibold text-cream'
                : 'border-linen bg-cream text-ink hover:bg-basil-tint'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <div>
          <label htmlFor={fromId} className="mb-0.5 block text-sm font-medium text-thyme">
            From
          </label>
          <input
            id={fromId}
            type="date"
            value={value.start}
            max={value.end}
            onChange={(e) => e.target.value && onChange({ start: e.target.value, end: value.end })}
            className="rounded-btn border border-linen bg-cream px-2 py-1.5 text-base text-ink"
          />
        </div>
        <div>
          <label htmlFor={toId} className="mb-0.5 block text-sm font-medium text-thyme">
            To (same day = single date)
          </label>
          <input
            id={toId}
            type="date"
            value={value.end}
            min={value.start}
            onChange={(e) => e.target.value && onChange({ start: value.start, end: e.target.value })}
            className="rounded-btn border border-linen bg-cream px-2 py-1.5 text-base text-ink"
          />
        </div>
      </div>
    </div>
  )
}
