/**
 * Right column (UI.md "Yesterday's details"): header with the date, meal tabs,
 * per-meal big total + plates scanned + meal swipes (simulated), the most
 * wasted item with an AI tip, and the next 4 items with severity dots.
 */
import { useId, useState } from 'react'
import { getMealDetail } from '../data/api'
import type { IsoDate, MealLabel } from '../data/types'
import { MEALS, MEAL_NAME } from '../data/types'
import { formatLong } from '../lib/dates'
import { formatNumber, formatPercent } from '../lib/format'
import { SEVERITY_DOT_CLASS, SEVERITY_LABEL, severityFor } from '../lib/severity'
import { useAsync } from '../lib/useAsync'
import { Badge, EmptyState, InfoTip, LoadingBlock, WASTE_UNITS_EXPLANATION } from './ui'

export function RightPanel({ date, isYesterday }: { date: IsoDate; isYesterday: boolean }) {
  const [meal, setMeal] = useState<MealLabel>('lunch')
  const detail = useAsync(() => getMealDetail(date, meal), [date, meal])
  const totalTipId = useId()
  const swipesTipId = useId()
  const coverageTipId = useId()

  return (
    <aside className="w-[21rem] shrink-0 overflow-y-auto border-l border-linen bg-cream p-5" aria-label="Day details">
      <h2 className="font-display text-xl font-semibold text-ink">
        {isYesterday ? 'Yesterday, ' : ''}
        {formatLong(date)}
      </h2>

      {/* Breakfast | Lunch | Dinner tabs */}
      <div role="tablist" aria-label="Meal" className="mt-4 flex rounded-btn border border-linen bg-oat p-1">
        {MEALS.map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={meal === m}
            onClick={() => setMeal(m)}
            className={`flex-1 rounded-[6px] px-2 py-1.5 text-base transition-colors ${
              meal === m ? 'bg-basil font-semibold text-cream' : 'text-ink hover:bg-basil-tint'
            }`}
          >
            {MEAL_NAME[m]}
          </button>
        ))}
      </div>

      <div className="mt-4" role="tabpanel" aria-label={`${MEAL_NAME[meal]} details`}>
        {detail.status === 'loading' && <LoadingBlock label={`Loading ${MEAL_NAME[meal].toLowerCase()}…`} />}
        {detail.status === 'error' && <EmptyState title="Couldn't load this meal.">{detail.error}</EmptyState>}
        {detail.status === 'ready' && detail.data === null && (
          <EmptyState title="No data for this meal yet.">
            If the day is missing a menu, add one in Menus. Data appears once plates are scanned.
          </EmptyState>
        )}
        {detail.status === 'ready' && detail.data !== null && <MealDetailView detail={detail.data} totalTipId={totalTipId} swipesTipId={swipesTipId} coverageTipId={coverageTipId} />}
      </div>
    </aside>
  )
}

function MealDetailView({
  detail,
  totalTipId,
  swipesTipId,
  coverageTipId,
}: {
  detail: NonNullable<Awaited<ReturnType<typeof getMealDetail>>>
  totalTipId: string
  swipesTipId: string
  coverageTipId: string
}) {
  const top = detail.items[0]
  const rest = detail.items.slice(1, 5)
  return (
    <div className="space-y-5">
      {/* Big total + coverage numbers */}
      <div>
        <p className="font-display text-[40px] font-semibold leading-none text-ink">{formatNumber(detail.totalWasteUnits)}</p>
        <p className="mt-1 text-base text-thyme">
          waste units (AI estimate)
          <InfoTip id={totalTipId} text={WASTE_UNITS_EXPLANATION} />
        </p>
        <dl className="mt-3 space-y-1 text-base">
          <div className="flex justify-between">
            <dt className="text-thyme">Plates scanned</dt>
            <dd className="font-medium text-ink">{formatNumber(detail.platesScanned)}</dd>
          </div>
          {(detail.coverage.platesLeftOut > 0 || detail.coverage.itemsLeftOut > 0) && (
            <div className="flex justify-between">
              <dt className="text-thyme">
                Left out of totals
                <InfoTip
                  id={coverageTipId}
                  text="Plates whose analysis failed or needs review, and foods the AI couldn't match to the menu or measured above a full serving. They are left out instead of being counted as zero waste."
                />
              </dt>
              <dd className="font-medium text-ink">
                {detail.coverage.platesLeftOut > 0 &&
                  `${formatNumber(detail.coverage.platesLeftOut)} plate${detail.coverage.platesLeftOut === 1 ? '' : 's'}`}
                {detail.coverage.platesLeftOut > 0 && detail.coverage.itemsLeftOut > 0 && ', '}
                {detail.coverage.itemsLeftOut > 0 &&
                  `${formatNumber(detail.coverage.itemsLeftOut)} item${detail.coverage.itemsLeftOut === 1 ? '' : 's'}`}
              </dd>
            </div>
          )}
          <div className="flex items-center justify-between">
            <dt className="text-thyme">
              Meal swipes
              <InfoTip id={swipesTipId} text="Simulated attendance for the prototype — not real swipe data." />
            </dt>
            <dd className="flex items-center gap-2 font-medium text-ink">
              {formatNumber(detail.mealSwipes.count)} <Badge>simulated</Badge>
            </dd>
          </div>
        </dl>
      </div>

      {!top && (
        <EmptyState title="No waste totals for this meal yet.">
          {detail.platesScanned === 0
            ? 'Data appears once plates are scanned.'
            : 'Plates were scanned, but every food estimate was left out of the totals (for example, the AI measured more than a full serving, or couldn\'t match the food to the menu). Nothing is counted as zero waste.'}
        </EmptyState>
      )}

      {/* Most wasted + Gemini-style tip */}
      {top && (
      <div>
        <h3 className="text-base font-semibold text-ink">Most wasted</h3>
        <div className="mt-2 rounded-card border border-linen bg-oat p-4">
          <p className="text-lg font-semibold text-ink">{top.displayName}</p>
          <p className="text-base text-thyme">
            {formatNumber(top.wasteUnits)} waste units · {formatPercent(top.shareOfMealWastePercent)} of meal waste
          </p>
          {detail.tip && (
          <div className="mt-3 rounded-btn border border-basil-tint bg-basil-tint/60 p-3">
            <p className="text-sm font-semibold uppercase tracking-wide text-basil">
              {detail.tip.source === 'gemini' ? (
                <>
                  <span aria-hidden="true">✦ </span>Gemini tip · AI-generated
                </>
              ) : (
                'Tip · rule-based (AI unavailable)'
              )}
            </p>
            <p className="mt-1 text-base leading-snug text-ink">{detail.tip.recommendation}</p>
          </div>
          )}
        </div>
      </div>
      )}

      {/* Next 4 most wasted with severity dots */}
      {rest.length > 0 && (
        <div>
          <h3 className="text-base font-semibold text-ink">Also wasted</h3>
          <ul className="mt-2 divide-y divide-linen">
            {rest.map((item) => {
              const sev = severityFor(item.shareOfMealWastePercent)
              return (
                <li key={item.itemId} className="flex items-center gap-3 py-2.5">
                  <span
                    className={`h-3 w-3 shrink-0 rounded-full ${SEVERITY_DOT_CLASS[sev]}`}
                    role="img"
                    aria-label={`${SEVERITY_LABEL[sev]} share of meal waste`}
                  />
                  <span className="min-w-0 flex-1 truncate text-base text-ink">{item.displayName}</span>
                  <span className="whitespace-nowrap text-sm text-thyme">
                    {formatNumber(item.wasteUnits)} units · {formatPercent(item.shareOfMealWastePercent)}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
