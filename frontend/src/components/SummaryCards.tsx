/**
 * Three summary cards: today, this week, this month. Each shows Pixels wasted,
 * the average share of a serving left per plate (clean plates count as 0%),
 * and the change from the same stretch of time before.
 */
import { useId } from 'react'
import type { PeriodSummary, SummaryCards as SummaryCardsData } from '../data/types'
import { formatCompact, formatNumber, formatPercent } from '../lib/format'
import { Card, InfoTip, PIXELS_WASTED_EXPLANATION } from './ui'

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

function SummaryCard({ label, before, summary }: { label: string; before: string; summary: PeriodSummary }) {
  const unitsTip = useId()
  const plateTip = useId()
  return (
    <Card>
      <h3 className="text-base font-semibold text-ink">{label}</h3>
      <p className="mt-2 font-display text-[44px] font-semibold leading-none text-ink" title={`${formatNumber(summary.pixelsWasted)} pixels wasted`}>
        {formatCompact(summary.pixelsWasted)}
      </p>
      <p className="mt-1 text-sm">
        Pixels wasted
        <InfoTip id={unitsTip} text={PIXELS_WASTED_EXPLANATION} />
      </p>
      <p className="mt-3 text-lg font-semibold">
        {summary.averagePlateWastePercent === null
          ? 'No plates scanned'
          : `${formatPercent(summary.averagePlateWastePercent)} left per plate`}
        <InfoTip id={plateTip} text={PLATE_PERCENT_EXPLANATION} />
      </p>
      {summary.platesCounted > 0 && (
        <p className="text-sm">
          Average of {formatNumber(summary.platesCounted)} plate{summary.platesCounted === 1 ? '' : 's'}
        </p>
      )}
      <Change summary={summary} before={before} />
    </Card>
  )
}

export function SummaryCardsRow({ data }: { data: SummaryCardsData }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <SummaryCard label="Today" before="the day before" summary={data.today} />
      <SummaryCard label="This week" before="the same days last week" summary={data.thisWeek} />
      <SummaryCard label="This month" before="the same days last month" summary={data.thisMonth} />
    </div>
  )
}
