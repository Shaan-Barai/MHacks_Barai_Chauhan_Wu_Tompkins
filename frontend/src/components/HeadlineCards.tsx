/**
 * Headline cards for the selected days: estimated carbon emissions, water and
 * food weight (calibrated plates only, IT_4), and plates scanned. No "est."
 * badge (product owner, 2026-10-04); a missing value shows a dash, never 0.
 */
import type { ImpactDashboard } from '../data/types'
import { formatKgCo2e, formatLitres, formatMass, formatNumber } from '../lib/format'
import { splitUnit } from './impactCopy'
import { Card } from './ui'

function HeadlineCard({ title, formatted }: { title: string; formatted: string | null }) {
  const [value, unit] = formatted === null ? ['—', ''] : splitUnit(formatted)
  return (
    <Card className="flex flex-col">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      <p className="mt-3 text-ink" aria-label={`${title}: ${formatted ?? 'not available'}`}>
        <span className="text-4xl font-bold leading-none tracking-tight">{value}</span>
        {unit && <span className="ml-1.5 text-lg font-medium">{unit}</span>}
      </p>
    </Card>
  )
}

export function HeadlineCards({ data }: { data: ImpactDashboard }) {
  const t = data.totals
  return (
    <section aria-label="Totals for the selected days" className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <HeadlineCard title="Carbon emissions" formatted={t.kgCo2e == null ? null : formatKgCo2e(t.kgCo2e)} />
      <HeadlineCard title="Water" formatted={t.waterLitres == null ? null : formatLitres(t.waterLitres)} />
      <HeadlineCard title="Food wasted" formatted={t.grams == null ? null : formatMass(t.grams)} />
      <HeadlineCard title="Plates scanned" formatted={`${formatNumber(t.analyzedCaptures)} plates`} />
    </section>
  )
}
