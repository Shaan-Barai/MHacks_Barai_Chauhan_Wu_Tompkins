/**
 * Add a menu: pick a date, type the foods for each meal (or upload a
 * spreadsheet), save, and move on to the next day.
 */
import { useRef, useState } from 'react'
import { saveUserMenu } from '../data/api'
import type { IsoDate, MealLabel, MenuItemLite } from '../data/types'
import { MEALS, MEAL_NAME } from '../data/types'
import { itemIdFor } from '../data/mockData'
import { addDays, todayIso } from '../lib/dates'
import { Card, FieldLabel, GhostButton, PrimaryButton, inputClass } from './ui'

export function MenuSource({
  initialDate,
  onMenuSaved,
}: {
  initialDate?: IsoDate
  onMenuSaved?: (date: IsoDate) => void
}) {
  return <ManualMenuPanel initialDate={initialDate} onMenuSaved={onMenuSaved} />
}

function emptyMeals(): Record<MealLabel, string[]> {
  return { breakfast: [''], lunch: [''], dinner: [''] }
}

function ManualMenuPanel({
  initialDate,
  onMenuSaved,
}: {
  initialDate?: IsoDate
  onMenuSaved?: (date: IsoDate) => void
}) {
  const [date, setDate] = useState<IsoDate>(initialDate ?? todayIso())
  const [meals, setMeals] = useState<Record<MealLabel, string[]>>(emptyMeals)
  const [saving, setSaving] = useState(false)
  const [savedDates, setSavedDates] = useState<IsoDate[]>([])
  const [csvNote, setCsvNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const setItem = (meal: MealLabel, i: number, value: string) =>
    setMeals((m) => ({ ...m, [meal]: m[meal].map((v, j) => (j === i ? value : v)) }))
  const addItem = (meal: MealLabel) => setMeals((m) => ({ ...m, [meal]: [...m[meal], ''] }))
  const removeItem = (meal: MealLabel, i: number) =>
    setMeals((m) => ({ ...m, [meal]: m[meal].length > 1 ? m[meal].filter((_, j) => j !== i) : [''] }))

  const toItems = (names: string[]): MenuItemLite[] =>
    names
      .map((n) => n.trim())
      .filter(Boolean)
      .map((name) => ({ itemId: itemIdFor(name), displayName: name }))

  const hasItems = MEALS.some((m) => meals[m].some((v) => v.trim()))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await saveUserMenu(date, {
        breakfast: toItems(meals.breakfast),
        lunch: toItems(meals.lunch),
        dinner: toItems(meals.dinner),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the menu.")
      return
    } finally {
      setSaving(false)
    }
    setSavedDates((d) => [...d, date])
    onMenuSaved?.(date)
    // "Allow adding several days at once": keep the form, advance the date.
    setMeals(emptyMeals())
    setDate(addDays(date, 1))
  }

  /**
   * CSV (untrusted input, parsed as plain text only):
   *   meal,item            → applies to the picked date
   *   date,meal,item       → several days at once
   */
  const onCsv = async (file: File) => {
    const text = await file.text()
    const byDate = new Map<IsoDate, Record<MealLabel, string[]>>()
    let rows = 0
    for (const line of text.split(/\r?\n/)) {
      const cells = line.split(',').map((c) => c.trim())
      if (cells.length < 2 || !cells[0] || cells[0].toLowerCase() === 'date' || cells[0].toLowerCase() === 'meal') continue
      const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(cells[0])
      const rowDate = hasDate ? cells[0] : date
      const meal = (hasDate ? cells[1] : cells[0]).toLowerCase() as MealLabel
      const item = hasDate ? cells.slice(2).join(', ') : cells.slice(1).join(', ')
      if (!MEALS.includes(meal) || !item) continue
      if (!byDate.has(rowDate)) byDate.set(rowDate, { breakfast: [], lunch: [], dinner: [] })
      byDate.get(rowDate)![meal].push(item)
      rows++
    }
    if (rows === 0) {
      setCsvNote('No foods found. Use one row per food: meal, food (or date, meal, food).')
      return
    }
    setError(null)
    for (const [d, m] of byDate) {
      try {
        await saveUserMenu(d, {
          breakfast: toItems(m.breakfast),
          lunch: toItems(m.lunch),
          dinner: toItems(m.dinner),
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : `Couldn't save the menu for ${d}.`)
        return
      }
      setSavedDates((prev) => [...prev, d])
      onMenuSaved?.(d)
    }
    setCsvNote(`Added menus for ${byDate.size} day${byDate.size === 1 ? '' : 's'} from the spreadsheet.`)
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold text-ink">Add a menu</h2>
      <div className="mt-3">
        <FieldLabel htmlFor="menu-date">Menu date</FieldLabel>
        <input
          id="menu-date"
          type="date"
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="rounded-btn border border-ink bg-cream px-3 py-2 text-base text-ink"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        {MEALS.map((meal) => (
          <fieldset key={meal} className="rounded-card border border-linen p-3">
            <legend className="px-1 text-base font-semibold text-ink">{MEAL_NAME[meal]}</legend>
            <ul className="space-y-2">
              {meals[meal].map((value, i) => (
                <li key={i} className="flex gap-2">
                  <input
                    aria-label={`${MEAL_NAME[meal]} item ${i + 1}`}
                    placeholder="e.g. Scrambled Eggs"
                    value={value}
                    onChange={(e) => setItem(meal, i, e.target.value)}
                    className={inputClass}
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${MEAL_NAME[meal]} item ${i + 1}`}
                    onClick={() => removeItem(meal, i)}
                    className="rounded-btn border border-ink px-2 hover:underline"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => addItem(meal)}
              className="mt-2 rounded-btn px-2 py-1 text-base font-semibold underline"
            >
              + Add item
            </button>
          </fieldset>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <PrimaryButton type="button" onClick={save} disabled={!hasItems || saving}>
          Save this day
        </PrimaryButton>
        <GhostButton type="button" onClick={() => fileRef.current?.click()}>
          Upload a spreadsheet instead
        </GhostButton>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          aria-label="Upload a menu spreadsheet (.csv)"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onCsv(f)
            e.target.value = ''
          }}
        />
      </div>

      {error && (
        <p role="alert" className="mt-3 text-base font-semibold">
          {error}
        </p>
      )}
      {csvNote && (
        <p role="status" className="mt-3 text-base font-semibold">
          {csvNote}
        </p>
      )}
      {savedDates.length > 0 && (
        <p role="status" className="mt-2 text-base">
          Saved: {savedDates.join(', ')}.
        </p>
      )}
    </Card>
  )
}
