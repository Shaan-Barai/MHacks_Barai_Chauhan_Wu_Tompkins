import { useEffect, useRef, useState } from 'react'
import { getPortionService, getPortionBenchmark, savePortions, importPortionsCsv, USE_MOCK } from '../data/api'
import type { MealLabel, PortionService } from '../data/types'
import { MEALS, MEAL_NAME } from '../data/types'
import { todayIso } from '../lib/dates'
import { useAsync } from '../lib/useAsync'
import { downloadCsv } from '../lib/csv'
import { Card, EmptyState, FieldLabel, GhostButton, inputClass, LoadingBlock, PrimaryButton } from '../components/ui'
import { PortionBenchmarkView } from '../components/PortionBenchmark'

export function PortionsPage({ onSaved }: { onSaved?: () => void }) {
  const [date, setDate] = useState(todayIso)
  const [meal, setMeal] = useState<MealLabel>('lunch')
  const [revision, setRevision] = useState(0)
  const [savedNote, setSavedNote] = useState(false)
  const selected = useAsync(() => getPortionService(date, meal), [date, meal, revision])
  return <div className="space-y-5">
    <h1 className="font-display text-3xl font-semibold text-ink">Portions served</h1>
    <p>Enter how many portions of each food were served at this meal, including seconds. Count served portions, not portions cooked.</p>
    {USE_MOCK && <p className="text-sm">Demo mode: counts are saved in this browser and labeled demo.</p>}
    <Card><div className="flex flex-wrap gap-4">
      <div><FieldLabel htmlFor="portions-date">Date</FieldLabel><input id="portions-date" type="date" className={inputClass} value={date} onChange={e => { setDate(e.target.value); setSavedNote(false) }} /></div>
      <div><FieldLabel htmlFor="portions-meal">Meal</FieldLabel><select id="portions-meal" className={inputClass} value={meal} onChange={e => { setMeal(e.target.value as MealLabel); setSavedNote(false) }}>
        {MEALS.map(m => <option key={m} value={m}>{MEAL_NAME[m]}</option>)}
      </select></div>
    </div></Card>
    {savedNote && <p role="status" className="font-semibold">Counts saved.</p>}
    {selected.status === 'loading' && <LoadingBlock label="Loading counts" />}
    {selected.status === 'error' && <EmptyState title="Couldn't load portions.">{selected.error}</EmptyState>}
    {selected.status === 'ready' && (selected.data
      ? <PortionsEditor key={`${date}-${meal}-${revision}`} service={selected.data} onSaved={() => { setRevision(r => r + 1); setSavedNote(true); onSaved?.() }} />
      : <EmptyState title="Add this meal’s menu first.">Go to Menu Schedule and add the foods served on this date.</EmptyState>)}
  </div>
}

function PortionsEditor({ service, onSaved }: { service: PortionService; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(service.items.map(i =>
    [i.itemId, service.portions.find(p => p.itemId === i.itemId)?.count.toString() ?? ''])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const benchmark = useAsync(() => getPortionBenchmark(service.serviceId), [service.serviceId])
  const complete = async (work: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await work(); if (alive.current) onSaved() }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Counts could not be saved.') }
    finally { if (alive.current) setBusy(false) }
  }
  const template = () => {
    const lines = ['service_id,menu_version,item_id,portions_served', ...service.items.map(i =>
      [service.serviceId, service.menuVersion, i.itemId, values[i.itemId]].join(','))]
    downloadCsv('portions-served.csv', lines.join('\n') + '\n')
  }
  return <>
    <Card><form onSubmit={e => {
      e.preventDefault()
      void complete(async () => {
        const entries = service.items.map(i => {
          const text = values[i.itemId].trim()
          if (text && !/^\d+$/.test(text)) throw new Error('Use whole numbers, or leave the box blank.')
          return { itemId: i.itemId, count: text === '' ? null : Number(text) }
        })
        await savePortions(service, entries)
      })
    }} className="space-y-4">
      <h2 className="text-lg font-semibold text-ink">Counts for this meal</h2>
      <p className="text-sm">Leave a food blank if you don’t know. Enter 0 only if none were served. Saving replaces this meal’s earlier counts.</p>
      <div className="grid gap-3 sm:grid-cols-2">{service.items.map((item, n) => <div key={item.itemId}>
        <FieldLabel htmlFor={`portion-count-${n}`}>{item.displayName}</FieldLabel>
        <input id={`portion-count-${n}`} type="number" min="0" max="4294967295" step="1" placeholder="Unknown" className={inputClass}
          disabled={busy} value={values[item.itemId]} onChange={e => setValues(v => ({ ...v, [item.itemId]: e.target.value }))} />
      </div>)}</div>
      <div className="flex flex-wrap items-center gap-3">
        <PrimaryButton type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save portions served'}</PrimaryButton>
        <GhostButton type="button" onClick={template} disabled={busy}>Download blank sheet</GhostButton>
        <label className="text-sm">Upload filled sheet (.csv)<input type="file" accept=".csv,text/csv" disabled={busy} aria-label="Upload filled portions sheet" className="mt-1 block max-w-full file:mr-3 file:rounded-btn file:border file:border-solid file:border-ink file:bg-cream file:px-3 file:py-1 file:font-sans file:text-ink"
          onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void complete(async () => {
            if (file.size > 1_000_000) throw new Error('That file is too big. Use the blank sheet from this page.')
            await importPortionsCsv(service, await file.text())
          }) }} /></label>
      </div>
      {error && <p role="alert" className="font-semibold text-ink">{error}</p>}
    </form></Card>
    <Card>{benchmark.status === 'loading' && <LoadingBlock label="Loading" />}
      {benchmark.status === 'error' && <EmptyState title="Couldn't load waste per portion.">{benchmark.error}</EmptyState>}
      {benchmark.status === 'ready' && <PortionBenchmarkView benchmark={benchmark.data} />}
    </Card>
  </>
}
