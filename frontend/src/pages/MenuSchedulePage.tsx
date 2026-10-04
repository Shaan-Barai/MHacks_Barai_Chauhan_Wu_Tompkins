/**
 * Menu Schedule: (1) add a menu (typed, spreadsheet, or API), (2) when
 * breakfast, lunch, and dinner run, (3) portions forecasted, then the month
 * calendar. Picking a day points the menu form and the forecast at it.
 */
import { useState } from 'react'
import { MealTimesCard } from '../components/MealTimesCard'
import { MenuSource } from '../components/MenuSource'
import { MonthCalendar, useMonth } from '../components/MonthCalendar'
import { PortionsForecast } from '../components/PortionsForecast'
import { FieldLabel } from '../components/ui'
import { getMenuDays } from '../data/api'
import type { HallSettings, IsoDate } from '../data/types'
import { todayIso } from '../lib/dates'
import { useAsync } from '../lib/useAsync'

export function MenuSchedulePage({ settings, onSettingsChange }: { settings: HallSettings; onSettingsChange: (next: HallSettings) => void }) {
  const [hallId, setHallId] = useState(settings.hallId)
  const [menuDate, setMenuDate] = useState<IsoDate>(todayIso())
  const [savedTick, setSavedTick] = useState(0)
  const { monthStart, monthEnd, shift } = useMonth(menuDate)
  const days = useAsync(() => getMenuDays(monthStart, monthEnd, hallId), [monthStart, monthEnd, hallId, savedTick])

  const note = (date: IsoDate) => {
    const events = settings.events.filter((e) => e.date === date).map((e) => e.name)
    if (events.length) return events.join(', ')
    return days.data && !days.data[date] ? 'No menu' : undefined
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
        Each day needs a menu so we know which foods were served. Add the menu, check when meals run, and forecast portions. Pick a
        day on the calendar to work on it.
      </p>

      <MenuSource
        key={hallId}
        halls={settings.halls}
        hallId={hallId}
        date={menuDate}
        onDateChange={setMenuDate}
        onMenuSaved={() => setSavedTick((t) => t + 1)}
      />

      <MealTimesCard settings={settings} onSave={onSettingsChange} />

      <PortionsForecast hallId={hallId} date={menuDate} menuRevision={savedTick} />

      <div className="max-w-xl">
        <MonthCalendar
          monthStart={monthStart}
          onShift={shift}
          selected={menuDate}
          onPick={setMenuDate}
          note={note}
          footer={days.status === 'loading' && !days.data ? 'Loading menus' : 'Days marked "No menu" still need one.'}
        />
      </div>
    </div>
  )
}
