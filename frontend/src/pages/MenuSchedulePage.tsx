/**
 * Menu Schedule: (1) add a menu (typed, spreadsheet, or API) with a row
 * underneath for when breakfast, lunch, and dinner run, then (2) portions
 * forecasted for the same date.
 */
import { useState } from 'react'
import { MenuSource } from '../components/MenuSource'
import { PortionsForecast } from '../components/PortionsForecast'
import { FieldLabel } from '../components/ui'
import type { HallSettings, IsoDate } from '../data/types'
import { todayIso } from '../lib/dates'

export function MenuSchedulePage({ settings, onSettingsChange }: { settings: HallSettings; onSettingsChange: (next: HallSettings) => void }) {
  const [hallId, setHallId] = useState(settings.hallId)
  const [menuDate, setMenuDate] = useState<IsoDate>(todayIso())
  const [savedTick, setSavedTick] = useState(0)

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
        Each day needs a menu so we know which foods were served. Add the menu and when meals run, then forecast portions.
      </p>

      <MenuSource
        key={hallId}
        halls={settings.halls}
        hallId={hallId}
        date={menuDate}
        onDateChange={setMenuDate}
        onMenuSaved={() => setSavedTick((t) => t + 1)}
        settings={settings}
        onSettingsChange={onSettingsChange}
      />

      <PortionsForecast hallId={hallId} date={menuDate} menuRevision={savedTick} />
    </div>
  )
}
