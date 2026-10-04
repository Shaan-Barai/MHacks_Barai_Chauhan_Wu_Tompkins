/**
 * Headline cards for the selected days. Total waste in Pixels wasted (the
 * measurement, BIG-PLAN v2) comes first. IT_4 adds Estimated CO2e (kg) and
 * Estimated water (L) from calibrated plates only, with their coverage.
 * Relative impact stays in unitless
 * points. Missing estimates say "Not available", never 0.
 */
import { useId, type ReactNode } from 'react'
import type { ImpactDashboard } from '../data/types'
import { formatMass, formatKgCo2e, formatLitres, formatNumber, formatPoints } from '../lib/format'
import { ESTIMATED_TOTALS_EXPLANATION, IMPACT_EXPLANATION, RELATIVE_POINTS_NOTE, splitUnit } from './impactCopy'
import { CloudIcon, DropletIcon } from './PhysicalChips'
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
  icon,
  tip,
  badge,
  formatted,
  children,
}: {
  title: string
  icon?: ReactNode
  tip: string
  badge?: string
  formatted: string | null
  children?: ReactNode
}) {
  const tipId = useId()
  return (
    <Card className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-base font-semibold text-ink">
          {icon}
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

/** Calibrated-plate coverage under each estimated total. */
function EstimateCoverage({ data, value }: { data: ImpactDashboard; value: number | null | undefined }) {
  const cov = data.totals.physicalCoverage
  const calibrated = cov?.calibratedCaptures ?? 0
  const analyzed = cov?.analyzedCaptures ?? data.totals.analyzedCaptures
  if (calibrated === 0) {
    return (
      <p className="mt-2 text-base">
        No plates in these days were scanned with a calibrated camera. Calibrate the camera in Settings.
      </p>
    )
  }
  return (
    <>
      <p className="mt-2 text-base">
        From {formatNumber(calibrated)} of {formatNumber(analyzed)} plate{analyzed === 1 ? '' : 's'} (calibrated)
      </p>
      {value == null && <p className="text-sm">None of the foods on those plates has footprint data.</p>}
    </>
  )
}

export function HeadlineCards({ data }: { data: ImpactDashboard }) {
  const t = data.totals
  return (
    <section aria-label="Totals for the selected days" className="space-y-2">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
          title="Estimated CO2e"
          icon={<CloudIcon />}
          tip={ESTIMATED_TOTALS_EXPLANATION}
          badge="estimate"
          formatted={t.kgCo2e == null ? null : formatKgCo2e(t.kgCo2e)}
        >
          <p className="mt-1 text-sm">
            Greenhouse gases from the food left on plates
            {t.grams != null && <>, about {formatMass(t.grams)} of food</>}
          </p>
          <EstimateCoverage data={data} value={t.kgCo2e} />
        </HeadlineCard>

        <HeadlineCard
          title="Estimated water"
          icon={<DropletIcon />}
          tip={ESTIMATED_TOTALS_EXPLANATION}
          badge="estimate"
          formatted={t.waterLitres == null ? null : formatLitres(t.waterLitres)}
        >
          <p className="mt-1 text-sm">Fresh water used to make the food left on plates</p>
          <EstimateCoverage data={data} value={t.waterLitres} />
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
      but not in the points or estimates.
    </p>
  )
}
