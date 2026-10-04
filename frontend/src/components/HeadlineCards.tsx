/**
 * Headline cards for the selected days: estimated carbon emissions, water and
 * food weight (calibrated plates only, IT_4), and plates scanned. Estimates
 * carry an "est." badge; a missing estimate shows a dash, never 0.
 */
import type { ImpactDashboard } from '../data/types'
import { formatKgCo2e, formatLitres, formatMass, formatNumber } from '../lib/format'
import { splitUnit } from './impactCopy'
import { Badge, Card } from './ui'

function HeadlineCard({ title, formatted, estimate }: { title: string; formatted: string | null; estimate?: boolean }) {
  const [value, unit] = formatted === null ? ['—', ''] : splitUnit(formatted)
  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        {estimate && formatted !== null && <Badge>est.</Badge>}
      </div>
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
      <HeadlineCard title="Carbon emissions" estimate formatted={t.kgCo2e == null ? null : formatKgCo2e(t.kgCo2e)} />
      <HeadlineCard title="Water" estimate formatted={t.waterLitres == null ? null : formatLitres(t.waterLitres)} />
      <HeadlineCard title="Food wasted" estimate formatted={t.grams == null ? null : formatMass(t.grams)} />
      <HeadlineCard title="Plates scanned" formatted={`${formatNumber(t.analyzedCaptures)} plates`} />
    </section>
  )
}
