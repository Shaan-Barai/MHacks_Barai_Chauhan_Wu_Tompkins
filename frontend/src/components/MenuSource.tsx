/**
 * The two menu options (UI.md setup step 2, reused on the Menus page):
 *   • "Connect a menu API" — URL + key fields and a mock "Test connection".
 *   • "Upload menus myself" — pick a date, add items under each meal by typing
 *     or via CSV, several days allowed.
 */
import { useRef, useState } from 'react'
import { saveUserMenu, testMenuConnection } from '../data/api'
import type { IsoDate, MealLabel, MenuItemLite } from '../data/types'
import { MEALS, MEAL_NAME } from '../data/types'
import { itemIdFor } from '../data/mockData'
import { addDays, todayIso } from '../lib/dates'
import { Card, FieldLabel, GhostButton, PrimaryButton, inputClass } from './ui'

type Source = 'api' | 'manual' | null

export function MenuSource({
  initialDate,
  onMenuSaved,
}: {
  initialDate?: IsoDate
  onMenuSaved?: (date: IsoDate) => void
}) {
  const [source, setSource] = useState<Source>(initialDate ? 'manual' : null)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <BigChoice
          title="Connect a menu API"
          description="Pull menus automatically from your menu provider."
          active={source === 'api'}
          onClick={() => setSource(source === 'api' ? null : 'api')}
        />
        <BigChoice
          title="Upload menus myself"
          description="Type items for each meal, or upload a CSV."
          active={source === 'manual'}
          onClick={() => setSource(source === 'manual' ? null : 'manual')}
        />
      </div>
      {source === 'api' && <ApiConnectPanel />}
      {source === 'manual' && <ManualMenuPanel initialDate={initialDate} onMenuSaved={onMenuSaved} />}
    </div>
  )
}

function BigChoice({
  title,
  description,
  active,
  onClick,
}: {
  title: string
  description: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-expanded={active}
      onClick={onClick}
      className={`rounded-card border-2 p-6 text-left shadow-soft transition-colors ${
        active ? 'border-basil bg-basil-tint' : 'border-linen bg-cream hover:bg-basil-tint/50'
      }`}
    >
      <span className="block font-display text-xl font-semibold text-ink">{title}</span>
      <span className="mt-1 block text-base text-thyme">{description}</span>
    </button>
  )
}

function ApiConnectPanel() {
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const test = async () => {
    setTesting(true)
    setResult(null)
    setResult(await testMenuConnection(url, key))
    setTesting(false)
  }

  return (
    <Card>
      <h3 className="text-lg font-semibold text-ink">Connect a menu API</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor="menu-api-url">API URL</FieldLabel>
          <input
            id="menu-api-url"
            type="url"
            placeholder="https://menus.example.edu/api"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <FieldLabel htmlFor="menu-api-key">API key</FieldLabel>
          <input
            id="menu-api-key"
            type="password"
            placeholder="Paste your key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <PrimaryButton type="button" onClick={test} disabled={testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </PrimaryButton>
        {result && (
          <p role="status" className={`text-base font-medium ${result.ok ? 'text-basil' : 'text-tomato'}`}>
            {result.message}
          </p>
        )}
      </div>
    </Card>
  )
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
    await saveUserMenu(date, {
      breakfast: toItems(meals.breakfast),
      lunch: toItems(meals.lunch),
      dinner: toItems(meals.dinner),
    })
    setSaving(false)
    setSavedDates((d) => [...d, date])
    onMenuSaved?.(date)
    // "Allow adding several days at once": keep the form, advance the date.
    setMeals(emptyMeals())
    setDate(addDays(date, 1))
  }

  /**
   * CSV (untrusted input — parsed as plain text only):
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
      setCsvNote('No rows recognized. Use "meal,item" lines (or "date,meal,item" for several days).')
      return
    }
    for (const [d, m] of byDate) {
      await saveUserMenu(d, {
        breakfast: toItems(m.breakfast),
        lunch: toItems(m.lunch),
        dinner: toItems(m.dinner),
      })
      setSavedDates((prev) => [...prev, d])
      onMenuSaved?.(d)
    }
    setCsvNote(`Added menus for ${byDate.size} day${byDate.size === 1 ? '' : 's'} from the CSV.`)
  }

  return (
    <Card>
      <h3 className="text-lg font-semibold text-ink">Upload menus myself</h3>
      <div className="mt-3">
        <FieldLabel htmlFor="menu-date">Menu date</FieldLabel>
        <input
          id="menu-date"
          type="date"
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="rounded-btn border border-linen bg-cream px-3 py-2 text-base text-ink"
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
                    className="rounded-btn border border-linen px-2 text-thyme hover:bg-basil-tint"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => addItem(meal)}
              className="mt-2 rounded-btn px-2 py-1 text-base font-medium text-basil hover:bg-basil-tint"
            >
              + Add item
            </button>
          </fieldset>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <PrimaryButton type="button" onClick={save} disabled={!hasItems || saving}>
          {saving ? 'Saving…' : 'Save this day'}
        </PrimaryButton>
        <GhostButton type="button" onClick={() => fileRef.current?.click()}>
          Upload a CSV instead
        </GhostButton>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          aria-label="Upload a menu CSV"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onCsv(f)
            e.target.value = ''
          }}
        />
        <p className="text-sm text-thyme">CSV lines: “meal,item” — or “date,meal,item” for several days.</p>
      </div>

      {csvNote && (
        <p role="status" className="mt-3 text-base font-medium text-basil">
          {csvNote}
        </p>
      )}
      {savedDates.length > 0 && (
        <p role="status" className="mt-2 text-base text-basil">
          Saved: {savedDates.join(', ')}. Add another day above, or move on when you're done.
        </p>
      )}
    </Card>
  )
}
