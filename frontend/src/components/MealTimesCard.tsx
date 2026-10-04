/**
 * Breakfast, lunch, and dinner hours for each set of days (e.g. weekdays and
 * weekends), on the Menu Schedule page. Saved with the hall settings.
 */
import { useState } from 'react'
import type { HallSettings, MealTimeSet, Weekday } from '../data/types'
import { WEEKDAYS, WEEKDAY_NAME } from '../data/types'
import { DEFAULT_SETTINGS, newId } from '../state/settings'
import { MealTimesFields } from './MealTimesFields'
import { Card, FieldLabel, GhostButton, PrimaryButton, inputClass } from './ui'

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

export function MealTimesCard({ settings, onSave }: { settings: HallSettings; onSave: (next: HallSettings) => void }) {
  const [timeSets, setTimeSets] = useState<MealTimeSet[]>(settings.timeSets)
  const [saved, setSaved] = useState(false)
  const edit = (next: MealTimeSet[]) => {
    setTimeSets(next)
    setSaved(false)
  }
  const unassigned = WEEKDAYS.filter((d) => !timeSets.some((t) => t.days.includes(d)))
  const doubled = WEEKDAYS.filter((d) => timeSets.filter((t) => t.days.includes(d)).length > 1)

  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold text-ink">Meal times</h2>
      <p>When breakfast, lunch, and dinner run. Set different hours for different days, like weekdays and weekends.</p>
      {timeSets.map((set, i) => (
        <TimeSetEditor
          key={set.id}
          set={set}
          onChange={(next) => edit(timeSets.map((t, j) => (j === i ? next : t)))}
          onRemove={timeSets.length > 1 ? () => edit(timeSets.filter((_, j) => j !== i)) : undefined}
        />
      ))}
      {unassigned.length > 0 && <p>No meal times for: {unassigned.map((d) => WEEKDAY_NAME[d]).join(', ')}.</p>}
      {doubled.length > 0 && (
        <p>
          {doubled.map((d) => WEEKDAY_NAME[d]).join(', ')} {doubled.length === 1 ? 'is' : 'are'} in more than one set. The first set is used.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <GhostButton
          type="button"
          onClick={() => edit([...timeSets, { id: newId('set'), name: '', days: unassigned, meals: DEFAULT_SETTINGS.timeSets[0].meals }])}
        >
          Add meal times for other days
        </GhostButton>
        <PrimaryButton
          type="button"
          onClick={() => {
            onSave({ ...settings, timeSets })
            setSaved(true)
          }}
        >
          Save meal times
        </PrimaryButton>
        {saved && (
          <p role="status" className="font-semibold">
            Saved.
          </p>
        )}
      </div>
    </Card>
  )
}
