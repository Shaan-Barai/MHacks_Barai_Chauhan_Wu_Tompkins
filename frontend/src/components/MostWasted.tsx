/**
 * "Most wasted": foods ranked by total Pixels wasted (BIG-PLAN v2 V1), as a
 * bar list with each food's relative impact points (and the greenhouse-gas
 * and water points behind them) on its row.
 */
import { useId, useState } from 'react'
import type { ItemImpactRow } from '../data/types'
import { formatNumber, formatPoints } from '../lib/format'
import { impactUnavailableReason } from './impactCopy'
import { ESTIMATE_EXPLANATION, PhysicalChips, hasPhysical } from './PhysicalChips'
import { Badge, Card, GhostButton, InfoTip } from './ui'

const SHOW_FIRST = 8

function impactLine(r: ItemImpactRow): string {
  const reason = impactUnavailableReason(r)
  if (reason) return reason
  const parts = [`${formatPoints(r.impact.impactPoints!)} impact points`]
  const detail: string[] = []
  if (r.impact.co2Points != null) detail.push(`greenhouse gases ${formatPoints(r.impact.co2Points)}`)
  if (r.impact.waterPoints != null) detail.push(`water ${formatPoints(r.impact.waterPoints)}`)
  if (detail.length) parts.push(`(${detail.join(', ')})`)
  return parts.join(' ')
}

export function MostWasted({ rows }: { rows: ItemImpactRow[] }) {
  const [showAll, setShowAll] = useState(false)
  const estTip = useId()
  const anyEstimate = rows.some((r) => hasPhysical(r.impact))
  const visible = showAll ? rows : rows.slice(0, SHOW_FIRST)
  const max = Math.max(1, ...rows.map((r) => r.impact.pixels))
  const top = rows[0]

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide">Most wasted</p>
        <Badge>points are relative</Badge>
      </div>
      <h2 className="mt-1 text-xl font-semibold text-ink">
        {top ? `${top.displayName} was the most wasted food.` : 'No food has been counted yet.'}
      </h2>
      <p className="mt-1 text-sm">Ranked by total Pixels wasted. Impact points compare foods with each other.</p>
      {anyEstimate && (
        <p className="mt-1 text-sm">
          Grams, CO2e and water are estimates (est.).
          <InfoTip id={estTip} text={ESTIMATE_EXPLANATION} />
        </p>
      )}

      {rows.length > 0 && (
        <ol className="mt-3 space-y-3" aria-label="Foods ranked by Pixels wasted">
          {visible.map((r) => {
            const pct = Math.max(1, (r.impact.pixels / max) * 100)
            return (
              <li key={r.itemId ?? r.displayName}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold">{r.displayName}</span>
                    {anyEstimate && <PhysicalChips amounts={r.impact} />}
                  </span>
                  <span className="font-semibold">{formatNumber(r.impact.pixels)} pixels</span>
                </div>
                <div className="mt-1 h-2.5 w-full" aria-hidden="true">
                  <div className="h-full rounded-r-[4px] bg-ink" style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-0.5 text-sm">{impactLine(r)}</p>
              </li>
            )
          })}
        </ol>
      )}
      {rows.length > SHOW_FIRST && (
        <GhostButton type="button" className="mt-3" onClick={() => setShowAll((s) => !s)} aria-expanded={showAll}>
          {showAll ? 'Show fewer foods' : `Show all ${rows.length} foods`}
        </GhostButton>
      )}
    </Card>
  )
}
