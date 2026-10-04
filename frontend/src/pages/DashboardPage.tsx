/**
 * Dashboard (UI.md). Top: the dining hall dropdown, three summary cards
 * (today, this week, this month), and the daily chart with its lookback
 * buttons. Below, for the chart's days (BIG-PLAN E): four headline cards
 * (total waste, greenhouse gases, freshwater, waste impact), the AI
 * recommendation, foods to target (per portion), most wasted, recent plates
 * with their AI outline images, and nutrition lost kept apart from the score.
 */
import { useMemo } from 'react'
import { DEMO_METRICS, getCaptures, getDashboardDaily, getDashboardSummary, getImpactDashboard, getRecommendation } from '../data/api'
import { chartUnit, dailyBuckets, type ChartUnit } from '../lib/grouping'
import { useAsync } from '../lib/useAsync'
import { DateRangePicker, type DateRange } from '../components/DateRangePicker'
import { FoodsToTarget } from '../components/FoodsToTarget'
import { HeadlineCards } from '../components/HeadlineCards'
import { HOW_MEASURED } from '../components/impactCopy'
import { MostWasted } from '../components/MostWasted'
import { NutritionLost } from '../components/NutritionLost'
import { PlatesGallery } from '../components/PlatesGallery'
import { RecommendationCard } from '../components/RecommendationCard'
import { SummaryCardsRow } from '../components/SummaryCards'
import { WasteChart } from '../components/WasteChart'
import { Badge, Card, EmptyState, LoadingBlock } from '../components/ui'
import type { HallLocation } from '../data/types'

const CHART_TITLE: Record<ChartUnit, string> = {
  grams: 'Food left by day (estimate)',
  pixels: 'Pixels wasted by day',
  score: 'Waste score by day',
}

/** `hall` is a location id, or 'all' for every location added together. */
export function DashboardPage({
  range,
  onRangeChange,
  locations,
  hall,
  onHallChange,
}: {
  range: DateRange
  onRangeChange: (r: DateRange) => void
  locations: HallLocation[]
  hall: string
  onHallChange: (hall: string) => void
}) {
  const hallIds = hall === 'all' ? locations.map((l) => l.id) : [hall]
  const deps = [range.start, range.end, hallIds.join()]
  const summary = useAsync(() => getDashboardSummary(hallIds), [hallIds.join()])
  const impact = useAsync(() => getImpactDashboard(range.start, range.end, hallIds), deps)
  const rec = useAsync(() => getRecommendation(range.start, range.end, hallIds), deps)
  const plates = useAsync(() => getCaptures(range.start, range.end, hallIds), deps)
  const series = useAsync(() => getDashboardDaily(range.start, range.end, hallIds), deps)

  const unit: ChartUnit = useMemo(() => (DEMO_METRICS ? 'score' : series.data ? chartUnit(series.data) : 'pixels'), [series.data])
  const buckets = useMemo(() => (series.data ? dailyBuckets(series.data, unit) : []), [series.data, unit])
  const hasChartData = buckets.some((b) => b.value !== null)
  const noPlates = impact.data !== undefined && impact.data.totals.captures === 0

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-3xl font-semibold text-ink">Dashboard</h1>
        {locations.length > 1 && (
          <select
            aria-label="Dining hall"
            value={hall}
            onChange={(e) => onHallChange(e.target.value)}
            className="rounded-btn border border-ink bg-cream px-3 py-2 text-base text-ink"
          >
            <option value="all">All dining halls</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
        {DEMO_METRICS && <Badge>Demo numbers</Badge>}
      </div>

      {summary.status === 'loading' && !summary.data && <LoadingBlock label="Loading totals" />}
      {summary.status === 'error' && <EmptyState title="Couldn't load totals.">{summary.error}</EmptyState>}
      {summary.data && <SummaryCardsRow data={summary.data} unit={DEMO_METRICS ? 'score' : 'pixels'} periods={DEMO_METRICS ? 'rolling' : 'calendar'} />}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink">
            {CHART_TITLE[unit]}
          </h2>
          <DateRangePicker value={range} onChange={onRangeChange} />
        </div>
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

      <section aria-label="More about these days" className="space-y-5 pt-2">
        <div>
          <h2 className="font-display text-2xl font-semibold text-ink">More about these days</h2>
          <p className="mt-1 max-w-3xl text-sm">Everything below follows the days picked on the graph. {HOW_MEASURED}</p>
        </div>

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

        {plates.status === 'loading' && !plates.data && <LoadingBlock label="Loading plates" />}
        {plates.status === 'error' && <EmptyState title="Couldn't load the plates.">{plates.error}</EmptyState>}
        {plates.data && <PlatesGallery captures={plates.data} />}

        {impact.data && !noPlates && <NutritionLost data={impact.data} />}
      </section>
    </div>
  )
}
