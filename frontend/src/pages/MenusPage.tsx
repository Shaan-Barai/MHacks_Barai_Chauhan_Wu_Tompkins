/** Menus: add a day's menu, and see which days still need one. */
import { useState } from 'react'
import { MonthCalendar, useMonth } from '../components/MonthCalendar'
import { MenuSource } from '../components/MenuSource'
import { getMenuDays } from '../data/api'
import type { IsoDate } from '../data/types'
import { useAsync } from '../lib/useAsync'

export function MenusPage() {
  const [pickedDay, setPickedDay] = useState<IsoDate | undefined>(undefined)
  // Remount the editor when a calendar day is picked so it opens on that date.
  const [editorKey, setEditorKey] = useState(0)
  const [savedTick, setSavedTick] = useState(0)
  const { monthStart, monthEnd, shift } = useMonth()
  const days = useAsync(() => getMenuDays(monthStart, monthEnd), [monthStart, monthEnd, savedTick])

  const pickDay = (date: IsoDate) => {
    setPickedDay(date)
    setEditorKey((k) => k + 1)
  }

  return (
    <div className="space-y-5">
      <h1 className="font-display text-3xl font-semibold text-ink">Menus</h1>
      <p className="text-base">Each day needs a menu so we know which foods were served. Click a day to add or replace its menu.</p>
      <MenuSource key={editorKey} initialDate={pickedDay} onMenuSaved={() => setSavedTick((t) => t + 1)} />
      <MonthCalendar
        monthStart={monthStart}
        onShift={shift}
        selected={pickedDay}
        onPick={pickDay}
        note={(date) => (days.data && !days.data[date] ? 'No menu' : undefined)}
        footer={days.status === 'loading' && !days.data ? 'Loading menus' : 'Days marked "No menu" still need one.'}
      />
    </div>
  )
}
