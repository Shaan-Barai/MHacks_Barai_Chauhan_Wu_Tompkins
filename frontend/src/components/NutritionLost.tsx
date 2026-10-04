/**
 * Nutrition lost: kept apart from the impact score (BIG-PLAN v2 V2).
 * Relative nutrition points, never added to the impact points.
 */
import type { ImpactDashboard } from '../data/types'
import { formatPoints } from '../lib/format'
import { Badge, Card } from './ui'

export function NutritionLost({ data }: { data: ImpactDashboard }) {
  const total = data.totals.nutritionPoints
  const top = data.mostWasted
    .filter((r) => r.impact.nutritionPoints != null && r.impact.nutritionPoints > 0)
    .sort((a, b) => (b.impact.nutritionPoints ?? 0) - (a.impact.nutritionPoints ?? 0))
    .slice(0, 3)

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-ink">Nutrition lost</h2>
        <Badge>relative points</Badge>
      </div>
      {total == null ? (
        <p className="mt-2 text-3xl font-bold">—</p>
      ) : (
        <>
          <p className="mt-2 text-ink">
            <span className="text-3xl font-bold tracking-tight">{formatPoints(total)}</span>
            <span className="ml-1.5 text-base font-medium">points</span>
          </p>
          {top.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-base">
              {top.map((r) => (
                <li key={r.itemId ?? r.displayName} className="flex justify-between gap-3">
                  <span>{r.displayName}</span>
                  <span className="font-semibold">{formatPoints(r.impact.nutritionPoints!)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  )
}
