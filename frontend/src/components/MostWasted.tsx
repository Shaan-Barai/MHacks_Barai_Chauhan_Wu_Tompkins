/**
 * "Most wasted foods": a bar list ranked by Pixels wasted per portion served
 * (default, to find what to target), with a toggle to rank by total Pixels
 * wasted or by relative impact points. Each row keeps the other numbers
 * beside the one it is ranked by, the calibrated estimates (grams, CO2e,
 * water; labeled est.) when there are any, and the factor-table source.
 * Foods without the chosen number are listed after the ranked ones, with the
 * reason; they are never shown as zero.
 */
import { useId, useState } from 'react'
import type { ItemImpactRow } from '../data/types'
import { formatNumber, formatPoints } from '../lib/format'
import { impactUnavailableReason, perPortionUnavailableReason } from './impactCopy'
import { ESTIMATE_EXPLANATION, PhysicalChips, hasPhysical } from './PhysicalChips'
import { FactorSource } from './FactorSource'
import { Badge, Card, GhostButton, InfoTip } from './ui'

const SHOW_FIRST = 8

export type RankBy = 'perPortion' | 'pixels' | 'impact'

const RANKINGS: Array<{ key: RankBy; label: string; caption: string }> = [
  { key: 'perPortion', label: 'Per portion', caption: 'Ranked by Pixels wasted per portion served.' },
  { key: 'pixels', label: 'Total pixels', caption: 'Ranked by total Pixels wasted.' },
  { key: 'impact', label: 'Impact points', caption: 'Ranked by relative impact points (greenhouse gases and water).' },
]

function valueOf(r: ItemImpactRow, by: RankBy): number | null {
  if (by === 'perPortion') return perPortionUnavailableReason(r) === null ? r.perPortion!.pixels : null
  if (by === 'impact') return r.impact.impactPoints ?? null
  return r.impact.pixels
}

function label(r: ItemImpactRow, by: RankBy): string {
  const v = valueOf(r, by)
  if (v === null) return by === 'perPortion' ? perPortionUnavailableReason(r)! : impactUnavailableReason(r)!
  if (by === 'perPortion') return `${formatNumber(v)} pixels per portion`
  if (by === 'impact') return `${formatPoints(v)} impact points`
  return `${formatNumber(v)} pixels`
}

function detail(r: ItemImpactRow, by: RankBy): string {
  const parts: string[] = []
  if (by !== 'pixels') parts.push(`${formatNumber(r.impact.pixels)} pixels in total`)
  if (by !== 'perPortion' && perPortionUnavailableReason(r) === null) parts.push(`${formatNumber(r.perPortion!.pixels)} per portion`)
  if (by !== 'impact') parts.push(impactUnavailableReason(r) ?? `${formatPoints(r.impact.impactPoints!)} impact points`)
  if (by === 'impact' && r.impact.co2Points != null && r.impact.waterPoints != null) {
    parts.push(`greenhouse gases ${formatPoints(r.impact.co2Points)}, water ${formatPoints(r.impact.waterPoints)}`)
  }
  return parts.join(' · ')
}

/** Ranked rows first (highest value first), then foods without the number. */
export function rankFoods(rows: ItemImpactRow[], by: RankBy): { ranked: ItemImpactRow[]; unranked: ItemImpactRow[] } {
  const ranked = rows.filter((r) => valueOf(r, by) !== null)
  ranked.sort((a, b) => valueOf(b, by)! - valueOf(a, by)! || a.displayName.localeCompare(b.displayName))
  return { ranked, unranked: rows.filter((r) => valueOf(r, by) === null) }
}

export function MostWasted({ rows, initialRank = 'perPortion' }: { rows: ItemImpactRow[]; initialRank?: RankBy }) {
  const [by, setBy] = useState<RankBy>(initialRank)
  const [showAll, setShowAll] = useState(false)
  const estTip = useId()
  const anyEstimate = rows.some((r) => hasPhysical(r.impact))
  const { ranked, unranked } = rankFoods(rows, by)
  const all = [...ranked, ...unranked]
  const visible = showAll ? all : all.slice(0, SHOW_FIRST)
  const max = Math.max(1e-9, ...ranked.map((r) => valueOf(r, by)!))
  const top = ranked[0]
  const ranking = RANKINGS.find((r) => r.key === by)!
  const headline: Record<RankBy, string> = {
    perPortion: 'had the most food left per portion.',
    pixels: 'had the most food left in total.',
    impact: 'had the highest impact points.',
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide">Most wasted foods</p>
        {by === 'impact' && <Badge>points are relative</Badge>}
      </div>
      <h2 className="mt-1 text-xl font-semibold text-ink">
        {top ? `${top.displayName} ${headline[by]}` : 'No food can be ranked this way yet.'}
      </h2>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Rank foods by">
        {RANKINGS.map((r) => (
          <button
            key={r.key}
            type="button"
            aria-pressed={by === r.key}
            onClick={() => setBy(r.key)}
            className={`rounded-btn border border-ink px-3 py-1.5 text-base ${by === r.key ? 'bg-ink font-semibold text-cream' : 'bg-cream text-ink hover:underline'}`}
          >
            {r.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-sm">{ranking.caption}</p>
      {anyEstimate && (
        <p className="mt-1 text-sm">
          Grams, CO2e and water are estimates (est.).
          <InfoTip id={estTip} text={ESTIMATE_EXPLANATION} />
        </p>
      )}

      {all.length > 0 && (
        <ol className="mt-3 space-y-3" aria-label={`Foods ${ranking.caption.toLowerCase().replace(/\.$/, '')}`}>
          {visible.map((r) => {
            const v = valueOf(r, by)
            return (
              <li key={r.itemId ?? r.displayName}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold">{r.displayName}</span>
                    {anyEstimate && <PhysicalChips amounts={r.impact} />}
                    <FactorSource row={r} />
                  </span>
                  <span className={v === null ? 'text-sm' : 'font-semibold'}>{label(r, by)}</span>
                </div>
                {v !== null && (
                  <div className="mt-1 h-2.5 w-full" aria-hidden="true">
                    <div className="h-full rounded-r-[4px] bg-ink" style={{ width: `${Math.max(1, (v / max) * 100)}%` }} />
                  </div>
                )}
                <p className="mt-0.5 text-sm">{detail(r, by)}</p>
              </li>
            )
          })}
        </ol>
      )}
      {all.length > SHOW_FIRST && (
        <GhostButton type="button" className="mt-3" onClick={() => setShowAll((s) => !s)} aria-expanded={showAll}>
          {showAll ? 'Show fewer foods' : `Show all ${all.length} foods`}
        </GhostButton>
      )}
    </Card>
  )
}
