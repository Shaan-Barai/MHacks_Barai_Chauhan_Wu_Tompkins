/**
 * Month grid on the Menu Schedule page. Each day is a button; pages decide
 * what a day says (`note`) and what happens when it is picked.
 */
import { useState } from 'react'
import type { IsoDate } from '../data/types'
import { addDays, daysInMonth, formatLong, formatMonth, startOfMonth, todayIso } from '../lib/dates'
import { Card } from './ui'

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function useMonth(initial: IsoDate = todayIso()) {
  const [monthStart, setMonthStart] = useState<IsoDate>(startOfMonth(initial))
  const year = Number(monthStart.slice(0, 4))
  const month = Number(monthStart.slice(5, 7))
  const monthEnd = addDays(monthStart, daysInMonth(year, month) - 1)
  const shift = (delta: number) => {
    const d = new Date(year, month - 1 + delta, 1)
    setMonthStart(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`)
  }
  return { monthStart, monthEnd, shift }
}

export function MonthCalendar({
  monthStart,
  onShift,
  selected,
  onPick,
  note,
  footer,
}: {
  monthStart: IsoDate
  onShift: (delta: number) => void
  selected?: IsoDate
  onPick: (date: IsoDate) => void
  /** Short text under the day number, e.g. "No menu" or an event name. */
  note?: (date: IsoDate) => string | undefined
  footer?: React.ReactNode
}) {
  const year = Number(monthStart.slice(0, 4))
  const month = Number(monthStart.slice(5, 7))
  const count = daysInMonth(year, month)
  const firstDow = (new Date(year, month - 1, 1).getDay() + 6) % 7 // Mon=0
  const today = todayIso()

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold text-ink">{formatMonth(monthStart)}</h2>
        <div className="flex gap-2">
          <button type="button" aria-label="Previous month" onClick={() => onShift(-1)} className="rounded-btn border border-ink px-3 py-1 hover:underline">
            ←
          </button>
          <button type="button" aria-label="Next month" onClick={() => onShift(1)} className="rounded-btn border border-ink px-3 py-1 hover:underline">
            →
          </button>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-sm font-semibold">
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
          const text = note?.(date)
          const isSelected = date === selected
          return (
            <button
              key={date}
              type="button"
              onClick={() => onPick(date)}
              aria-pressed={isSelected}
              aria-label={`${formatLong(date)}${date === today ? ', today' : ''}${text ? `, ${text}` : ''}`}
              className={`flex min-h-[3.5rem] flex-col items-center rounded-btn border px-1 py-1.5 text-base ${
                isSelected ? 'border-ink bg-ink text-cream' : 'border-ink bg-cream text-ink hover:underline'
              } ${date === today ? 'border-2 font-bold' : ''}`}
            >
              {i + 1}
              {text && <span className="mt-0.5 line-clamp-2 text-[11px] leading-tight">{text}</span>}
            </button>
          )
        })}
      </div>
      {footer && <div className="mt-3 text-sm">{footer}</div>}
    </Card>
  )
}
