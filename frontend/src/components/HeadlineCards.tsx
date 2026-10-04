/**
 * Two headline cards for the selected days (BIG-PLAN v2): Total waste in
 * Pixels wasted (the measurement), and Relative impact in unitless points
 * (impact score with greenhouse-gas and water points under it). Points are
 * labeled relative everywhere; there are no grams, kg, litres or dollars.
 */
import { useId, type ReactNode } from 'react'
import type { ImpactDashboard } from '../data/types'
import { formatNumber, formatPoints } from '../lib/format'
import { IMPACT_EXPLANATION, RELATIVE_POINTS_NOTE, splitUnit } from './impactCopy'
import { Badge, Card, InfoTip, PIXELS_WASTED_EXPLANATION } from './ui'

function BigValue({ formatted, label }: { formatted: string | null; label: string }) {
  if (formatted === null) {
    return <p className="mt-2 font-display text-2xl font-semibold text-ink">Not available</p>
  }
  const [value, unit] = splitUnit(formatted)
  return (
    <p className="mt-2 text-ink" aria-label={`${label}: ${formatted}`}>
      <span className="font-display text-[44px] font-semibold leading-none">{value}</span>
      {unit && <span className="ml-1.5 text-xl font-semibold">{unit}</span>}
    </p>
  )
}

function HeadlineCard({
  title,
  tip,
  badge,
  formatted,
  children,
}: {
  title: string
  tip: string
  badge?: string
  formatted: string | null
  children?: ReactNode
}) {
  const tipId = useId()
  return (
    <Card className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-ink">
          {title}
          <InfoTip id={tipId} text={tip} />
        </h3>
        {badge && <Badge>{badge}</Badge>}
      </div>
      <BigValue formatted={formatted} label={title} />
      {children}
    </Card>
  )
}

const points = (n: number | null | undefined) => (n == null ? 'not available' : `${formatPoints(n)} points`)

export function HeadlineCards({ data }: { data: ImpactDashboard }) {
  const t = data.totals
  return (
    <section aria-label="Totals for the selected days" className="space-y-2">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <HeadlineCard title="Total waste" tip={PIXELS_WASTED_EXPLANATION} formatted={`${formatNumber(t.pixels)} pixels`}>
          <p className="mt-1 text-sm">Pixels wasted, counted inside the AI outlines</p>
          <p className="mt-2 text-base">
            From {formatNumber(t.analyzedCaptures)} of {formatNumber(t.captures)} plate{t.captures === 1 ? '' : 's'} scanned
          </p>
          {t.excludedCaptures > 0 && (
            <p className="text-sm">
              {formatNumber(t.excludedCaptures)} plate{t.excludedCaptures === 1 ? '' : 's'} not counted (check failed or needs a
              person to look)
            </p>
          )}
        </HeadlineCard>

        <HeadlineCard
          title="Relative impact"
          tip={IMPACT_EXPLANATION}
          badge="relative points"
          formatted={t.impactPoints == null ? null : `${formatPoints(t.impactPoints)} points`}
        >
          <p className="mt-1 text-sm">Impact score: greenhouse gases and water together</p>
          <dl className="mt-2 text-base">
            <div className="flex flex-wrap gap-x-1.5">
              <dt>Greenhouse gases:</dt>
              <dd className="font-semibold">{points(t.co2Points)}</dd>
            </div>
            <div className="flex flex-wrap gap-x-1.5">
              <dt>Water:</dt>
              <dd className="font-semibold">{points(t.waterPoints)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-sm">{RELATIVE_POINTS_NOTE}</p>
        </HeadlineCard>
      </div>
      <CoverageNotes data={data} />
    </section>
  )
}

function CoverageNotes({ data }: { data: ImpactDashboard }) {
  const n = data.coverage.itemsWithoutFactor
  if (!(n > 0)) return null
  return (
    <p className="text-sm">
      {n} food{n === 1 ? ' has' : 's have'} no impact data, so {n === 1 ? 'its pixels count' : 'their pixels count'} in Total waste
      but not in the points.
    </p>
  )
}
