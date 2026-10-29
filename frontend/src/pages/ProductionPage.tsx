/**
 * Production sheets: photograph the kitchen's handwritten production sheet,
 * let the AI read it, then check every row before it counts. Rows start
 * "To review"; a flagged value (low confidence, impossible numbers, unknown
 * dish) is outlined with the reason. Nothing reaches forecasting until a named
 * person confirms the row.
 */
import { useState } from 'react'
import {
  USE_MOCK,
  confirmProductionRow,
  editProductionRow,
  getDishes,
  getProductionLog,
  readProductionSheet,
  rejectProductionRow,
} from '../data/api'
import type { Dish, MealLabel, ProductionEdit, ProductionRow, SheetReadResult } from '../data/types'
import { MEALS, MEAL_NAME } from '../data/types'
import { todayIso } from '../lib/dates'
import { useAsync } from '../lib/useAsync'
import { Badge, Card, EmptyState, FieldLabel, GhostButton, LoadingBlock, PrimaryButton, inputClass } from '../components/ui'
import { useAuth } from '../state/auth'

/** Friendly text for each review flag (field-specific flags share one text). */
const FLAG_TEXT: Record<string, string> = {
  unknown_dish: 'Not one of the hall’s dishes: pick the right one.',
  missing_dish: 'No dish name could be read.',
  missing_meal: 'Which meal is this?',
  missing_date: 'Which date is this?',
  invalid_date: 'The date could not be read.',
  date_differs_from_upload: 'The sheet’s date differs from the date you chose.',
  leftover_exceeds_prepped: 'More left in the pan than was prepared.',
  missing_prepped_amount: 'Neither pounds nor portions prepared could be read.',
  ran_out_outside_meal: 'Ran-out time is outside this meal’s hours.',
  ran_out_but_leftover: 'Marked as ran out, but food was left in the pan.',
  invalid_time: 'The ran-out time could not be read.',
  fractional_portions: 'Portions were not a whole number.',
  low_confidence: 'The AI was not sure it read this correctly.',
  negative_value: 'This cannot be negative.',
  implausible_value: 'This number looks too large for one batch.',
  not_a_number: 'This should be a number.',
}

const FIELD_OF_FLAG: Record<string, keyof ProductionEdit | 'dish'> = {
  unknown_dish: 'dish', missing_dish: 'dish', missing_meal: 'mealLabel', missing_date: 'serviceDate', invalid_date: 'serviceDate',
  date_differs_from_upload: 'serviceDate', leftover_exceeds_prepped: 'panLeftoverLb', missing_prepped_amount: 'preppedLb',
  ran_out_outside_meal: 'ranOutTime', ran_out_but_leftover: 'ranOutTime', invalid_time: 'ranOutTime', fractional_portions: 'preppedPortions',
}

/** Flags that point at one field, with readable reasons. */
function flagsFor(row: ProductionRow, field: string): string[] {
  const out: string[] = []
  for (const flag of row.reviewFlags) {
    const [kind, target] = flag.split(':') as [string, string | undefined]
    const f = target ?? FIELD_OF_FLAG[kind]
    if (f !== field) continue
    const conf = kind === 'low_confidence' ? row.fieldConfidence?.[field] : undefined
    out.push(`${FLAG_TEXT[kind] ?? flag}${conf !== undefined ? ` (${Math.round(conf * 100)}% sure)` : ''}`)
  }
  return out
}

export function ProductionPage() {
  const { readOnly } = useAuth()
  const [revision, setRevision] = useState(0)
  const [lastRead, setLastRead] = useState<SheetReadResult | null>(null)
  const [reviewer, setReviewer] = useState('')
  const log = useAsync(() => getProductionLog(), [revision])
  const dishes = useAsync(() => getDishes(), [])
  const refresh = () => setRevision((r) => r + 1)

  const rows = log.data?.rows ?? []
  const toReview = rows.filter((r) => r.status === 'unconfirmed')
  const confirmed = rows.filter((r) => r.status === 'confirmed').slice(-20).reverse()

  return (
    <div className="space-y-5">
      <h1 className="flex flex-wrap items-center gap-3 font-display text-3xl font-bold tracking-tight text-ink">
        Production sheets{USE_MOCK && <Badge>Demo</Badge>}
      </h1>
      <p className="max-w-3xl text-base text-thyme">
        Take a photo of the day’s production sheet. ScrapSaver reads it with AI, then you check each row. Nothing counts toward forecasts until
        someone confirms it.
      </p>

      {log.data && !log.data.available && (
        <p role="status" className="rounded-card border-2 border-dashed border-linen p-3">
          Reading sheets needs the AI service, which is not set up on this server. Rows already read can still be reviewed.
        </p>
      )}

      {!readOnly && log.data?.available !== false && <SheetUpload onRead={(r) => { setLastRead(r); refresh() }} />}
      {lastRead && (
        <p role="status" className="font-semibold">
          {lastRead.readable
            ? `Read ${lastRead.rows.length} row${lastRead.rows.length === 1 ? '' : 's'}. Check them below.`
            : 'That photo does not look like a production sheet.'}
          {lastRead.notes && <span className="block font-normal">Note from the reader: {lastRead.notes}</span>}
        </p>
      )}

      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink">To review ({toReview.length})</h2>
          {!readOnly && (
            <div className="w-64">
              <FieldLabel htmlFor="reviewer">Your name or initials (kept private, never shown on the site)</FieldLabel>
              <input id="reviewer" className={inputClass} value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="e.g. Chef Ana" />
            </div>
          )}
        </div>
        {log.status === 'loading' && !log.data && <LoadingBlock label="Loading production rows" />}
        {log.status === 'error' && <EmptyState title="Couldn't load production rows.">{log.error}</EmptyState>}
        {log.data && toReview.length === 0 && <p className="mt-3 text-base text-thyme">Nothing to review.</p>}
        <div className="mt-3 space-y-4">
          {toReview.map((row) => (
            <ReviewRow key={`${row.productionLogId}-${row.reviewFlags.join()}`} row={row} dishes={dishes.data ?? []} reviewer={reviewer} readOnly={readOnly} onChanged={refresh} />
          ))}
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-ink">Recently confirmed</h2>
        {confirmed.length === 0 ? (
          <p className="mt-3 text-base text-thyme">No confirmed rows yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-base">
              <thead>
                <tr className="border-b border-linen">
                  <th className="py-2 pr-3">Date</th><th className="pr-3">Meal</th><th className="pr-3">Dish</th><th className="pr-3">Station</th>
                  <th className="pr-3 text-right">Prepped (lb)</th><th className="pr-3 text-right">Portions</th><th className="pr-3 text-right">Pan leftover (lb)</th>
                  <th className="pr-3">Ran out</th><th>Checked</th>
                </tr>
              </thead>
              <tbody>
                {confirmed.map((r) => (
                  <tr key={r.productionLogId} className="border-b border-linen/30">
                    <td className="whitespace-nowrap py-2 pr-3">{r.serviceDate}</td>
                    <td className="pr-3">{r.mealLabel ? MEAL_NAME[r.mealLabel] : ''}</td>
                    <td className="pr-3">{(dishes.data ?? []).find((d) => d.dishId === r.dishId)?.displayName ?? r.dishId}{r.isSimulated && ' (simulated)'}</td>
                    <td className="pr-3">{r.station ?? ''}</td>
                    <td className="pr-3 text-right">{r.preppedLb ?? '–'}</td>
                    <td className="pr-3 text-right">{r.preppedPortions ?? '–'}</td>
                    <td className="pr-3 text-right">{r.panLeftoverLb ?? '–'}</td>
                    <td className="pr-3">{r.ranOutTime ?? 'No'}</td>
                    <td>{r.confirmedAt ? r.confirmedAt.slice(0, 10) : 'Yes'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function SheetUpload({ onRead }: { onRead: (r: SheetReadResult) => void }) {
  const [photo, setPhoto] = useState<File | null>(null)
  const [date, setDate] = useState(todayIso)
  const [meal, setMeal] = useState<MealLabel>('lunch')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!photo) return
    setBusy(true)
    setError(null)
    try {
      onRead(await readProductionSheet({ photo, serviceDate: date, mealLabel: meal }))
      setPhoto(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the sheet.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <h2 className="text-lg font-semibold text-ink">Read a sheet</h2>
      <div className="mt-3 flex flex-wrap items-end gap-4">
        <div>
          <FieldLabel htmlFor="sheet-photo">Sheet photo</FieldLabel>
          <input id="sheet-photo" type="file" accept="image/*" className={inputClass} onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        </div>
        <div>
          <FieldLabel htmlFor="sheet-date">Date served</FieldLabel>
          <input id="sheet-date" type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <FieldLabel htmlFor="sheet-meal">Meal</FieldLabel>
          <select id="sheet-meal" className={inputClass} value={meal} onChange={(e) => setMeal(e.target.value as MealLabel)}>
            {MEALS.map((m) => <option key={m} value={m}>{MEAL_NAME[m]}</option>)}
          </select>
        </div>
        <PrimaryButton type="button" disabled={!photo || busy} onClick={submit}>{busy ? 'Reading…' : 'Read sheet'}</PrimaryButton>
      </div>
      {error && <p role="alert" className="mt-2 font-semibold">{error}</p>}
    </Card>
  )
}

type Draft = {
  dishId: string
  station: string
  mealLabel: string
  serviceDate: string
  preppedLb: string
  preppedPortions: string
  panLeftoverLb: string
  ranOutTime: string
}

const draftOf = (r: ProductionRow): Draft => ({
  dishId: r.dishId ?? '',
  station: r.station ?? '',
  mealLabel: r.mealLabel ?? '',
  serviceDate: r.serviceDate ?? '',
  preppedLb: r.preppedLb?.toString() ?? '',
  preppedPortions: r.preppedPortions?.toString() ?? '',
  panLeftoverLb: r.panLeftoverLb?.toString() ?? '',
  ranOutTime: r.ranOutTime ?? '',
})

/** Only the fields a person changed, in API form. */
function changes(row: ProductionRow, d: Draft): ProductionEdit {
  const orig = draftOf(row)
  const edit: ProductionEdit = {}
  const num = (s: string) => (s.trim() === '' ? null : Number(s))
  if (d.dishId !== orig.dishId) edit.dishId = d.dishId || null
  if (d.station !== orig.station) edit.station = d.station || null
  if (d.mealLabel !== orig.mealLabel && d.mealLabel) edit.mealLabel = d.mealLabel as MealLabel
  if (d.serviceDate !== orig.serviceDate && d.serviceDate) edit.serviceDate = d.serviceDate
  if (d.preppedLb !== orig.preppedLb) edit.preppedLb = num(d.preppedLb)
  if (d.preppedPortions !== orig.preppedPortions) edit.preppedPortions = num(d.preppedPortions)
  if (d.panLeftoverLb !== orig.panLeftoverLb) edit.panLeftoverLb = num(d.panLeftoverLb)
  if (d.ranOutTime !== orig.ranOutTime) edit.ranOutTime = d.ranOutTime || null
  return edit
}

function ReviewRow({ row, dishes, reviewer, readOnly, onChanged }: { row: ProductionRow; dishes: Dish[]; reviewer: string; readOnly: boolean; onChanged: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(row))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const edit = changes(row, draft)
  const dirty = Object.keys(edit).length > 0
  const id = `row-${row.productionLogId}`
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }))
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const cell = (field: string, label: string, input: React.ReactNode) => {
    const notes = flagsFor(row, field)
    return (
      <div className={notes.length ? 'rounded-btn border-2 border-dashed border-ink p-2' : 'p-2'}>
        <FieldLabel htmlFor={`${id}-${field}`}>{label}</FieldLabel>
        {input}
        {notes.map((n) => (
          <p key={n} className="mt-1 text-sm font-semibold"><span aria-hidden="true">⚠ </span>Check: {n}</p>
        ))}
      </div>
    )
  }
  const numberInput = (k: 'preppedLb' | 'preppedPortions' | 'panLeftoverLb', step: string) => (
    <input id={`${id}-${k}`} type="number" min="0" step={step} inputMode="decimal" className={inputClass} disabled={readOnly} value={draft[k]} onChange={set(k)} />
  )

  return (
    <section aria-label={`Sheet row: ${row.dishNameRaw ?? 'unreadable dish'}`} className="rounded-card border border-linen p-3">
      <p className="text-base">
        On the sheet: <span className="font-semibold">“{row.dishNameRaw ?? 'unreadable'}”</span>
        {row.isSimulated && <Badge>Simulated</Badge>}
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {cell('dish', 'Dish', (
          <select id={`${id}-dish`} className={inputClass} disabled={readOnly} value={draft.dishId} onChange={set('dishId')}>
            <option value="">Choose a dish…</option>
            {dishes.map((d) => <option key={d.dishId} value={d.dishId}>{d.displayName}{d.isSimulated ? ' (simulated)' : ''}</option>)}
          </select>
        ))}
        {cell('station', 'Station', <input id={`${id}-station`} className={inputClass} disabled={readOnly} value={draft.station} onChange={set('station')} />)}
        {cell('mealLabel', 'Meal', (
          <select id={`${id}-mealLabel`} className={inputClass} disabled={readOnly} value={draft.mealLabel} onChange={set('mealLabel')}>
            <option value="">Choose…</option>
            {MEALS.map((m) => <option key={m} value={m}>{MEAL_NAME[m]}</option>)}
          </select>
        ))}
        {cell('serviceDate', 'Date', <input id={`${id}-serviceDate`} type="date" className={inputClass} disabled={readOnly} value={draft.serviceDate} onChange={set('serviceDate')} />)}
        {cell('preppedLb', 'Prepped (lb)', numberInput('preppedLb', '0.25'))}
        {cell('preppedPortions', 'Portions prepped', numberInput('preppedPortions', '1'))}
        {cell('panLeftoverLb', 'Pan leftover (lb)', numberInput('panLeftoverLb', '0.25'))}
        {cell('ranOutTime', 'Ran out at (blank = did not)', <input id={`${id}-ranOutTime`} type="time" className={inputClass} disabled={readOnly} value={draft.ranOutTime} onChange={set('ranOutTime')} />)}
      </div>
      {!readOnly && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <GhostButton type="button" disabled={!dirty || busy} onClick={() => run(() => editProductionRow(row.productionLogId, edit))}>Save changes</GhostButton>
          <PrimaryButton
            type="button"
            disabled={dirty || busy || row.blockingFlags.length > 0 || !reviewer.trim()}
            onClick={() => run(() => confirmProductionRow(row.productionLogId, reviewer))}
          >
            Confirm row
          </PrimaryButton>
          <GhostButton type="button" disabled={busy} onClick={() => run(() => rejectProductionRow(row.productionLogId))}>Reject</GhostButton>
          {dirty && <span className="text-sm">Save your changes before confirming.</span>}
          {!dirty && row.blockingFlags.length > 0 && <span className="text-sm">Fix the outlined values to confirm.</span>}
          {!dirty && row.blockingFlags.length === 0 && !reviewer.trim() && <span className="text-sm">Enter your name above to confirm.</span>}
        </div>
      )}
      {error && <p role="alert" className="mt-2 font-semibold">{error}</p>}
    </section>
  )
}
