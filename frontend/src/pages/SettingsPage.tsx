/** Settings (UI.md): hall name, meal times, export CSV. */
import { useState } from 'react'
import { MealTimesFields } from '../components/MealTimesFields'
import { Card, FieldLabel, GhostButton, PrimaryButton, inputClass } from '../components/ui'
import type { HallSettings } from '../data/types'
import { buildWasteCsv, downloadCsv } from '../lib/csv'
import { todayIso } from '../lib/dates'

export function SettingsPage({
  settings,
  onSave,
}: {
  settings: HallSettings
  onSave: (next: HallSettings) => void
}) {
  const [draft, setDraft] = useState<HallSettings>(settings)
  const [saved, setSaved] = useState(false)
  const [exporting, setExporting] = useState(false)

  const save = () => {
    onSave(draft)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const exportCsv = async () => {
    setExporting(true)
    try {
      const csv = await buildWasteCsv(30)
      downloadCsv(`scrap-waste-${todayIso()}.csv`, csv)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-5">
      <h1 className="font-display text-3xl font-semibold text-ink">Settings</h1>

      <Card>
        <h2 className="text-lg font-semibold text-ink">Dining hall</h2>
        <div className="mt-3">
          <FieldLabel htmlFor="hall-name">Hall name</FieldLabel>
          <input
            id="hall-name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className={inputClass}
          />
        </div>
        <h2 className="mt-5 text-lg font-semibold text-ink">Meal times</h2>
        <div className="mt-3">
          <MealTimesFields value={draft.mealTimes} onChange={(mealTimes) => setDraft({ ...draft, mealTimes })} />
        </div>
        <div className="mt-5 flex items-center gap-3">
          <PrimaryButton type="button" onClick={save}>
            Save settings
          </PrimaryButton>
          {saved && (
            <p role="status" className="text-base font-medium text-basil">
              Saved!
            </p>
          )}
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-ink">Export</h2>
        <p className="mt-1 text-base text-thyme">
          Download the last 30 days as a CSV — one row per item per meal. Pixels wasted are counted inside AI-drawn
          leftover-food outlines; meal swipes are simulated.
        </p>
        <div className="mt-3">
          <GhostButton type="button" onClick={exportCsv} disabled={exporting}>
            {exporting ? 'Preparing CSV…' : 'Export CSV (last 30 days)'}
          </GhostButton>
        </div>
      </Card>
    </div>
  )
}
