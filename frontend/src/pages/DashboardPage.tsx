/**
 * Dashboard (UI.md, BIG-PLAN E): lookback buttons, four headline cards (total
 * waste, greenhouse gases, freshwater, waste impact), the AI recommendation,
 * foods to target (per portion), most wasted, the daily chart, recent plates
 * with their AI outline images, and nutrition lost kept apart from the score.
 */
import { useMemo } from 'react'
import { getCaptures, getDailyWaste, getImpactDashboard, getRecommendation } from '../data/api'
import { chartUnit, dailyBuckets } from '../lib/grouping'
import { useAsync } from '../lib/useAsync'
import { DateRangePicker, type DateRange } from '../components/DateRangePicker'
import { FoodsToTarget } from '../components/FoodsToTarget'
import { HeadlineCards } from '../components/HeadlineCards'
import { HOW_MEASURED } from '../components/impactCopy'
import { MostWasted } from '../components/MostWasted'
import { NutritionLost } from '../components/NutritionLost'
import { PlatesGallery } from '../components/PlatesGallery'
import { RecommendationCard } from '../components/RecommendationCard'
import { WasteChart } from '../components/WasteChart'
import { Card, EmptyState, LoadingBlock } from '../components/ui'

export function DashboardPage({ range, onRangeChange }: { range: DateRange; onRangeChange: (r: DateRange) => void }) {
  const deps = [range.start, range.end]
  const impact = useAsync(() => getImpactDashboard(range.start, range.end), deps)
  const rec = useAsync(() => getRecommendation(range.start, range.end), deps)
  const plates = useAsync(() => getCaptures(range.start, range.end), deps)
  const series = useAsync(() => getDailyWaste(range.start, range.end), deps)

  const unit = useMemo(() => (series.data ? chartUnit(series.data) : 'pixels'), [series.data])
  const buckets = useMemo(() => (series.data ? dailyBuckets(series.data, unit) : []), [series.data, unit])
  const hasChartData = buckets.some((b) => b.value !== null)
  const noPlates = impact.data !== undefined && impact.data.totals.captures === 0

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl font-semibold text-ink">Dashboard</h1>
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

      <Card>
        <h2 className="text-lg font-semibold text-ink">
          {unit === 'grams' ? 'Food left by day (estimate)' : 'Pixels wasted by day'}
        </h2>
        <p className="mt-1 text-sm">Hover over or tab to a bar to see the exact number.</p>
        <div className="mt-3">
          {series.status === 'loading' && !series.data && <LoadingBlock label="Loading chart" />}
          {series.status === 'error' && <EmptyState title="Couldn't load the chart.">{series.error}</EmptyState>}
          {series.data &&
            (hasChartData ? (
              <WasteChart buckets={buckets} unit={unit} />
            ) : (
              <EmptyState title="No waste recorded for these days.">
                Days show up once they have a menu and scanned plates.
              </EmptyState>
            ))}
        </div>
      </Card>

      {plates.status === 'loading' && !plates.data && <LoadingBlock label="Loading plates" />}
      {plates.status === 'error' && <EmptyState title="Couldn't load the plates.">{plates.error}</EmptyState>}
      {plates.data && <PlatesGallery captures={plates.data} />}

      {impact.data && !noPlates && <NutritionLost data={impact.data} />}
    </div>
  )
}
