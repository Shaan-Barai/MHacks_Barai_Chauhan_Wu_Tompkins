/**
 * Menus-page calendar (UI.md): shows which days have a menu; days missing a
 * menu are highlighted in Squash. Clicking a day hands it to the editor.
 */
import { useState } from 'react'
import { getMenuDays } from '../data/api'
import type { IsoDate } from '../data/types'
import { addDays, daysInMonth, formatMonth, startOfMonth, todayIso } from '../lib/dates'
import { useAsync } from '../lib/useAsync'
import { Card, LoadingBlock } from './ui'

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function MenuCalendar({ onPickDay }: { onPickDay: (date: IsoDate) => void }) {
  const [monthStart, setMonthStart] = useState<IsoDate>(startOfMonth(todayIso()))
  const year = Number(monthStart.slice(0, 4))
  const month = Number(monthStart.slice(5, 7))
  const count = daysInMonth(year, month)
  const monthEnd = addDays(monthStart, count - 1)

  const days = useAsync(() => getMenuDays(monthStart, monthEnd), [monthStart])
  const today = todayIso()

  const firstDow = (new Date(year, month - 1, 1).getDay() + 6) % 7 // Mon=0

  const shiftMonth = (delta: number) => {
    const d = new Date(year, month - 1 + delta, 1)
    setMonthStart(startOfMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`))
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg font-semibold text-ink">{formatMonth(monthStart)}</h3>
        <div className="flex gap-2">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => shiftMonth(-1)}
            className="rounded-btn border border-linen px-3 py-1 text-base hover:bg-basil-tint"
          >
            ←
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => shiftMonth(1)}
            className="rounded-btn border border-linen px-3 py-1 text-base hover:bg-basil-tint"
          >
            →
          </button>
        </div>
      </div>

      {days.status === 'loading' && !days.data ? (
        <div className="mt-3">
          <LoadingBlock label="Loading calendar…" />
        </div>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-7 gap-1 text-center text-sm font-medium text-thyme">
            {DOW.map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {Array.from({ length: firstDow }).map((_, i) => (
              <div key={`pad-${i}`} />
            ))}
            {Array.from({ length: count }).map((_, i) => {
              const date = addDays(monthStart, i)
              const hasMenu = days.data?.[date] ?? false
              const missing = !hasMenu
              const isToday = date === today
              return (
                <button
                  key={date}
                  type="button"
                  onClick={() => onPickDay(date)}
                  aria-label={`${date}: ${hasMenu ? 'menu saved' : 'no menu yet — add one'}`}
                  className={`rounded-btn border py-2 text-base transition-colors ${
                    missing
                      ? 'border-squash bg-squash/25 font-semibold text-ink hover:bg-squash/45'
                      : 'border-linen bg-cream text-ink hover:bg-basil-tint'
                  } ${isToday ? 'ring-2 ring-basil' : ''}`}
                >
                  {i + 1}
                </button>
              )
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-sm text-thyme">
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm border border-linen bg-cream" aria-hidden="true" /> Menu saved
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm border border-squash bg-squash/40" aria-hidden="true" /> Missing a menu
              (click to add)
            </span>
          </div>
        </>
      )}
    </Card>
  )
}
