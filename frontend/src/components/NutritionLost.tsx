/**
 * Nutrition lost: a small section kept apart from the impact score (BIG-PLAN
 * D1). Nutrient-days are estimates and never added to Waste impact.
 */
import { useId } from 'react'
import type { ImpactDashboard } from '../data/types'
import { NUTRITION_EXPLANATION, formatNutrientDays } from './impactCopy'
import { Badge, Card, InfoTip } from './ui'

export function NutritionLost({ data }: { data: ImpactDashboard }) {
  const tipId = useId()
  const total = data.totals.nutrientDaysLost
  const top = data.mostWasted
    .filter((r) => r.impact.nutrientDaysLost !== null && r.impact.nutrientDaysLost > 0)
    .sort((a, b) => (b.impact.nutrientDaysLost ?? 0) - (a.impact.nutrientDaysLost ?? 0))
    .slice(0, 3)

  return (
    <Card className="border-dashed">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-ink">
          Nutrition lost
          <InfoTip id={tipId} text={NUTRITION_EXPLANATION} />
        </h2>
        <Badge>estimate</Badge>
        <Badge>not part of the impact score</Badge>
      </div>
      {total === null ? (
        <p className="mt-2">Not available for these days.</p>
      ) : (
        <>
          <p className="mt-2 text-base">
            About <span className="font-semibold">{formatNutrientDays(total)} nutrient-days</span> were left on plates: enough
            nutrients for one adult for {formatNutrientDays(total)} days.
          </p>
          {top.length > 0 && (
            <p className="mt-1 text-sm">
              Most from {top.map((r) => `${r.displayName} (${formatNutrientDays(r.impact.nutrientDaysLost!)})`).join(', ')}.
            </p>
          )}
        </>
      )}
    </Card>
  )
}
