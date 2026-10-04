/**
 * Total waste for today, this week (Monday to today) and this month (1st to
 * today), in pixels: the headline measurement. Pixels are the area of
 * leftover food the AI outlined, not a weight. When the period has plates
 * from a calibrated camera, the estimated grams / CO2e / water follow,
 * labeled est.
 */
import type { WasteTotal, WasteTotals } from '../data/types'
import { formatKgCo2e, formatLitres, formatMass, formatNumber, formatPoints } from '../lib/format'
import { Badge, Card } from './ui'

const PERIODS: Array<{ key: keyof WasteTotals; title: string }> = [
  { key: 'today', title: 'Today' },
  { key: 'week', title: 'This week' },
  { key: 'month', title: 'This month' },
]

function Period({ title, total }: { title: string; total: WasteTotal }) {
  return (
    <Card className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-ink">{title}</h3>
        {total.sampleCaptures > 0 && <Badge>includes sample data</Badge>}
      </div>
      <p className="mt-2 text-ink" aria-label={`${title}: ${formatNumber(total.pixels)} pixels wasted`}>
        <span className="font-display text-4xl font-semibold leading-none">{formatNumber(total.pixels)}</span>
        <span className="ml-1.5 text-lg font-semibold">pixels</span>
      </p>
      <p className="mt-1 text-sm">
        {total.analyzedCaptures === 0
          ? 'No plates counted yet'
          : `From ${formatNumber(total.analyzedCaptures)} plate${total.analyzedCaptures === 1 ? '' : 's'}`}
        {total.impactPoints != null && total.analyzedCaptures > 0 && ` · ${formatPoints(total.impactPoints)} impact points`}
      </p>
      {total.estimated && (
        <p className="mt-1 text-sm" aria-label={`${title} estimate`}>
          About {formatMass(total.estimated.grams)}
          {total.estimated.kgCo2e != null && ` · ${formatKgCo2e(total.estimated.kgCo2e)}`}
          {total.estimated.waterLitres != null && ` · ${formatLitres(total.estimated.waterLitres)} water`} est. (
          {formatNumber(total.estimated.calibratedCaptures)} calibrated plate{total.estimated.calibratedCaptures === 1 ? '' : 's'})
        </p>
      )}
    </Card>
  )
}

export function PeriodTotals({ totals }: { totals: WasteTotals }) {
  return (
    <section aria-label="Total waste today, this week and this month" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {PERIODS.map((p) => (
        <Period key={p.key} title={p.title} total={totals[p.key]} />
      ))}
    </section>
  )
}
