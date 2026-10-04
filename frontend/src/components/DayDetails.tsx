/**
 * One day on the Schedule tab: that day's meal times and events, then per
 * meal what was left on plates and a suggestion grounded in those numbers.
 */
import { useId, useState } from 'react'
import { getMealDetail } from '../data/api'
import type { HallSettings, IsoDate, MealDetail, MealLabel } from '../data/types'
import { MEALS, MEAL_NAME } from '../data/types'
import { formatLong } from '../lib/dates'
import { formatNumber, formatPercent } from '../lib/format'
import { plainText } from '../lib/text'
import { useAsync } from '../lib/useAsync'
import { timeSetFor } from '../state/settings'
import { Badge, Card, EmptyState, InfoTip, LoadingBlock, PIXELS_WASTED_EXPLANATION } from './ui'
import { PortionBenchmarkView } from './PortionBenchmark'
import { ESTIMATE_EXPLANATION, PhysicalChips, hasPhysical } from './PhysicalChips'

function clock(t: string): string {
  const [h, m] = t.split(':').map(Number)
  const suffix = h >= 12 ? 'pm' : 'am'
  const hour = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${hour}${suffix}` : `${hour}:${String(m).padStart(2, '0')}${suffix}`
}

export function DayDetails({ date, settings, dataRevision = 0 }: { date: IsoDate; settings: HallSettings; dataRevision?: number }) {
  const [meal, setMeal] = useState<MealLabel>('lunch')
  const detail = useAsync(() => getMealDetail(date, meal), [date, meal, dataRevision])
  const set = timeSetFor(settings, date)
  const events = settings.events.filter((e) => e.date === date)

  return (
    <Card>
      <h2 className="font-display text-2xl font-semibold text-ink">{formatLong(date)}</h2>
      <p className="mt-1 text-base">
        {set
          ? MEALS.map((m) => `${MEAL_NAME[m]} ${clock(set.meals[m].start)} to ${clock(set.meals[m].end)}`).join(' · ')
          : 'No meal times set for this day. Add them in Settings.'}
      </p>
      {events.map((e) => (
        <p key={e.id} className="mt-1 text-base font-semibold">
          {e.name}: {clock(e.start)} to {clock(e.end)}
        </p>
      ))}

      <div role="tablist" aria-label="Meal" className="mt-4 flex max-w-md border border-ink">
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

      <div className="mt-4" role="tabpanel" aria-label={`${MEAL_NAME[meal]} details`}>
        {detail.status === 'loading' && <LoadingBlock label={`Loading ${MEAL_NAME[meal].toLowerCase()}`} />}
        {detail.status === 'error' && <EmptyState title="Couldn't load this meal.">{detail.error}</EmptyState>}
        {detail.status === 'ready' && detail.data === null && (
          <EmptyState title={`No plates were scanned at ${MEAL_NAME[meal].toLowerCase()}.`}>
            If this meal has no menu yet, add one in Menus.
          </EmptyState>
        )}
        {detail.status === 'ready' && detail.data !== null && <MealView detail={detail.data} />}
      </div>
    </Card>
  )
}

function MealView({ detail }: { detail: MealDetail }) {
  const unitsTip = useId()
  const skippedTip = useId()
  const swipesTip = useId()
  const estTip = useId()
  const anyEstimate = detail.items.some(hasPhysical)
  const meal = MEAL_NAME[detail.meal].toLowerCase()
  const [top, ...rest] = detail.items
  const showBenchmark = detail.portionBenchmark?.items.some((i) => i.pixelsWastedPerPortion !== null)

  return (
    <div className="space-y-5">
      <h3 className="text-xl font-semibold">
        {top
          ? `${top.displayName} was the most wasted food at ${meal}.`
          : `Plates were scanned at ${meal}, but no food could be measured.`}
      </h3>

      <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-base">
        <dt>
          Pixels wasted
          <InfoTip id={unitsTip} text={PIXELS_WASTED_EXPLANATION} />
        </dt>
        <dd className="text-right font-semibold">{formatNumber(detail.pixelsWasted)}</dd>
        <dt>Plates scanned</dt>
        <dd className="text-right font-semibold">{formatNumber(detail.platesScanned)}</dd>
        {detail.coverage.emptyPlates > 0 && (
          <>
            <dt>Clean plates</dt>
            <dd className="text-right font-semibold">{formatNumber(detail.coverage.emptyPlates)}</dd>
          </>
        )}
        {detail.coverage.platesLeftOut > 0 && (
          <>
            <dt>
              Not counted
              <InfoTip
                id={skippedTip}
                text="Plates the photo check could not finish, only partly outlined, or is still working on. They are left out, not counted as zero."
              />
            </dt>
            <dd className="text-right font-semibold">
              {detail.coverage.platesLeftOut} plate{detail.coverage.platesLeftOut === 1 ? '' : 's'}
            </dd>
          </>
        )}
        {detail.unclassifiedPixels > 0 && (
          <>
            <dt>Food not on the menu</dt>
            <dd className="text-right font-semibold">{formatNumber(detail.unclassifiedPixels)} pixels</dd>
          </>
        )}
        <dt>
          Meal swipes
          <InfoTip id={swipesTip} text="A made-up number for the demo, not real swipe data." />
        </dt>
        <dd className="flex items-center justify-end gap-2 font-semibold">
          {formatNumber(detail.mealSwipes.count)} <Badge>simulated</Badge>
        </dd>
      </dl>

      {top && (
        <div>
          <h4 className="text-base font-semibold">Left on plates</h4>
          {anyEstimate && (
            <p className="text-sm">
              Grams, CO2e and water are estimates (est.).
              <InfoTip id={estTip} text={ESTIMATE_EXPLANATION} />
            </p>
          )}
          <ol className="mt-2 max-w-2xl divide-y divide-ink border-y border-ink">
            {[top, ...rest].map((item) => (
              <li key={item.itemId} className="flex flex-wrap justify-between gap-x-3 gap-y-1 py-2">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>{item.displayName}</span>
                  {anyEstimate && <PhysicalChips amounts={item} />}
                </span>
                <span className="whitespace-nowrap">
                  {formatNumber(item.pixelsWasted)} pixels, {formatPercent(item.shareOfMealPixelsPercent)} of the meal's wasted pixels
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {detail.tip && (
        <div className="max-w-xl border border-ink p-4">
          <h4 className="text-base font-semibold">
            Suggestion <span className="font-normal">({detail.tip.source === 'gemini' ? 'written by AI' : 'basic rule, AI unavailable'})</span>
          </h4>
          <p className="mt-1 text-base leading-snug">{plainText(detail.tip.recommendation)}</p>
        </div>
      )}

      {showBenchmark && detail.portionBenchmark && <PortionBenchmarkView benchmark={detail.portionBenchmark} />}
    </div>
  )
}
