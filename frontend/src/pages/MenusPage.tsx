/** Menus: add a day's menu; pick a calendar day to open it in the editor. */
import { useState } from 'react'
import { MonthCalendar, useMonth } from '../components/MonthCalendar'
import { MenuSource } from '../components/MenuSource'
import type { IsoDate } from '../data/types'

export function MenusPage() {
  const [pickedDay, setPickedDay] = useState<IsoDate | undefined>(undefined)
  // Remount the editor when a calendar day is picked so it opens on that date.
  const [editorKey, setEditorKey] = useState(0)
  const { monthStart, shift } = useMonth()

  const pickDay = (date: IsoDate) => {
    setPickedDay(date)
    setEditorKey((k) => k + 1)
  }

  return (
    <div className="space-y-5">
      <h1 className="font-display text-3xl font-bold tracking-tight text-ink">Menus</h1>
      <MenuSource key={editorKey} initialDate={pickedDay} />
      <MonthCalendar monthStart={monthStart} onShift={shift} selected={pickedDay} onPick={pickDay} />
    </div>
  )
}
