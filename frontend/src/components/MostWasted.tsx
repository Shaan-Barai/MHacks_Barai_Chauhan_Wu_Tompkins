/**
 * "Most wasted": foods ranked by total estimated grams left, as a bar list
 * with greenhouse gases and water on each row. Foods with no weight estimate
 * follow with their Pixels wasted and the reason.
 */
import { useState } from 'react'
import type { ItemImpactRow } from '../data/types'
import { formatGrams, formatKgCo2e, formatNumber, formatWater } from '../lib/format'
import { weightUnavailableReason } from './impactCopy'
import { Badge, Card, GhostButton } from './ui'

const SHOW_FIRST = 8

export function MostWasted({ rows }: { rows: ItemImpactRow[] }) {
  const [showAll, setShowAll] = useState(false)
  const weighed = rows.filter((r) => r.impact.grams !== null)
  const pixelsOnly = rows.filter((r) => r.impact.grams === null)
  const visible = showAll ? weighed : weighed.slice(0, SHOW_FIRST)
  const max = Math.max(1, ...weighed.map((r) => r.impact.grams ?? 0))
  const top = weighed[0]

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide">Most wasted</p>
        <Badge>estimate</Badge>
      </div>
      <h2 className="mt-1 text-xl font-semibold text-ink">
        {top ? `${top.displayName} was the most wasted food.` : 'No food has a weight estimate yet.'}
      </h2>
      <p className="mt-1 text-sm">Ranked by estimated total weight left on plates.</p>

      {weighed.length > 0 && (
        <ol className="mt-3 space-y-3" aria-label="Foods ranked by estimated weight left">
          {visible.map((r) => {
            const grams = r.impact.grams!
            const pct = Math.max(1, (grams / max) * 100)
            return (
              <li key={r.itemId ?? r.displayName}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-semibold">{r.displayName}</span>
                  <span className="font-semibold">{formatGrams(grams)}</span>
                </div>
                <div className="mt-1 h-2.5 w-full" aria-hidden="true">
                  <div className="h-full rounded-r-[4px] bg-ink" style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-0.5 text-sm">
                  {r.impact.kgCo2e === null ? 'Greenhouse gases not available' : formatKgCo2e(r.impact.kgCo2e)}
                  {' · '}
                  {r.impact.waterM3 === null ? 'water not available' : `${formatWater(r.impact.waterM3)} water`}
                </p>
              </li>
            )
          })}
        </ol>
      )}
      {weighed.length > SHOW_FIRST && (
        <GhostButton type="button" className="mt-3" onClick={() => setShowAll((s) => !s)} aria-expanded={showAll}>
          {showAll ? 'Show fewer foods' : `Show all ${weighed.length} foods`}
        </GhostButton>
      )}

      {pixelsOnly.length > 0 && (
        <div className="mt-4">
          <h3 className="text-base font-semibold">No weight estimate</h3>
          <ul className="mt-1 space-y-0.5 text-sm">
            {pixelsOnly.map((r) => (
              <li key={r.itemId ?? r.displayName}>
                <span className="font-semibold">{r.displayName}:</span> {formatNumber(r.impact.pixels)} Pixels wasted.{' '}
                {weightUnavailableReason(r)}.
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
