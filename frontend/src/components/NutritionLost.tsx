/**
 * Nutrition lost: a small section kept apart from the impact score (BIG-PLAN
 * v2 V2). Relative nutrition points, never added to the impact points.
 */
import { useId } from 'react'
import type { ImpactDashboard } from '../data/types'
import { formatPoints } from '../lib/format'
import { NUTRITION_EXPLANATION } from './impactCopy'
import { Badge, Card, InfoTip } from './ui'

export function NutritionLost({ data }: { data: ImpactDashboard }) {
  const tipId = useId()
  const total = data.totals.nutritionPoints
  const top = data.mostWasted
    .filter((r) => r.impact.nutritionPoints != null && r.impact.nutritionPoints > 0)
    .sort((a, b) => (b.impact.nutritionPoints ?? 0) - (a.impact.nutritionPoints ?? 0))
    .slice(0, 3)

  return (
    <Card className="border-dashed">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-ink">
          Nutrition lost
          <InfoTip id={tipId} text={NUTRITION_EXPLANATION} />
        </h2>
        <Badge>relative points</Badge>
        <Badge>not part of the impact score</Badge>
      </div>
      {total == null ? (
        <p className="mt-2">Not available for these days.</p>
      ) : (
        <>
          <p className="mt-2 text-base">
            <span className="font-semibold">{formatPoints(total)} nutrition points</span> were left on plates.
          </p>
          {top.length > 0 && (
            <p className="mt-1 text-sm">
              Most from {top.map((r) => `${r.displayName} (${formatPoints(r.impact.nutritionPoints!)})`).join(', ')}.
            </p>
          )}
          <p className="mt-1 text-sm">Use these to compare foods. They are not a count of meals or nutrients.</p>
        </>
      )}
    </Card>
  )
}
