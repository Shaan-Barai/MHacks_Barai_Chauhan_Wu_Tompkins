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

/** Rounded percent change from the period before, or null with nothing to compare. */
function changePercent(summary: PeriodSummary): number | null {
  const prev = summary.previousPixelsWasted
  return prev === null || prev <= 0 ? null : Math.round(((summary.pixelsWasted - prev) / prev) * 100)
}

/** Less waste than before is green, more is red; no change or nothing to compare stays black. */
function trendColor(pct: number | null): string {
  return pct === null || pct === 0 ? 'text-ink' : pct < 0 ? 'text-good' : 'text-bad'
}

function Change({ pct, before }: { pct: number | null; before: string }) {
  if (pct === null) return <p className="mt-1 text-sm">Nothing to compare with {before} yet</p>
  if (pct === 0) return <p className="mt-1 text-sm">Same as {before}</p>
  return (
    <p className="mt-1 text-sm">
      <span className={`font-semibold ${trendColor(pct)}`}>
        {pct > 0 ? 'Up' : 'Down'} {Math.abs(pct)}%
      </span>{' '}
      from {before}
    </p>
  )
}

function SummaryCard({ label, before, summary, unit }: { label: string; before: string; summary: PeriodSummary; unit: SummaryUnit }) {
  const unitsTip = useId()
  const plateTip = useId()
  const pct = changePercent(summary)
  return (
    <Card>
      <h3 className="text-base font-semibold text-ink">{label}</h3>
      <p className={`mt-2 font-display text-[44px] font-semibold leading-none ${trendColor(pct)}`} title={`${UNIT_NAME[unit]}: ${formatNumber(summary.pixelsWasted)}`}>
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
      <Change pct={pct} before={before} />
    </Card>
  )
}

/**
 * 'calendar': this week and this month so far (the backend's cards).
 * 'rolling': the last 7 and last 30 days (demo numbers).
 */
export type SummaryPeriods = 'calendar' | 'rolling'

const PERIOD_TEXT: Record<SummaryPeriods, { week: [string, string]; month: [string, string] }> = {
  calendar: { week: ['This week', 'the same days last week'], month: ['This month', 'the same days last month'] },
  rolling: { week: ['Last 7 days', 'the 7 days before'], month: ['Last 30 days', 'the 30 days before'] },
}

export function SummaryCardsRow({
  data,
  unit = 'pixels',
  periods = 'calendar',
}: {
  data: SummaryCardsData
  unit?: SummaryUnit
  periods?: SummaryPeriods
}) {
  const { week, month } = PERIOD_TEXT[periods]
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <SummaryCard label="Today" before="the day before" summary={data.today} unit={unit} />
      <SummaryCard label={week[0]} before={week[1]} summary={data.thisWeek} unit={unit} />
      <SummaryCard label={month[0]} before={month[1]} summary={data.thisMonth} unit={unit} />
    </div>
  )
}
