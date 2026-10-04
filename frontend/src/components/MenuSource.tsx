/**
 * Add a menu: pick a date (and how often it repeats), type the foods for each
 * meal, save, and move on to the next day. Menus can also come from a
 * spreadsheet, or straight from the hall's own system through the API.
 */
import { useId, useRef, useState } from 'react'
import { menuApiBase, saveUserMenuDays } from '../data/api'
import type { HallRef, HallSettings, IsoDate, MealHours, MealLabel, MenuItemLite, MenuRepeat } from '../data/types'
import { MEALS, MEAL_NAME, MENU_REPEAT_NAME, WEEKDAY_NAME } from '../data/types'
import { DEFAULT_SETTINGS, newId, timeSetFor, weekdayOf } from '../state/settings'
import { itemIdFor } from '../data/mockData'
import { addDays, formatMedium, todayIso } from '../lib/dates'
import { defaultRepeatUntil, repeatDates } from '../lib/repeat'
import { Card, FieldLabel, GhostButton, InfoTip, PrimaryButton, inputClass } from './ui'

const REPEATS: MenuRepeat[] = ['never', 'daily', 'weekly', 'biweekly']

export const MENU_API_EXPLANATION =
  "If your dining hall already keeps menus in another program, that program can send them to ScrapSaver automatically, so nobody has to type them in. Give your IT team or menu software vendor the web address and example below. Menus sent this way show up here just like typed ones."

export function MenuSource({
  halls = [],
  hallId,
  date: controlledDate,
  onDateChange,
  initialDate,
  onMenuSaved,
  settings,
  onSettingsChange,
}: {
  /** With settings: a row under the meal boxes to change when each meal runs. */
  settings?: HallSettings
  onSettingsChange?: (next: HallSettings) => void
  /** Locations the manager runs; a picker shows when there is more than one and no `hallId`. */
  halls?: HallRef[]
  /** Save to this hall (the page already picked one). */
  hallId?: string
  /** Controlled menu date, e.g. the day picked on the calendar below. */
  date?: IsoDate
  onDateChange?: (date: IsoDate) => void
  initialDate?: IsoDate
  onMenuSaved?: (dates: IsoDate[]) => void
}) {
  const [ownDate, setOwnDate] = useState<IsoDate>(initialDate ?? todayIso())
  const date = controlledDate ?? ownDate
  const setDate = (next: IsoDate) => {
    setOwnDate(next)
    onDateChange?.(next)
  }
  const [pickedHall, setPickedHall] = useState<string | undefined>(halls[0]?.hallId)
  const hall = hallId ?? pickedHall
  const hallName = halls.find((h) => h.hallId === hall)?.name

  return (
    <ManualMenuPanel
      date={date}
      setDate={setDate}
      hall={hall}
      hallName={hallName}
      hallPicker={
        !hallId && halls.length > 1 ? (
          <div>
            <FieldLabel htmlFor="menu-hall">Dining hall</FieldLabel>
            <select
              id="menu-hall"
              value={pickedHall}
              onChange={(e) => setPickedHall(e.target.value)}
              className="rounded-btn border border-ink bg-cream px-3 py-2 text-base text-ink"
            >
              {halls.map((h) => (
                <option key={h.hallId} value={h.hallId}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
        ) : null
      }
      onMenuSaved={onMenuSaved}
      mealTimes={settings && onSettingsChange ? <MealTimesRow date={date} settings={settings} onChange={onSettingsChange} /> : null}
    />
  )
}

/**
 * When breakfast, lunch, and dinner run on the menu date's days (its meal-time
 * set, e.g. Weekdays). Changes save right away.
 */
function MealTimesRow({ date, settings, onChange }: { date: IsoDate; settings: HallSettings; onChange: (next: HallSettings) => void }) {
  const set = timeSetFor(settings, date)
  const meals = set?.meals ?? DEFAULT_SETTINGS.timeSets[0].meals
  const update = (meal: MealLabel, field: keyof MealHours, value: string) => {
    if (!value) return
    const nextMeals = { ...meals, [meal]: { ...meals[meal], [field]: value } }
    const timeSets = set
      ? settings.timeSets.map((t) => (t.id === set.id ? { ...t, meals: nextMeals } : t))
      : [...settings.timeSets, { id: newId('set'), name: WEEKDAY_NAME[weekdayOf(date)], days: [weekdayOf(date)], meals: nextMeals }]
    onChange({ ...settings, timeSets })
  }
  return (
    <div className="mt-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {MEALS.map((meal) => (
          <fieldset key={meal} className="rounded-card border border-linen p-3">
            <legend className="px-1 text-base font-semibold text-ink">{MEAL_NAME[meal]} times</legend>
            <div className="flex flex-wrap items-center gap-2 text-base">
              <label className="flex items-center gap-2">
                from
                <input
                  type="time"
                  value={meals[meal].start}
                  onChange={(e) => update(meal, 'start', e.target.value)}
                  aria-label={`${MEAL_NAME[meal]} start time`}
                  className="rounded-btn border border-ink bg-cream px-2 py-1.5 text-base text-ink"
                />
              </label>
              <label className="flex items-center gap-2">
                to
                <input
                  type="time"
                  value={meals[meal].end}
                  onChange={(e) => update(meal, 'end', e.target.value)}
                  aria-label={`${MEAL_NAME[meal]} end time`}
                  className="rounded-btn border border-ink bg-cream px-2 py-1.5 text-base text-ink"
                />
              </label>
            </div>
          </fieldset>
        ))}
      </div>
      <p className="mt-2 text-sm">
        {set
          ? `These hours apply to ${set.name || 'these days'} (${set.days.map((d) => WEEKDAY_NAME[d]).join(', ')}). Changes save right away.`
          : `No meal times are set for ${WEEKDAY_NAME[weekdayOf(date)]} yet. Changing them here adds them.`}
      </p>
    </div>
  )
}

function emptyMeals(): Record<MealLabel, string[]> {
  return { breakfast: [''], lunch: [''], dinner: [''] }
}

function describeDates(dates: IsoDate[]): string {
  if (dates.length === 1) return formatMedium(dates[0])
  return `${dates.length} days, ${formatMedium(dates[0])} through ${formatMedium(dates[dates.length - 1])}`
}

function ManualMenuPanel({
  date,
  setDate,
  hall,
  hallName,
  hallPicker,
  onMenuSaved,
  mealTimes,
}: {
  mealTimes: React.ReactNode
  date: IsoDate
  setDate: (date: IsoDate) => void
  hall?: string
  hallName?: string
  hallPicker: React.ReactNode
  onMenuSaved?: (dates: IsoDate[]) => void
}) {
  const [meals, setMeals] = useState<Record<MealLabel, string[]>>(emptyMeals)
  const [repeat, setRepeat] = useState<MenuRepeat>('never')
  const [until, setUntil] = useState<IsoDate>(() => defaultRepeatUntil(date))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [csvNote, setCsvNote] = useState<string | null>(null)
  const [showApi, setShowApi] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const apiTip = useId()

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
  const dates = repeatDates(date, repeat, until)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await saveUserMenuDays(
        dates,
        { breakfast: toItems(meals.breakfast), lunch: toItems(meals.lunch), dinner: toItems(meals.dinner) },
        hall,
      )
      setSaved((s) => [...s, describeDates(dates)])
      onMenuSaved?.(dates)
      // "Allow adding several days at once": keep the form, advance the date.
      setMeals(emptyMeals())
      setRepeat('never')
      setDate(addDays(date, 1))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The menu could not be saved.')
    } finally {
      setSaving(false)
    }
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
    try {
      for (const [d, m] of byDate) {
        await saveUserMenuDays([d], { breakfast: toItems(m.breakfast), lunch: toItems(m.lunch), dinner: toItems(m.dinner) }, hall)
        setSaved((prev) => [...prev, formatMedium(d)])
        onMenuSaved?.([d])
      }
      setCsvNote(`Added menus for ${byDate.size} day${byDate.size === 1 ? '' : 's'} from the spreadsheet.`)
    } catch (err) {
      setCsvNote(err instanceof Error ? err.message : 'The spreadsheet could not be saved.')
    }
  }

  return (
    <Card>
      <h2 className="text-4xl font-semibold text-ink leading-tight">Add a menu{hallName ? ` for ${hallName}` : ''}</h2>
      <div className="mt-3 flex flex-wrap items-end gap-4">
        {hallPicker}
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
            onChange={(e) => {
              const next = e.target.value as MenuRepeat
              setRepeat(next)
              if (next !== 'never' && until <= date) setUntil(defaultRepeatUntil(date))
            }}
            className="rounded-btn border border-ink bg-cream px-3 py-2 text-base text-ink"
          >
            {REPEATS.map((r) => (
              <option key={r} value={r}>
                {MENU_REPEAT_NAME[r]}
              </option>
            ))}
          </select>
        </div>
        {repeat !== 'never' && (
          <div>
            <FieldLabel htmlFor="menu-repeat-until">Until</FieldLabel>
            <input
              id="menu-repeat-until"
              type="date"
              min={date}
              value={until}
              onChange={(e) => e.target.value && setUntil(e.target.value)}
              className="rounded-btn border border-ink bg-cream px-3 py-2 text-base text-ink"
            />
          </div>
        )}
      </div>
      {repeat !== 'never' && <p className="mt-2 text-sm">This menu will be saved on {describeDates(dates)}.</p>}

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

      {mealTimes}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <PrimaryButton type="button" onClick={save} disabled={!hasItems || saving}>
          {saving ? 'Saving…' : repeat === 'never' ? 'Save this day' : `Save ${dates.length} days`}
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
        <span className="inline-flex items-center">
          <GhostButton type="button" aria-expanded={showApi} aria-controls="menu-api-panel" onClick={() => setShowApi((v) => !v)}>
            Send menus through the API
          </GhostButton>
          <InfoTip id={apiTip} text={MENU_API_EXPLANATION} />
        </span>
      </div>
      <p className="mt-2 text-sm">Save the spreadsheet as .csv with one food per row: meal, food. Add a date column first to fill several days.</p>

      {showApi && <MenuApiPanel hallId={hall ?? 'hall-main'} />}

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
      {saved.length > 0 && (
        <p role="status" className="mt-2 text-base">
          Saved: {saved.join('; ')}. Add another day above, or move on when you're done.
        </p>
      )}
    </Card>
  )
}

/** Copy-ready instructions for a hall's own menu system (POST /api/menus/upload). */
function MenuApiPanel({ hallId }: { hallId: string }) {
  const [copied, setCopied] = useState(false)
  const url = `${menuApiBase()}/api/menus/upload`
  const example = JSON.stringify(
    {
      hallId,
      hallTimezone: 'America/Detroit',
      days: [{ date: todayIso(), lunch: ['Grilled Chicken', 'Brown Rice'], dinner: ['Pasta Marinara'] }],
    },
    null,
    2,
  )
  const curl = `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -d '${example.replace(/\n\s*/g, ' ')}'`

  return (
    <div id="menu-api-panel" className="mt-4 space-y-3 rounded-card border border-linen p-4">
      <h3 className="text-[32px] font-semibold leading-tight">Send menus from your own system</h3>
      <p className="text-sm">
        Send a POST request with JSON to the address below. Each day lists the foods for breakfast, lunch, and dinner. Sending a
        day again replaces that day's menu. For a spreadsheet file, send it as text/csv to{' '}
        <code className="break-all">{menuApiBase()}/api/menus/csv?hallId={hallId}&amp;hallTimezone=America/Detroit</code>.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="font-semibold">Address</dt>
        <dd>
          <code className="break-all">POST {url}</code>
        </dd>
        <dt className="font-semibold">Dining hall ID</dt>
        <dd>
          <code>{hallId}</code>
        </dd>
      </dl>
      <pre className="overflow-x-auto rounded-btn bg-ink p-3 text-xs leading-snug text-cream">{curl}</pre>
      <GhostButton
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(curl).then(() => setCopied(true))
        }}
      >
        {copied ? 'Copied' : 'Copy example'}
      </GhostButton>
    </div>
  )
}
