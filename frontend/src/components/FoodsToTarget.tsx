/**
 * "Foods to target": foods ranked by Pixels wasted per portion served
 * (BIG-PLAN v2 V1), with relative impact points per portion as a secondary
 * number. Foods without a rate are listed with the reason.
 */
import { useState } from 'react'
import type { ItemImpactRow } from '../data/types'
import { formatMass, formatNumber, formatPoints } from '../lib/format'
import { impactUnavailableReason, perPortionUnavailableReason } from './impactCopy'
import { FactorSource } from './FactorSource'
import { Badge, Card, GhostButton } from './ui'

const SHOW_FIRST = 8

export function FoodsToTarget({ rows, demoPortions }: { rows: ItemImpactRow[]; demoPortions: boolean }) {
  const [showAll, setShowAll] = useState(false)
  const ranked = rows.filter((r) => perPortionUnavailableReason(r) === null)
  const unranked = rows.filter((r) => perPortionUnavailableReason(r) !== null)
  const visible = showAll ? ranked : ranked.slice(0, SHOW_FIRST)
  const top = ranked[0]

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-ink">Foods to target</h2>
        {demoPortions && <Badge>Demo portions</Badge>}
      </div>
      {!top && <p className="mt-2 text-base">Nothing to rank yet.</p>}

      {ranked.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[30rem] text-left text-base">
            <caption className="sr-only">Foods ranked by Pixels wasted per portion served</caption>
            <thead>
              <tr className="border-b border-ink text-sm">
                <th scope="col" className="py-1.5 pr-2">#</th>
                <th scope="col" className="py-1.5 pr-2">Food</th>
                <th scope="col" className="py-1.5 pr-2">
                  Pixels wasted per portion
                </th>
                <th scope="col" className="py-1.5 pr-2 font-normal">
                  Impact per portion <span className="block">(relative points)</span>
                </th>
                <th scope="col" className="py-1.5">
                  <span className="font-normal">Portions served</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr key={r.itemId ?? r.displayName} className="border-b border-ink align-top">
                  <td className="py-1.5 pr-2">{i + 1}</td>
                  <th scope="row" className="py-1.5 pr-2 font-semibold">
                    {r.displayName}
                    <span className="block"><FactorSource row={r} /></span>
                  </th>
                  <td className="py-1.5 pr-2 font-semibold">
                    {formatNumber(r.perPortion!.pixels)} pixels
                    {r.perPortion!.grams != null && (
                      <span className="block text-sm font-normal">about {formatMass(r.perPortion!.grams)}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-sm">
                    {r.perPortion!.impactPoints == null
                      ? (impactUnavailableReason(r) ?? 'Not available')
                      : `${formatPoints(r.perPortion!.impactPoints)} points`}
                  </td>
                  <td className="py-1.5 text-sm">{r.portionsServed === null ? 'Not entered' : formatNumber(r.portionsServed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ranked.length > SHOW_FIRST && (
        <GhostButton type="button" className="mt-3" onClick={() => setShowAll((s) => !s)} aria-expanded={showAll}>
          {showAll ? 'Show fewer foods' : `Show all ${ranked.length} foods`}
        </GhostButton>
      )}

      {unranked.length > 0 && (
        <div className="mt-4">
          <h3 className="text-base font-semibold">Can't rank yet</h3>
          <ul className="mt-1 space-y-0.5 text-sm">
            {unranked.map((r) => (
              <li key={r.itemId ?? r.displayName}>
                <span className="font-semibold">{r.displayName}:</span> {perPortionUnavailableReason(r)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
