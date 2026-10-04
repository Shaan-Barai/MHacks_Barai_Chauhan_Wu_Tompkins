/**
 * Menu Schedule: add a menu (typed, spreadsheet, or API) at the top, then the
 * month calendar below it. Picking a day shows that day's meals, waste, and
 * suggestions, and points the menu form at that date.
 */
import { useState } from 'react'
import { DayDetails } from '../components/DayDetails'
import { MenuSource } from '../components/MenuSource'
import { MonthCalendar, useMonth } from '../components/MonthCalendar'
import { FieldLabel } from '../components/ui'
import { getMenuDays } from '../data/api'
import type { HallSettings, IsoDate } from '../data/types'
import { todayIso } from '../lib/dates'
import { useAsync } from '../lib/useAsync'

export function MenuSchedulePage({ settings, dataRevision }: { settings: HallSettings; dataRevision: number }) {
  const [hallId, setHallId] = useState(settings.hallId)
  const [picked, setPicked] = useState<IsoDate>(todayIso())
  const [menuDate, setMenuDate] = useState<IsoDate>(todayIso())
  const [savedTick, setSavedTick] = useState(0)
  const { monthStart, monthEnd, shift } = useMonth(picked)
  const days = useAsync(() => getMenuDays(monthStart, monthEnd, hallId), [monthStart, monthEnd, hallId, savedTick])

  const note = (date: IsoDate) => {
    const events = settings.events.filter((e) => e.date === date).map((e) => e.name)
    if (events.length) return events.join(', ')
    return days.data && !days.data[date] ? 'No menu' : undefined
  }
  const pickDay = (date: IsoDate) => {
    setPicked(date)
    setMenuDate(date)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-display text-3xl font-semibold text-ink">Menu Schedule</h1>
        {settings.halls.length > 1 && (
          <div>
            <FieldLabel htmlFor="schedule-hall">Dining hall</FieldLabel>
            <select
              id="schedule-hall"
              value={hallId}
              onChange={(e) => setHallId(e.target.value)}
              className="rounded-btn border border-ink bg-cream px-3 py-2 text-base text-ink"
            >
              {settings.halls.map((h) => (
                <option key={h.hallId} value={h.hallId}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <p className="text-base">
        Each day needs a menu so we know which foods were served. Add one below, then pick a day on the calendar to see what came
        back on plates and what to try next.
      </p>

      <MenuSource
        key={hallId}
        halls={settings.halls}
        hallId={hallId}
        date={menuDate}
        onDateChange={setMenuDate}
        onMenuSaved={() => setSavedTick((t) => t + 1)}
      />

      <h2 className="font-display text-2xl font-semibold text-ink">Schedule</h2>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,26rem)_1fr]">
        <MonthCalendar
          monthStart={monthStart}
          onShift={shift}
          selected={picked}
          onPick={pickDay}
          note={note}
          footer={days.status === 'loading' && !days.data ? 'Loading menus' : 'Days marked "No menu" still need one.'}
        />
        <DayDetails date={picked} settings={settings} hallId={hallId} dataRevision={dataRevision + savedTick} />
      </div>
    </div>
  )
}
