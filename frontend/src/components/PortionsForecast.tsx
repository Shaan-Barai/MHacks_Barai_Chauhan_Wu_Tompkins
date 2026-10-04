/**
 * Portions forecasted, on the Menu Schedule page: for the picked date and
 * meal, how many portions of each menu food the staff expect to serve.
 */
import { useId, useState } from 'react'
import { getMenu } from '../data/api'
import type { IsoDate, MealLabel, MenuItemLite } from '../data/types'
import { MEALS, MEAL_NAME } from '../data/types'
import { formatLong } from '../lib/dates'
import { useAsync } from '../lib/useAsync'
import { loadForecast, saveForecast } from '../state/forecasts'
import { Card, EmptyState, InfoTip, LoadingBlock, PrimaryButton, inputClass } from './ui'

export const FORECAST_EXPLANATION =
  'How many portions of each food you plan to serve, entered before the meal. Dining hall staff forecast this ahead of time; it is saved in this browser. Portions actually served are entered on the Portions served page.'

export function PortionsForecast({ hallId, date, menuRevision = 0 }: { hallId: string; date: IsoDate; menuRevision?: number }) {
  const [meal, setMeal] = useState<MealLabel>('lunch')
  const menu = useAsync(() => getMenu(date, hallId), [date, hallId, menuRevision])
  const tip = useId()
  const items = menu.data?.meals[meal] ?? []

  return (
    <Card>
      <h2 className="text-lg font-semibold text-ink">
        Portions forecasted
        <InfoTip id={tip} text={FORECAST_EXPLANATION} />
      </h2>
      <p className="mt-1 text-base">{formatLong(date)}. Pick another day on the calendar below.</p>

      <div role="tablist" aria-label="Meal to forecast" className="mt-3 flex max-w-md border border-ink">
        {MEALS.map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={meal === m}
            onClick={() => setMeal(m)}
            className={`flex-1 px-2 py-1.5 text-base ${meal === m ? 'bg-ink font-semibold text-cream' : 'text-ink hover:underline'}`}
          >
            {MEAL_NAME[m]}
          </button>
        ))}
      </div>

      <div className="mt-4" role="tabpanel" aria-label={`${MEAL_NAME[meal]} forecast`}>
        {menu.status === 'loading' && !menu.data && <LoadingBlock label="Loading menu" />}
        {menu.status === 'error' && <EmptyState title="Couldn't load this day's menu.">{menu.error}</EmptyState>}
        {menu.status !== 'loading' && menu.status !== 'error' && items.length === 0 && (
          <EmptyState title={`No ${MEAL_NAME[meal].toLowerCase()} menu for this day yet.`}>Add the menu above, then forecast its portions here.</EmptyState>
        )}
        {items.length > 0 && <ForecastForm key={`${hallId}|${date}|${meal}|${items.map((i) => i.itemId).join(',')}`} hallId={hallId} date={date} meal={meal} items={items} />}
      </div>
    </Card>
  )
}

function ForecastForm({ hallId, date, meal, items }: { hallId: string; date: IsoDate; meal: MealLabel; items: MenuItemLite[] }) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const saved = loadForecast(hallId, date, meal)
    return Object.fromEntries(items.map((i) => [i.itemId, saved[i.itemId]?.toString() ?? '']))
  })
  const [saved, setSaved] = useState(false)
  const invalid = Object.values(values).some((v) => v.trim() !== '' && !/^\d+$/.test(v.trim()))
  const total = Object.values(values).reduce((sum, v) => sum + (/^\d+$/.test(v.trim()) ? Number(v) : 0), 0)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (invalid) return
        const counts: Record<string, number> = {}
        for (const [id, v] of Object.entries(values)) if (v.trim() !== '') counts[id] = Number(v)
        saveForecast(hallId, date, meal, counts)
        setSaved(true)
      }}
    >
      <table className="w-full max-w-xl text-left text-base">
        <caption className="sr-only">Forecast portions for {MEAL_NAME[meal].toLowerCase()}</caption>
        <thead>
          <tr className="border-b border-ink">
            <th scope="col" className="py-1 pr-3">Food</th>
            <th scope="col" className="py-1">Portions forecasted</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.itemId} className="border-b border-ink">
              <th scope="row" className="py-1.5 pr-3 font-normal">{item.displayName}</th>
              <td className="py-1.5">
                <input
                  aria-label={`Portions forecasted: ${item.displayName}`}
                  inputMode="numeric"
                  placeholder="e.g. 120"
                  value={values[item.itemId] ?? ''}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [item.itemId]: e.target.value }))
                    setSaved(false)
                  }}
                  className={`${inputClass} max-w-[8rem]`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {invalid && (
        <p role="alert" className="mt-2 font-semibold">
          Use whole numbers only, like 120.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <PrimaryButton type="submit" disabled={invalid}>
          Save forecast
        </PrimaryButton>
        <p className="text-base">Total: {total.toLocaleString()} portions</p>
        {saved && (
          <p role="status" className="font-semibold">
            Forecast saved.
          </p>
        )}
      </div>
    </form>
  )
}
