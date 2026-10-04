/** Schedule: pick a day on the calendar to see its meals, waste, and suggestions. */
import { useState } from 'react'
import { DayDetails } from '../components/DayDetails'
import { MonthCalendar, useMonth } from '../components/MonthCalendar'
import type { HallSettings, IsoDate } from '../data/types'
import { todayIso } from '../lib/dates'

export function SchedulePage({ settings, dataRevision }: { settings: HallSettings; dataRevision: number }) {
  const [picked, setPicked] = useState<IsoDate>(todayIso())
  const { monthStart, shift } = useMonth(picked)
  const eventNote = (date: IsoDate) => {
    const names = settings.events.filter((e) => e.date === date).map((e) => e.name)
    return names.length ? names.join(', ') : undefined
  }

  return (
    <div className="space-y-5">
      <h1 className="font-display text-3xl font-semibold text-ink">Schedule</h1>
      <p className="text-base">Click a day to see what came back on plates and what to try next.</p>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,26rem)_1fr]">
        <MonthCalendar monthStart={monthStart} onShift={shift} selected={picked} onPick={setPicked} note={eventNote} />
        <DayDetails date={picked} settings={settings} dataRevision={dataRevision} />
      </div>
    </div>
  )
}
