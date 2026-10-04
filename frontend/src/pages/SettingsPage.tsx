/** Settings: hall name, meal times for different days, special events, and a download. */
import { useState } from 'react'
import { MealTimesFields } from '../components/MealTimesFields'
import { Card, FieldLabel, GhostButton, PrimaryButton, inputClass } from '../components/ui'
import type { HallSettings, MealTimeSet, SpecialEvent, Weekday } from '../data/types'
import { WEEKDAYS, WEEKDAY_NAME } from '../data/types'
import { buildWasteCsv, downloadCsv } from '../lib/csv'
import { todayIso } from '../lib/dates'
import { DEFAULT_SETTINGS, newId } from '../state/settings'

function TimeSetEditor({
  set,
  onChange,
  onRemove,
}: {
  set: MealTimeSet
  onChange: (next: MealTimeSet) => void
  onRemove?: () => void
}) {
  const toggle = (day: Weekday) =>
    onChange({ ...set, days: set.days.includes(day) ? set.days.filter((d) => d !== day) : WEEKDAYS.filter((d) => d === day || set.days.includes(d)) })
  return (
    <fieldset className="space-y-3 border border-ink p-4">
      <legend className="px-1 font-semibold">{set.name || 'Meal times'}</legend>
      <div className="max-w-xs">
        <FieldLabel htmlFor={`set-name-${set.id}`}>Name</FieldLabel>
        <input id={`set-name-${set.id}`} className={inputClass} value={set.name} placeholder="e.g. Weekdays" onChange={(e) => onChange({ ...set, name: e.target.value })} />
      </div>
      <div role="group" aria-label={`Days for ${set.name || 'these meal times'}`} className="flex flex-wrap gap-2">
        {WEEKDAYS.map((day) => (
          <label key={day} className="flex items-center gap-1.5 border border-ink px-2 py-1">
            <input type="checkbox" checked={set.days.includes(day)} onChange={() => toggle(day)} />
            {WEEKDAY_NAME[day]}
          </label>
        ))}
      </div>
      <MealTimesFields value={set.meals} onChange={(meals) => onChange({ ...set, meals })} />
      {onRemove && (
        <GhostButton type="button" onClick={onRemove}>
          Remove {set.name || 'these meal times'}
        </GhostButton>
      )}
    </fieldset>
  )
}

function EventRow({ event, onChange, onRemove }: { event: SpecialEvent; onChange: (e: SpecialEvent) => void; onRemove: () => void }) {
  const id = event.id
  return (
    <fieldset className="flex flex-wrap items-end gap-3 border border-ink p-3">
      <legend className="sr-only">{event.name || 'New event'}</legend>
      <div className="min-w-[12rem] flex-1">
        <FieldLabel htmlFor={`ev-name-${id}`}>Event</FieldLabel>
        <input id={`ev-name-${id}`} className={inputClass} value={event.name} placeholder="e.g. Football game" onChange={(e) => onChange({ ...event, name: e.target.value })} />
      </div>
      <div>
        <FieldLabel htmlFor={`ev-date-${id}`}>Date</FieldLabel>
        <input id={`ev-date-${id}`} type="date" className={inputClass} value={event.date} onChange={(e) => e.target.value && onChange({ ...event, date: e.target.value })} />
      </div>
      <div>
        <FieldLabel htmlFor={`ev-start-${id}`}>From</FieldLabel>
        <input id={`ev-start-${id}`} type="time" className={inputClass} value={event.start} onChange={(e) => onChange({ ...event, start: e.target.value })} />
      </div>
      <div>
        <FieldLabel htmlFor={`ev-end-${id}`}>To</FieldLabel>
        <input id={`ev-end-${id}`} type="time" className={inputClass} value={event.end} onChange={(e) => onChange({ ...event, end: e.target.value })} />
      </div>
      <GhostButton type="button" onClick={onRemove}>
        Remove
      </GhostButton>
    </fieldset>
  )
}

export function SettingsPage({ settings, onSave }: { settings: HallSettings; onSave: (next: HallSettings) => void }) {
  const [draft, setDraft] = useState<HallSettings>(settings)
  const [saved, setSaved] = useState(false)
  const [exporting, setExporting] = useState(false)

  const edit = (next: HallSettings) => {
    setDraft(next)
    setSaved(false)
  }
  const setTimeSet = (i: number, next: MealTimeSet) => edit({ ...draft, timeSets: draft.timeSets.map((t, j) => (j === i ? next : t)) })
  const setEvent = (i: number, next: SpecialEvent) => edit({ ...draft, events: draft.events.map((e, j) => (j === i ? next : e)) })

  const unassigned = WEEKDAYS.filter((d) => !draft.timeSets.some((t) => t.days.includes(d)))
  const doubled = WEEKDAYS.filter((d) => draft.timeSets.filter((t) => t.days.includes(d)).length > 1)

  const save = () => {
    onSave({ ...draft, events: draft.events.filter((e) => e.name.trim()) })
    setSaved(true)
  }

  const exportCsv = async () => {
    setExporting(true)
    try {
      downloadCsv(`scrapsaver-waste-${todayIso()}.csv`, await buildWasteCsv(30))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="max-w-3xl space-y-5">
      <h1 className="font-display text-3xl font-bold tracking-tight text-ink">Settings</h1>

      <Card>
      <fieldset className="min-w-0 space-y-4">
        <legend className="sr-only">Dining hall settings</legend>
        <div>
          <h2 className="text-lg font-semibold">Dining hall</h2>
          <div className="mt-2 max-w-md">
            <FieldLabel htmlFor="hall-name">Hall name</FieldLabel>
            <input id="hall-name" value={draft.name} onChange={(e) => edit({ ...draft, name: e.target.value })} className={inputClass} />
          </div>
        </div>

        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Meal times</h2>
          {draft.timeSets.map((set, i) => (
            <TimeSetEditor
              key={set.id}
              set={set}
              onChange={(next) => setTimeSet(i, next)}
              onRemove={draft.timeSets.length > 1 ? () => edit({ ...draft, timeSets: draft.timeSets.filter((_, j) => j !== i) }) : undefined}
            />
          ))}
          {unassigned.length > 0 && <p>No meal times for: {unassigned.map((d) => WEEKDAY_NAME[d]).join(', ')}.</p>}
          {doubled.length > 0 && <p>{doubled.map((d) => WEEKDAY_NAME[d]).join(', ')} {doubled.length === 1 ? 'is' : 'are'} in more than one set. The first set is used.</p>}
          <GhostButton
            type="button"
            onClick={() =>
              edit({ ...draft, timeSets: [...draft.timeSets, { id: newId('set'), name: '', days: unassigned, meals: DEFAULT_SETTINGS.timeSets[0].meals }] })
            }
          >
            Add meal times for other days
          </GhostButton>
        </div>

        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Special events</h2>
          {draft.events.length === 0 && <p>No events yet.</p>}
          {draft.events.map((event, i) => (
            <EventRow key={event.id} event={event} onChange={(next) => setEvent(i, next)} onRemove={() => edit({ ...draft, events: draft.events.filter((_, j) => j !== i) })} />
          ))}
          <GhostButton
            type="button"
            onClick={() => edit({ ...draft, events: [...draft.events, { id: newId('event'), name: '', date: todayIso(), start: '11:00', end: '15:00' }] })}
          >
            Add an event
          </GhostButton>
        </div>

        <div className="flex items-center gap-3 border-t border-ink pt-4">
          <PrimaryButton type="button" onClick={save}>
            Save settings
          </PrimaryButton>
          {saved && (
            <p role="status" className="font-semibold">
              Saved.
            </p>
          )}
        </div>
      </fieldset>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">Download</h2>
        <div className="mt-3">
          <GhostButton type="button" onClick={exportCsv} disabled={exporting}>
            Download last 30 days
          </GhostButton>
        </div>
      </Card>
    </div>
  )
}
