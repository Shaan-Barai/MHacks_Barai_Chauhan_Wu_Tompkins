/**
 * Four headline cards for the selected days: Total waste (estimated grams,
 * with the measured Pixels wasted under it), Greenhouse gases, Freshwater,
 * and Waste impact ($ = 0.19 x CO2e + 1.50 x water). Every estimate says so.
 */
import { useId, type ReactNode } from 'react'
import type { ImpactDashboard } from '../data/types'
import { formatGrams, formatKgCo2e, formatLitres, formatNumber, formatUsd, formatWater } from '../lib/format'
import {
  CO2_EXPLANATION,
  IMPACT_EXPLANATION,
  TOTAL_WASTE_EXPLANATION,
  WATER_EXPLANATION,
  splitUnit,
} from './impactCopy'
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
  formatted,
  children,
}: {
  title: string
  tip: string
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
        <Badge>estimate</Badge>
      </div>
      <BigValue formatted={formatted} label={title} />
      {children}
    </Card>
  )
}

export function HeadlineCards({ data }: { data: ImpactDashboard }) {
  const t = data.totals
  const pixelsTip = useId()
  const noWeight = <p className="mt-1 text-sm">No weight estimate yet for these plates.</p>
  return (
    <section aria-label="Totals for the selected days" className="space-y-2">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <HeadlineCard title="Total waste" tip={TOTAL_WASTE_EXPLANATION} formatted={t.grams === null ? null : formatGrams(t.grams)}>
          {t.grams === null && noWeight}
          <p className="mt-2 text-base">
            <span className="font-semibold">{formatNumber(t.pixels)}</span> Pixels wasted
            <InfoTip id={pixelsTip} text={PIXELS_WASTED_EXPLANATION} />
          </p>
          <p className="text-sm">Measured from the photos</p>
          <p className="mt-2 text-sm">
            From {formatNumber(t.analyzedCaptures)} of {formatNumber(t.captures)} plate{t.captures === 1 ? '' : 's'} scanned
          </p>
          {t.excludedCaptures > 0 && (
            <p className="text-sm">
              {formatNumber(t.excludedCaptures)} plate{t.excludedCaptures === 1 ? '' : 's'} not counted (check failed or needs a
              person to look)
            </p>
          )}
        </HeadlineCard>

        <HeadlineCard title="Greenhouse gases" tip={CO2_EXPLANATION} formatted={t.kgCo2e === null ? null : formatKgCo2e(t.kgCo2e)}>
          <p className="mt-1 text-sm">To produce the food that was left</p>
        </HeadlineCard>

        <HeadlineCard title="Freshwater" tip={WATER_EXPLANATION} formatted={t.waterM3 === null ? null : formatWater(t.waterM3)}>
          {t.waterM3 !== null && t.waterM3 >= 1 && <p className="mt-1 text-sm">{formatLitres(t.waterM3)}</p>}
          <p className="mt-1 text-sm">Used to produce the food that was left</p>
        </HeadlineCard>

        <HeadlineCard title="Waste impact" tip={IMPACT_EXPLANATION} formatted={t.impactUsd === null ? null : formatUsd(t.impactUsd)}>
          <p className="mt-1 text-sm">$0.19 per kg CO&#8322;e + $1.50 per m&sup3; water. Not the food cost.</p>
        </HeadlineCard>
      </div>
      <CoverageNotes data={data} />
    </section>
  )
}

function CoverageNotes({ data }: { data: ImpactDashboard }) {
  const notes: string[] = []
  const { itemsWithoutFactor, capturesWithDefaultCalibration } = data.coverage
  if (itemsWithoutFactor > 0) {
    notes.push(
      `${itemsWithoutFactor} food${itemsWithoutFactor === 1 ? ' has' : 's have'} no weight estimate, so ${itemsWithoutFactor === 1 ? 'it is' : 'they are'} left out of the grams.`,
    )
  }
  if (capturesWithDefaultCalibration > 0) {
    notes.push(
      `${capturesWithDefaultCalibration} plate${capturesWithDefaultCalibration === 1 ? '' : 's'} used the standard plate size because the plate edge was not clear.`,
    )
  }
  if (notes.length === 0) return null
  return <p className="text-sm">{notes.join(' ')}</p>
}
