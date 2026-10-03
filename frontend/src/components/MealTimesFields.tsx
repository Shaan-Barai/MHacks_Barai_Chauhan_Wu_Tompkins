/** Meal-hours editor shared by setup step 1 and Settings. */
import type { HallSettings, MealLabel } from '../data/types'
import { MEALS, MEAL_NAME } from '../data/types'

export function MealTimesFields({
  value,
  onChange,
}: {
  value: HallSettings['mealTimes']
  onChange: (next: HallSettings['mealTimes']) => void
}) {
  const set = (meal: MealLabel, field: 'start' | 'end', v: string) =>
    onChange({ ...value, [meal]: { ...value[meal], [field]: v } })

  return (
    <div className="space-y-3">
      {MEALS.map((meal) => (
        <fieldset key={meal} className="flex flex-wrap items-center gap-3">
          <legend className="sr-only">{MEAL_NAME[meal]} hours</legend>
          <span className="w-24 text-base font-medium text-ink">{MEAL_NAME[meal]}</span>
          <label className="flex items-center gap-2 text-base text-thyme">
            from
            <input
              type="time"
              value={value[meal].start}
              onChange={(e) => set(meal, 'start', e.target.value)}
              aria-label={`${MEAL_NAME[meal]} start time`}
              className="rounded-btn border border-linen bg-cream px-2 py-1.5 text-base text-ink"
            />
          </label>
          <label className="flex items-center gap-2 text-base text-thyme">
            to
            <input
              type="time"
              value={value[meal].end}
              onChange={(e) => set(meal, 'end', e.target.value)}
              aria-label={`${MEAL_NAME[meal]} end time`}
              className="rounded-btn border border-linen bg-cream px-2 py-1.5 text-base text-ink"
            />
          </label>
        </fieldset>
      ))}
    </div>
  )
}
