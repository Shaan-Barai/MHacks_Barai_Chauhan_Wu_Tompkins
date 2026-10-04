/**
 * Three summary cards (UI.md): Today / This week / This month, number in waste
 * units + small ↑/↓ vs the previous period (the arrow shows the direction).
 */
import { useId } from 'react'
import type { PeriodSummary, SummaryCards as SummaryCardsData } from '../data/types'
import { formatCompact, formatDeltaPercent, formatNumber } from '../lib/format'
import { Card, InfoTip, WASTE_UNITS_EXPLANATION } from './ui'

function Delta({ summary }: { summary: PeriodSummary }) {
  const prev = summary.previousWasteUnits
  const delta = prev !== null ? formatDeltaPercent(summary.wasteUnits, prev) : null
  if (prev === null || delta === null) {
    return <p className="mt-1 text-sm text-thyme">No previous period to compare</p>
  }
  const up = summary.wasteUnits > prev
  const flat = delta === '0%'
  return (
    <p className={`mt-1 text-sm font-semibold ${flat ? 'text-thyme' : up ? 'text-tomato' : 'text-basil'}`}>
      <span aria-hidden="true">{flat ? '→' : up ? '↑' : '↓'} </span>
      {delta}
      <span className="font-normal text-thyme"> vs previous period</span>
      <span className="sr-only">{up ? ' (waste went up)' : flat ? '' : ' (waste went down)'}</span>
    </p>
  )
}

function SummaryCard({ label, summary }: { label: string; summary: PeriodSummary }) {
  const tipId = useId()
  return (
    <Card>
      <h3 className="text-base font-medium text-thyme">
        {label}
        <InfoTip id={tipId} text={WASTE_UNITS_EXPLANATION} />
      </h3>
      <p className="mt-1 font-display text-[44px] font-semibold leading-none text-ink" title={`${formatNumber(summary.wasteUnits)} waste units`}>
        {formatCompact(summary.wasteUnits)}
      </p>
      <p className="mt-1 text-sm text-thyme">waste units (AI estimate)</p>
      <Delta summary={summary} />
    </Card>
  )
}

export function SummaryCardsRow({ data }: { data: SummaryCardsData }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <SummaryCard label="Today's waste" summary={data.today} />
      <SummaryCard label="This week's waste" summary={data.thisWeek} />
      <SummaryCard label="This month's waste" summary={data.thisMonth} />
    </div>
  )
}
