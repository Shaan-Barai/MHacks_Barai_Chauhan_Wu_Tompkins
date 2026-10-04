/**
 * Menu Schedule: add menus at the top (typed, spreadsheet, or API), then a
 * calendar that marks days with no menu and special events. Clicking a day
 * shows its meals, waste, and suggestions; "Add or replace this day's menu"
 * loads that day into the form above.
 */
import { useRef, useState } from 'react'
import { DayDetails } from '../components/DayDetails'
import { MenuSource } from '../components/MenuSource'
import { MonthCalendar, useMonth } from '../components/MonthCalendar'
import { GhostButton } from '../components/ui'
import { getMenuDays } from '../data/api'
import type { HallSettings, IsoDate } from '../data/types'
import { todayIso } from '../lib/dates'
import { useAsync } from '../lib/useAsync'

export function MenuSchedulePage({ settings, dataRevision }: { settings: HallSettings; dataRevision: number }) {
  const [picked, setPicked] = useState<IsoDate>(todayIso())
  const [editorDate, setEditorDate] = useState<IsoDate | undefined>(undefined)
  // Remount the form when a day is loaded into it so it opens on that date.
  const [editorKey, setEditorKey] = useState(0)
  const [savedTick, setSavedTick] = useState(0)
  const editorRef = useRef<HTMLElement>(null)
  const { monthStart, monthEnd, shift } = useMonth(picked)
  const days = useAsync(() => getMenuDays(monthStart, monthEnd), [monthStart, monthEnd, savedTick])

  const note = (date: IsoDate) => {
    const notes = settings.events.filter((e) => e.date === date).map((e) => e.name)
    if (days.data && !days.data[date]) notes.unshift('No menu')
    return notes.length ? notes.join(', ') : undefined
  }

  const editPicked = () => {
    setEditorDate(picked)
    setEditorKey((k) => k + 1)
    editorRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="space-y-5">
      <h1 className="font-display text-3xl font-semibold text-ink">Menu Schedule</h1>

      <section ref={editorRef} aria-label="Add a menu" className="scroll-mt-4 space-y-2">
        <p className="text-base">Each day needs a menu so we know which foods were served.</p>
        <MenuSource
          key={editorKey}
          initialDate={editorDate}
          onMenuSaved={() => setSavedTick((t) => t + 1)}
          locations={settings.locations}
        />
      </section>

      <section aria-label="Schedule" className="space-y-2">
        <h2 className="font-display text-2xl font-semibold text-ink">Schedule</h2>
        <p className="text-base">Click a day to see what came back on plates and what to try next.</p>
        <div className="grid gap-5 xl:grid-cols-[minmax(0,26rem)_1fr]">
          <MonthCalendar
            monthStart={monthStart}
            onShift={shift}
            selected={picked}
            onPick={setPicked}
            note={note}
            footer={days.status === 'loading' && !days.data ? 'Loading menus' : 'Days marked "No menu" still need one.'}
          />
          <div className="space-y-3">
            <GhostButton type="button" onClick={editPicked}>
              Add or replace this day's menu
            </GhostButton>
            <DayDetails date={picked} settings={settings} dataRevision={dataRevision + savedTick} />
          </div>
        </div>
      </section>
    </div>
  )
}
