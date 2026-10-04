/**
 * Dashboard (UI.md, BIG-PLAN v2): lookback buttons, two headline cards (Total
 * waste in Pixels wasted, Relative impact in points), the daily pixels chart,
 * the AI recommendation, foods to target (pixels per portion), most wasted
 * (pixels), and relative nutrition points kept apart from the impact score.
 * Plate photos are on Behind the scenes. A dining hall picker next
 * to the title shows one location or all of them together.
 */
import { useMemo } from 'react'
import { getDailyWaste, getImpactDashboard, getRecommendation } from '../data/api'
import { dailyBuckets } from '../lib/grouping'
import { useAsync } from '../lib/useAsync'
import { DateRangePicker, type DateRange } from '../components/DateRangePicker'
import { FoodsToTarget } from '../components/FoodsToTarget'
import { HeadlineCards } from '../components/HeadlineCards'
import { HOW_MEASURED } from '../components/impactCopy'
import { MostWasted } from '../components/MostWasted'
import { NutritionLost } from '../components/NutritionLost'
import { RecommendationCard } from '../components/RecommendationCard'
import { WasteChart } from '../components/WasteChart'
import { Card, EmptyState, LoadingBlock } from '../components/ui'
import type { HallRef } from '../data/types'

export function DashboardPage({
  range,
  onRangeChange,
  halls = [],
  hall = 'all',
  onHallChange,
}: {
  range: DateRange
  onRangeChange: (r: DateRange) => void
  halls?: HallRef[]
  /** A hallId, or 'all' for every location together. */
  hall?: string
  onHallChange?: (hall: string) => void
}) {
  // 'all' asks the backend for every hall at once (no hallId), so totals are summed server-side.
  const scope = hall === 'all' ? null : hall
  const deps = [range.start, range.end, scope]
  const impact = useAsync(() => getImpactDashboard(range.start, range.end, scope), deps)
  const rec = useAsync(() => getRecommendation(range.start, range.end, scope), deps)
  const series = useAsync(() => getDailyWaste(range.start, range.end, scope), deps)

  const buckets = useMemo(() => (series.data ? dailyBuckets(series.data) : []), [series.data])
  const hasChartData = buckets.some((b) => b.value !== null)
  const noPlates = impact.data !== undefined && impact.data.totals.captures === 0

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-semibold text-ink">Dashboard</h1>
          {halls.length > 0 && (
            <select
              aria-label="Dining hall"
              value={hall}
              onChange={(e) => onHallChange?.(e.target.value)}
              className="rounded-btn border border-ink bg-cream px-3 py-2 text-base text-ink"
            >
              <option value="all">All dining halls</option>
              {halls.map((h) => (
                <option key={h.hallId} value={h.hallId}>
                  {h.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <DateRangePicker value={range} onChange={onRangeChange} />
      </div>
      <p className="max-w-3xl text-sm">{HOW_MEASURED}</p>

      {impact.status === 'loading' && !impact.data && <LoadingBlock label="Loading totals" />}
      {impact.status === 'error' && <EmptyState title="Couldn't load the waste totals.">{impact.error}</EmptyState>}
      {impact.data && noPlates && (
        <EmptyState title="No plates were scanned in these days.">
          Totals show up once plates are scanned at a meal with a menu. Try a longer stretch of days.
        </EmptyState>
      )}
      {impact.data && !noPlates && <HeadlineCards data={impact.data} />}

      <Card>
        <h2 className="text-lg font-semibold text-ink">Pixels wasted by day</h2>
        <p className="mt-1 text-sm">Hover over or tab to a bar to see the exact number.</p>
        <div className="mt-3">
          {series.status === 'loading' && !series.data && <LoadingBlock label="Loading chart" />}
          {series.status === 'error' && <EmptyState title="Couldn't load the chart.">{series.error}</EmptyState>}
          {series.data &&
            (hasChartData ? (
              <WasteChart buckets={buckets} />
            ) : (
              <EmptyState title="No waste recorded for these days.">
                Days show up once they have a menu and scanned plates.
              </EmptyState>
            ))}
        </div>
      </Card>

      {rec.status === 'loading' && !rec.data && <LoadingBlock label="Loading suggestion" />}
      {rec.status === 'error' && (
        <EmptyState title="No suggestion right now.">The suggestion could not be written. The numbers below are still current.</EmptyState>
      )}
      {rec.data && !noPlates && <RecommendationCard rec={rec.data} />}

      {impact.data && !noPlates && (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <FoodsToTarget rows={impact.data.targets} demoPortions={impact.data.labels.demoPortions} />
          <MostWasted rows={impact.data.mostWasted} />
        </div>
      )}


      {impact.data && !noPlates && <NutritionLost data={impact.data} />}
    </div>
  )
}
