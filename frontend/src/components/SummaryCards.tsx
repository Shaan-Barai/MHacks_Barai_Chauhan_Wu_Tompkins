/**
 * Three summary cards: today, this week, this month. Each shows the waste
 * score (or Pixels wasted from real scans), plates scanned or the average
 * share of a serving left per plate (clean plates count as 0%), and the
 * change from the same stretch of time before.
 */
import { useId } from 'react'
import type { PeriodSummary, SummaryCards as SummaryCardsData } from '../data/types'
import { formatCompact, formatNumber, formatPercent } from '../lib/format'
import { Card, InfoTip, PIXELS_WASTED_EXPLANATION, WASTE_SCORE_EXPLANATION } from './ui'

export type SummaryUnit = 'score' | 'pixels'
const UNIT_NAME: Record<SummaryUnit, string> = { score: 'Waste score', pixels: 'Pixels wasted' }
const UNIT_TIP: Record<SummaryUnit, string> = { score: WASTE_SCORE_EXPLANATION, pixels: PIXELS_WASTED_EXPLANATION }

const PLATE_PERCENT_EXPLANATION =
  'For each scanned plate, how much of a full serving came back. Clean plates count as 0%. A food with more than a full serving left counts as 100%.'

function Change({ summary, before }: { summary: PeriodSummary; before: string }) {
  const prev = summary.previousPixelsWasted
  if (prev === null || prev <= 0) {
    return <p className="mt-1 text-sm">Nothing to compare with {before} yet</p>
  }
  const pct = Math.round(((summary.pixelsWasted - prev) / prev) * 100)
  if (pct === 0) return <p className="mt-1 text-sm">Same as {before}</p>
  return (
    <p className="mt-1 text-sm">
      <span className="font-semibold">
        {pct > 0 ? 'Up' : 'Down'} {Math.abs(pct)}%
      </span>{' '}
      from {before}
    </p>
  )
}

function SummaryCard({ label, before, summary, unit }: { label: string; before: string; summary: PeriodSummary; unit: SummaryUnit }) {
  const unitsTip = useId()
  const plateTip = useId()
  return (
    <Card>
      <h3 className="text-base font-semibold text-ink">{label}</h3>
      <p className="mt-2 font-display text-[44px] font-semibold leading-none text-ink" title={`${UNIT_NAME[unit]}: ${formatNumber(summary.pixelsWasted)}`}>
        {formatCompact(summary.pixelsWasted)}
      </p>
      <p className="mt-1 text-sm">
        {UNIT_NAME[unit]}
        <InfoTip id={unitsTip} text={UNIT_TIP[unit]} />
      </p>
      {summary.averagePlateWastePercent !== null ? (
        <>
          <p className="mt-3 text-lg font-semibold">
            {formatPercent(summary.averagePlateWastePercent)} left per plate
            <InfoTip id={plateTip} text={PLATE_PERCENT_EXPLANATION} />
          </p>
          <p className="text-sm">
            Average of {formatNumber(summary.platesCounted)} plate{summary.platesCounted === 1 ? '' : 's'}
          </p>
        </>
      ) : (
        <p className="mt-3 text-lg font-semibold">
          {summary.platesCounted > 0
            ? `${formatNumber(summary.platesCounted)} plate${summary.platesCounted === 1 ? '' : 's'} scanned`
            : 'No plates scanned'}
        </p>
      )}
      <Change summary={summary} before={before} />
    </Card>
  )
}

export function SummaryCardsRow({ data, unit = 'pixels' }: { data: SummaryCardsData; unit?: SummaryUnit }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <SummaryCard label="Today" before="the day before" summary={data.today} unit={unit} />
      <SummaryCard label="This week" before="the same days last week" summary={data.thisWeek} unit={unit} />
      <SummaryCard label="This month" before="the same days last month" summary={data.thisMonth} unit={unit} />
    </div>
  )
}
