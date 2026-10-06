/**
 * Menus: add a day's menu; pick a calendar day to open it in the editor.
 * The read-only site has no editor: picking a day shows its saved menu.
 */
import { useState } from 'react'
import { MonthCalendar, useMonth } from '../components/MonthCalendar'
import { MenuSource } from '../components/MenuSource'
import { Card, EmptyState, LoadingBlock } from '../components/ui'
import { getMenu } from '../data/api'
import type { IsoDate } from '../data/types'
import { MEALS, MEAL_NAME } from '../data/types'
import { formatLong, todayIso } from '../lib/dates'
import { useAsync } from '../lib/useAsync'
import { useAuth } from '../state/auth'

export function MenusPage() {
  const { readOnly } = useAuth()
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
      {readOnly ? <SavedMenu date={pickedDay ?? todayIso()} /> : <MenuSource key={editorKey} initialDate={pickedDay} />}
      <MonthCalendar monthStart={monthStart} onShift={shift} selected={pickedDay} onPick={pickDay} />
    </div>
  )
}

/** One day's saved menu, as text. */
function SavedMenu({ date }: { date: IsoDate }) {
  const menu = useAsync(() => getMenu(date), [date])
  if (menu.status === 'loading') return <LoadingBlock label="Loading the menu" />
  if (menu.status === 'error') return <EmptyState title="Couldn't load the menu." />
  if (!menu.data) return <EmptyState title={`No menu for ${formatLong(date)}.`} />
  const meals = menu.data.meals
  return (
    <Card>
      <h2 className="text-lg font-semibold text-ink">Menu for {formatLong(date)}</h2>
      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
        {MEALS.map((meal) => (
          <div key={meal}>
            <h3 className="text-base font-semibold text-ink">{MEAL_NAME[meal]}</h3>
            {meals[meal].length === 0 ? (
              <p className="mt-1 text-base">No foods listed.</p>
            ) : (
              <ul className="mt-1 list-disc pl-5 text-base">
                {meals[meal].map((item) => (
                  <li key={item.itemId}>{item.displayName}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}
