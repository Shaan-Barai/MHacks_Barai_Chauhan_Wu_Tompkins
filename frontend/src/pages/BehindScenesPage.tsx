/**
 * Behind the scenes: every scanned plate photo for a meal, with the labels the
 * AI gave each food. Photo links are short-lived, so a broken image asks for a
 * fresh link once.
 */
import { useEffect, useState } from 'react'
import { getImageUrl, getPlates } from '../data/api'
import type { MealLabel, PlateFood, PlateRecord } from '../data/types'
import { MEALS, MEAL_NAME } from '../data/types'
import { todayIso } from '../lib/dates'
import { formatNumber, formatPercent } from '../lib/format'
import { useAsync } from '../lib/useAsync'
import { Card, EmptyState, FieldLabel, LoadingBlock, inputClass } from '../components/ui'

const STATE_TEXT: Record<PlateRecord['state'], string> = {
  pending: 'Waiting to be checked',
  processing: 'Being checked',
  succeeded: 'Checked',
  needs_review: 'Needs a person to look',
  failed: 'Check failed',
}

function note(food: PlateFood): string {
  const notes: string[] = []
  if (food.itemId === null) notes.push('Not on the menu')
  if (food.flags.includes('above_baseline')) notes.push('More than a full serving left')
  if (food.flags.includes('ai_estimate')) notes.push('AI estimate')
  return notes.join('. ')
}

function PlatePhoto({ objectId, alt }: { objectId: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [retried, setRetried] = useState(false)

  useEffect(() => {
    let alive = true
    getImageUrl(objectId)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [objectId])

  const renew = () => {
    if (retried) return setFailed(true)
    setRetried(true)
    getImageUrl(objectId).then(setUrl).catch(() => setFailed(true))
  }

  if (failed) return <div className="flex aspect-square w-full items-center justify-center border border-dashed border-ink p-4 text-center">Photo unavailable</div>
  if (!url) return <div className="flex aspect-square w-full items-center justify-center border border-ink">Loading photo</div>
  return <img src={url} alt={alt} onError={renew} className="aspect-square w-full border border-ink object-cover" />
}

export function BehindScenesPage() {
  const [date, setDate] = useState(todayIso)
  const [meal, setMeal] = useState<MealLabel>('lunch')
  const plates = useAsync(() => getPlates(date, meal), [date, meal])

  return (
    <div className="space-y-5">
      <h1 className="font-display text-3xl font-semibold text-ink">Behind the scenes</h1>
      <p className="max-w-2xl text-base">
        Every plate photo we scanned, with the foods the AI found on it and how much was left. Use it to check the numbers
        on the other pages.
      </p>
      <Card>
        <div className="flex flex-wrap gap-4">
          <div>
            <FieldLabel htmlFor="bts-date">Date</FieldLabel>
            <input id="bts-date" type="date" className={inputClass} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </div>
          <div>
            <FieldLabel htmlFor="bts-meal">Meal</FieldLabel>
            <select id="bts-meal" className={inputClass} value={meal} onChange={(e) => setMeal(e.target.value as MealLabel)}>
              {MEALS.map((m) => (
                <option key={m} value={m}>
                  {MEAL_NAME[m]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      {plates.status === 'loading' && <LoadingBlock label="Loading plates" />}
      {plates.status === 'error' && <EmptyState title="Couldn't load plates.">{plates.error}</EmptyState>}
      {plates.status === 'ready' && plates.data.length === 0 && (
        <EmptyState title={`No plates were scanned at ${MEAL_NAME[meal].toLowerCase()} on this day.`} />
      )}
      {plates.status === 'ready' && plates.data.length > 0 && (
        <ul className="grid gap-5 lg:grid-cols-2">
          {plates.data.map((plate, n) => (
            <li key={plate.eventId}>
              <Card className="grid gap-4 sm:grid-cols-[12rem_1fr]">
                <PlatePhoto objectId={plate.imageObjectId} alt={`Plate ${n + 1} at ${MEAL_NAME[meal].toLowerCase()}`} />
                <div>
                  <h2 className="text-lg font-semibold">
                    Plate {n + 1}:{' '}
                    {plate.plateWastePercent === null ? 'no percent' : `${formatPercent(plate.plateWastePercent)} left`}
                  </h2>
                  <p className="text-sm">
                    {new Date(plate.capturedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ·{' '}
                    {STATE_TEXT[plate.state]} · {plate.source === 'replay' ? 'Demo photo' : 'Camera'}
                  </p>
                  {plate.foods.length === 0 ? (
                    <p className="mt-3">{plate.state === 'succeeded' ? 'Clean plate. No food left.' : 'No labels yet.'}</p>
                  ) : (
                    <table className="mt-3 w-full text-left text-sm">
                      <caption className="sr-only">Foods found on plate {n + 1}</caption>
                      <thead>
                        <tr className="border-b border-ink">
                          <th scope="col" className="py-1 pr-2">Food</th>
                          <th scope="col" className="py-1 pr-2">Units left</th>
                          <th scope="col" className="py-1 pr-2">Of a serving</th>
                          <th scope="col" className="py-1">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plate.foods.map((f, i) => (
                          <tr key={i} className="border-b border-ink align-top">
                            <th scope="row" className="py-1 pr-2 font-semibold">{f.name}</th>
                            <td className="py-1 pr-2">{formatNumber(f.wasteUnits)}</td>
                            <td className="py-1 pr-2">{f.percentOfServing === null ? 'Not known' : formatPercent(f.percentOfServing)}</td>
                            <td className="py-1">{note(f)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
