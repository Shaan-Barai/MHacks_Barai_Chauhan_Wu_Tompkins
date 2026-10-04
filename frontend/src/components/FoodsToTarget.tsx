/**
 * "Foods to target": foods ranked by Pixels wasted per portion served
 * (BIG-PLAN v2 V1), with relative impact points per portion as a secondary
 * number. Foods without a rate are listed with the reason.
 */
import { useId, useState } from 'react'
import type { ItemImpactRow } from '../data/types'
import { formatMass, formatNumber, formatPoints } from '../lib/format'
import { PER_PORTION_EXPLANATION, impactUnavailableReason, perPortionUnavailableReason } from './impactCopy'
import { ESTIMATE_EXPLANATION, PhysicalChips, hasPhysical } from './PhysicalChips'
import { Badge, Card, GhostButton, InfoTip } from './ui'

const SHOW_FIRST = 8

export function FoodsToTarget({ rows, demoPortions }: { rows: ItemImpactRow[]; demoPortions: boolean }) {
  const [showAll, setShowAll] = useState(false)
  const tipId = useId()
  const estTip = useId()
  const anyEstimate = rows.some((r) => hasPhysical(r.impact))
  const ranked = rows.filter((r) => perPortionUnavailableReason(r) === null)
  const unranked = rows.filter((r) => perPortionUnavailableReason(r) !== null)
  const visible = showAll ? ranked : ranked.slice(0, SHOW_FIRST)
  const top = ranked[0]

  return (
    <Card>
      <p className="text-sm font-semibold uppercase tracking-wide">Foods to target</p>
      <h2 className="mt-1 text-xl font-semibold text-ink">
        {top ? `${top.displayName} had the most food left per portion.` : 'No food can be ranked per portion yet.'}
      </h2>
      <p className="mt-1 text-sm">
        Ranked by Pixels wasted per portion served.
        <InfoTip id={tipId} text={PER_PORTION_EXPLANATION} />
      </p>
      {anyEstimate && (
        <p className="mt-1 text-sm">
          Grams, CO2e and water are estimates (est.) for the food left on calibrated plates.
          <InfoTip id={estTip} text={ESTIMATE_EXPLANATION} />
        </p>
      )}

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
                  {demoPortions && <span className="mt-1 block w-fit"><Badge>demo numbers</Badge></span>}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr key={r.itemId ?? r.displayName} className="border-b border-ink align-top">
                  <td className="py-1.5 pr-2">{i + 1}</td>
                  <th scope="row" className="py-1.5 pr-2 font-semibold">
                    {r.displayName}
                    {anyEstimate && <PhysicalChips amounts={r.impact} className="mt-1 flex font-normal" />}
                  </th>
                  <td className="py-1.5 pr-2 font-semibold">
                    {formatNumber(r.perPortion!.pixels)} pixels
                    {r.perPortion!.grams != null && (
                      <span className="block text-sm font-normal">about {formatMass(r.perPortion!.grams)} est.</span>
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
      {demoPortions && <p className="mt-3 text-sm">Portions served are demo numbers until real counts are entered.</p>}
    </Card>
  )
}
