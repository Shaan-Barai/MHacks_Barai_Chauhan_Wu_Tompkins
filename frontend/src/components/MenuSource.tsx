/**
 * Add a menu, two ways:
 *   - Type it: pick a date (and how often it repeats), type the foods for
 *     each meal or upload a spreadsheet, save, and move on to the next day.
 *   - API: the address and format a menu system can send menus to
 *     (POST /api/menus/upload, backend/README.md "Menu uploads").
 */
import { useRef, useState } from 'react'
import { HALL_TIMEZONE, saveUserMenu, saveUserMenuDays } from '../data/api'
import type { HallLocation, IsoDate, MealLabel, MenuItemLite } from '../data/types'
import { MEALS, MEAL_NAME } from '../data/types'
import { itemIdFor } from '../data/mockData'
import { addDays, todayIso } from '../lib/dates'
import { Card, FieldLabel, GhostButton, InfoTip, PrimaryButton, inputClass } from './ui'

const API_EXPLANATION =
  'An API lets your menu software send menus to ScrapSaver on its own, so nobody has to type them. Choose this if your menus already live in another system.'

export function MenuSource({
  initialDate,
  onMenuSaved,
  locations,
}: {
  initialDate?: IsoDate
  onMenuSaved?: (date: IsoDate) => void
  locations: HallLocation[]
}) {
  const [mode, setMode] = useState<'type' | 'api'>('type')
  const tab = (value: 'type' | 'api', label: string) => (
    <button
      type="button"
      aria-pressed={mode === value}
      onClick={() => setMode(value)}
      className={`rounded-btn border border-ink px-4 py-2 text-base ${mode === value ? 'bg-ink font-semibold text-cream' : 'bg-cream text-ink hover:underline'}`}
    >
      {label}
    </button>
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="How to add menus">
        {tab('type', 'Type or upload a spreadsheet')}
        <span className="inline-flex items-center">
          {tab('api', 'API')}
          <InfoTip id="menu-api-tip" text={API_EXPLANATION} />
        </span>
      </div>
      {mode === 'type' ? (
        <ManualMenuPanel initialDate={initialDate} onMenuSaved={onMenuSaved} />
      ) : (
        <ApiPanel locations={locations} />
      )}
    </div>
  )
}

function ApiPanel({ locations }: { locations: HallLocation[] }) {
  const [copied, setCopied] = useState(false)
  const base = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '')
  const address = `${base}/api/menus/upload`
  const example = JSON.stringify(
    {
      hallId: locations[0]?.id ?? 'hall-main',
      hallTimezone: HALL_TIMEZONE,
      days: [{ date: todayIso(), breakfast: ['Scrambled Eggs'], lunch: ['Tomato Soup'], dinner: ['Baked Ziti'] }],
    },
    null,
    2,
  )

  const copy = async () => {
    await navigator.clipboard?.writeText(example)
    setCopied(true)
  }

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">Send menus by API</h2>
        <p className="mt-1">Give these details to whoever runs your menu software. Sending a day again replaces its menu.</p>
      </div>
      <div>
        <p className="font-semibold">Send menus to</p>
        <p className="mt-1 break-all font-mono text-sm">POST {address}</p>
      </div>
      <div>
        <p className="font-semibold">Dining hall codes</p>
        <ul className="mt-1 space-y-1">
          {locations.map((l) => (
            <li key={l.id}>
              {l.name || 'Dining hall'}: <span className="font-mono text-sm">{l.id}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="font-semibold">Example</p>
        <pre className="mt-1 overflow-x-auto rounded-btn border border-ink p-3 font-mono text-sm">{example}</pre>
        <div className="mt-2 flex items-center gap-3">
          <GhostButton type="button" onClick={copy}>
            Copy example
          </GhostButton>
          {copied && <p role="status">Copied.</p>}
        </div>
      </div>
    </Card>
  )
}

type Repeat = 'never' | 'daily' | 'weekly' | 'biweekly'
const REPEAT_STEP: Record<Exclude<Repeat, 'never'>, number> = { daily: 1, weekly: 7, biweekly: 14 }

/** Every date the menu lands on: the picked date, then each repeat through `until`. */
export function repeatDates(date: IsoDate, repeat: Repeat, until: IsoDate): IsoDate[] {
  if (repeat === 'never') return [date]
  const out: IsoDate[] = []
  for (let d = date; d <= until; d = addDays(d, REPEAT_STEP[repeat])) out.push(d)
  return out.length > 0 ? out : [date]
}

function savedNote(dates: IsoDate[]): string {
  if (dates.length <= 7) return `Saved: ${dates.join(', ')}.`
  const sorted = [...dates].sort()
  return `Saved ${dates.length} days, ${sorted[0]} to ${sorted[sorted.length - 1]}.`
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
  const [repeat, setRepeat] = useState<Repeat>('never')
  const [until, setUntil] = useState<IsoDate>(addDays(initialDate ?? todayIso(), 27))
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
    const dates = repeatDates(date, repeat, until)
    await saveUserMenuDays(dates, {
      breakfast: toItems(meals.breakfast),
      lunch: toItems(meals.lunch),
      dinner: toItems(meals.dinner),
    })
    setSaving(false)
    setSavedDates((d) => [...d, ...dates])
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
    for (const [d, m] of byDate) {
      await saveUserMenu(d, {
        breakfast: toItems(m.breakfast),
        lunch: toItems(m.lunch),
        dinner: toItems(m.dinner),
      })
      setSavedDates((prev) => [...prev, d])
      onMenuSaved?.(d)
    }
    setCsvNote(`Added menus for ${byDate.size} day${byDate.size === 1 ? '' : 's'} from the spreadsheet.`)
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold text-ink">Add a menu</h2>
      <div className="mt-3 flex flex-wrap items-end gap-4">
        <div>
          <FieldLabel htmlFor="menu-date">Menu date</FieldLabel>
          <input
            id="menu-date"
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="rounded-btn border border-ink bg-cream px-3 py-2 text-base text-ink"
          />
        </div>
        <div>
          <FieldLabel htmlFor="menu-repeat">Repeat:</FieldLabel>
          <select
            id="menu-repeat"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value as Repeat)}
            className="rounded-btn border border-ink bg-cream px-3 py-2 text-base text-ink"
          >
            <option value="never">Never</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="biweekly">Every other week</option>
          </select>
        </div>
        {repeat !== 'never' && (
          <div>
            <FieldLabel htmlFor="menu-until">Until</FieldLabel>
            <input
              id="menu-until"
              type="date"
              min={date}
              value={until}
              onChange={(e) => e.target.value && setUntil(e.target.value)}
              className="rounded-btn border border-ink bg-cream px-3 py-2 text-base text-ink"
            />
          </div>
        )}
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
          {saving ? 'Saving…' : 'Save this day'}
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
        <p className="text-sm">Save the spreadsheet as .csv with one food per row: meal, food. Add a date column first to fill several days.</p>
      </div>

      {csvNote && (
        <p role="status" className="mt-3 text-base font-semibold">
          {csvNote}
        </p>
      )}
      {savedDates.length > 0 && (
        <p role="status" className="mt-2 text-base">
          {savedNote(savedDates)} Add another day above, or move on when you're done.
        </p>
      )}
    </Card>
  )
}
