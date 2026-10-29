/**
 * plate-scale-v1: ESTIMATED pounds of food left on scanned plates, beside (never instead of)
 * Pixels wasted. Every assumption is in the tooltip; pounds cover only plates with a plate
 * scale, and the card says how many. Unknown shows "—", never 0.
 */
import type { EstimatedWeight } from '../data/types'
import { formatNumber } from '../lib/format'
import { Card, InfoTip } from './ui'

export function EstimatedPounds({ data }: { data: EstimatedWeight }) {
  const t = data.totals
  const lb = t.estimatedLb
  const value = lb === null ? '—' : lb < 10 ? lb.toFixed(1) : formatNumber(Math.round(lb))
  const sizes = (data.assumedPlateDiametersCm ?? []).map((cm) => `${(cm / 2.54).toFixed(1)}-inch (${cm} cm)`)
  const plateSize = sizes.length ? ` Assumes ${sizes.join(' or ')} plates; other plate sizes make it wrong (a 9-inch plate reads about 1.36× too heavy).` : ''
  const tip = `${data.note}${plateSize} Method ${data.method}. Covers ${t.capturesWithScale} of ${t.captures} plates (only fully visible, round plates get a scale).`
  return (
    <Card className="flex flex-col">
      <h3 className="text-sm font-medium text-ink">
        Food left on plates (estimate)
        <InfoTip id="estimated-pounds-tip" text={tip} />
      </h3>
      <p className="mt-3 text-ink" aria-label={`Estimated food left on plates: ${lb === null ? 'not available' : `${value} lb`}`}>
        <span className="text-4xl font-bold leading-none tracking-tight">{lb === null ? '—' : `≈ ${value}`}</span>
        {lb !== null && <span className="ml-1.5 text-lg font-medium">lb</span>}
      </p>
      <p className="mt-2 text-sm text-ink">
        Estimated from {t.capturesWithScale} of {t.captures} plates · {formatNumber(t.pixels)} pixels wasted measured
      </p>
    </Card>
  )
}
