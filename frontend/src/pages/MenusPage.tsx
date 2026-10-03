/** Menus page (UI.md): the same two menu options as setup + the calendar. */
import { useState } from 'react'
import { MenuCalendar } from '../components/MenuCalendar'
import { MenuSource } from '../components/MenuSource'
import type { IsoDate } from '../data/types'

export function MenusPage() {
  const [pickedDay, setPickedDay] = useState<IsoDate | undefined>(undefined)
  // Remount the editor when a calendar day is picked so it opens on that date.
  const [editorKey, setEditorKey] = useState(0)
  const [savedTick, setSavedTick] = useState(0)

  const pickDay = (date: IsoDate) => {
    setPickedDay(date)
    setEditorKey((k) => k + 1)
  }

  return (
    <div className="space-y-5">
      <h1 className="font-display text-3xl font-semibold text-ink">Menus</h1>
      <p className="text-base text-thyme">
        Keep a menu saved for every day so waste can be matched to the right items. Days missing a menu are highlighted
        below — click one to add it.
      </p>
      <MenuSource key={editorKey} initialDate={pickedDay} onMenuSaved={() => setSavedTick((t) => t + 1)} />
      <MenuCalendar key={`cal-${savedTick}`} onPickDay={pickDay} />
    </div>
  )
}
