/** Settings: dining hall names, special events, and a download. Meal times live on the Menu Schedule page. */
import { useState } from 'react'
import { Card, FieldLabel, GhostButton, PrimaryButton, inputClass } from '../components/ui'
import type { HallSettings, SpecialEvent } from '../data/types'
import { buildWasteCsv, downloadCsv } from '../lib/csv'
import { todayIso } from '../lib/dates'
import { assignHallIds, newId, withHalls } from '../state/settings'

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
  const setEvent = (i: number, next: SpecialEvent) => edit({ ...draft, events: draft.events.map((e, j) => (j === i ? next : e)) })


  // New locations get an ID on save; existing ones keep theirs so their data stays attached.
  const [hallDrafts, setHallDrafts] = useState<{ hallId?: string; name: string }[]>(settings.halls)
  const editHall = (next: { hallId?: string; name: string }[]) => {
    setHallDrafts(next)
    setSaved(false)
  }
  const namedHalls = hallDrafts.filter((h) => h.name.trim())

  const save = () => {
    onSave(withHalls({ ...draft, events: draft.events.filter((e) => e.name.trim()) }, assignHallIds(namedHalls)))
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
      <h1 className="font-display text-6xl font-semibold text-ink leading-tight">Settings</h1>

      <Card className="space-y-4">
        <div>
          <h2 className="text-4xl font-semibold leading-tight">Dining halls</h2>
          <ul className="mt-2 max-w-md space-y-3">
            {hallDrafts.map((h, i) => (
              <li key={h.hallId ?? `new-${i}`}>
                <FieldLabel htmlFor={`hall-name-${i}`}>{i === 0 ? 'Hall name' : `Location ${i + 1}`}</FieldLabel>
                <div className="flex gap-2">
                  <input
                    id={`hall-name-${i}`}
                    value={h.name}
                    placeholder="e.g. Bursley Dining"
                    onChange={(e) => editHall(hallDrafts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    className={inputClass}
                  />
                  {i > 0 && (
                    <GhostButton type="button" aria-label={`Remove location ${i + 1}`} onClick={() => editHall(hallDrafts.filter((_, j) => j !== i))}>
                      Remove
                    </GhostButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => editHall([...hallDrafts, { name: '' }])} className="mt-2 rounded-btn px-2 py-1 text-base font-semibold underline">
            + Add another location
          </button>
          <p className="mt-1 text-sm">Removing a location here hides it from this browser. Its saved menus and plates are kept.</p>
          <p className="mt-1 text-sm">Breakfast, lunch, and dinner times are set on the Menu Schedule page.</p>
        </div>

        <div className="space-y-3">
          <h2 className="text-4xl font-semibold leading-tight">Special events</h2>
          <p>Add days with different crowds, like football games. They show on the Menu Schedule calendar.</p>
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
          <PrimaryButton type="button" onClick={save} disabled={namedHalls.length === 0}>
            Save settings
          </PrimaryButton>
          {saved && (
            <p role="status" className="font-semibold">
              Saved.
            </p>
          )}
        </div>
      </Card>

      <Card>
        <h2 className="text-4xl font-semibold leading-tight">Download</h2>
        <p className="mt-1">The last 30 days as a spreadsheet, one row per food per meal.</p>
        <div className="mt-3">
          <GhostButton type="button" onClick={exportCsv} disabled={exporting}>
            {exporting ? 'Preparing' : 'Download last 30 days'}
          </GhostButton>
        </div>
      </Card>
    </div>
  )
}
