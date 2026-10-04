/**
 * Dashboard (UI.md, BIG-PLAN v2, IT_4, end-to-end pipeline). Pixels wasted is
 * the measurement; impact is in relative points; grams, kg CO2e and litres of
 * water appear only as labeled estimates from a calibrated camera. No dollars.
 *   1. Total waste: today / this week / this month, the selected days'
 *      headline cards, and pixels wasted by day (date range picker).
 *   2. Waste per portion: foods to target (pixels per portion served).
 *   3. Most wasted foods: ranked per portion, with a toggle for total pixels
 *      or impact points.
 *   4. Impact: relative greenhouse-gas, water and impact points, and
 *      nutrition lost on its own card (never part of the impact score).
 *   5. Plates: original photo next to the AI outlines, click to enlarge.
 *   6. AI recommendation, regenerated on demand.
 * Generated sample history is labeled "sample data" wherever it is counted.
 */
import { useEffect, useMemo, useState } from 'react'
import { getCaptures, getDailyWaste, getImpactDashboard, getRecommendation, getWasteTotals, regenerateRecommendation } from '../data/api'
import type { Recommendation } from '../data/types'
import { todayIso } from '../lib/dates'
import { dailyBuckets } from '../lib/grouping'
import { useAsync } from '../lib/useAsync'
import { DateRangePicker, type DateRange } from '../components/DateRangePicker'
import { FoodsToTarget } from '../components/FoodsToTarget'
import { HeadlineCards } from '../components/HeadlineCards'
import { HOW_MEASURED } from '../components/impactCopy'
import { MostWasted } from '../components/MostWasted'
import { NutritionLost } from '../components/NutritionLost'
import { PeriodTotals } from '../components/PeriodTotals'
import { PlatesGallery } from '../components/PlatesGallery'
import { RecommendationCard } from '../components/RecommendationCard'
import { TakePhotoButton } from '../components/TakePhotoButton'
import { WasteChart } from '../components/WasteChart'
import { Card, EmptyState, LoadingBlock } from '../components/ui'

export function DashboardPage({ range, onRangeChange }: { range: DateRange; onRangeChange: (r: DateRange) => void }) {
  // Bumped after a new photo so every section reloads.
  const [refresh, setRefresh] = useState(0)
  const deps = [range.start, range.end, refresh]
  const totals = useAsync(() => getWasteTotals(todayIso()), [refresh])
  const impact = useAsync(() => getImpactDashboard(range.start, range.end), deps)
  const rec = useAsync(() => getRecommendation(range.start, range.end), deps)
  const plates = useAsync(() => getCaptures(range.start, range.end), deps)
  const series = useAsync(() => getDailyWaste(range.start, range.end), deps)
  const [regenerated, setRegenerated] = useState<Recommendation | null>(null)
  useEffect(() => setRegenerated(null), [range.start, range.end, refresh])

  const buckets = useMemo(() => (series.data ? dailyBuckets(series.data) : []), [series.data])
  const hasChartData = buckets.some((b) => b.value !== null)
  const noPlates = impact.data !== undefined && impact.data.totals.captures === 0
  const sample =
    impact.data?.labels.sampleData === true || (totals.data !== undefined && Object.values(totals.data).some((t) => t.sampleCaptures > 0))
  const recommendation = regenerated ?? rec.data

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="font-display text-3xl font-semibold text-ink">Dashboard</h1>
        <TakePhotoButton onTaken={() => setRefresh((n) => n + 1)} />
      </div>
      <p className="max-w-3xl text-sm">{HOW_MEASURED}</p>

      {sample && (
        <div role="note" className="rounded-card border-2 border-dashed border-ink p-3">
          <p className="font-semibold">Sample data</p>
          <p className="text-sm">
            Some numbers here come from generated sample history, not real scans, so the charts have something to show. Real scans from
            the camera and test photos are counted alongside them. Remove the sample history with <code>npm run demo:clear</code> in
            backend/.
          </p>
        </div>
      )}

      <section aria-labelledby="total-waste" className="space-y-4">
        <h2 id="total-waste" className="text-2xl font-semibold text-ink">
          Total waste
        </h2>
        {totals.status === 'loading' && !totals.data && <LoadingBlock label="Loading totals" />}
        {totals.status === 'error' && <EmptyState title="Couldn't load today's, this week's and this month's totals.">{totals.error}</EmptyState>}
        {totals.data && <PeriodTotals totals={totals.data} />}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-base font-semibold">Selected days</p>
          <DateRangePicker value={range} onChange={onRangeChange} />
        </div>
        {impact.status === 'loading' && !impact.data && <LoadingBlock label="Loading totals" />}
        {impact.status === 'error' && <EmptyState title="Couldn't load the waste totals.">{impact.error}</EmptyState>}
        {impact.data && noPlates && (
          <EmptyState title="No plates were scanned in these days.">
            Totals show up once plates are scanned at a meal with a menu. Try a longer stretch of days.
          </EmptyState>
        )}
        {impact.data && !noPlates && <HeadlineCards data={impact.data} />}

        <Card>
          <h3 className="text-lg font-semibold text-ink">Pixels wasted by day</h3>
          <p className="mt-1 text-sm">Hover over or tab to a bar to see the exact number.</p>
          <div className="mt-3">
            {series.status === 'loading' && !series.data && <LoadingBlock label="Loading chart" />}
            {series.status === 'error' && <EmptyState title="Couldn't load the chart.">{series.error}</EmptyState>}
            {series.data &&
              (hasChartData ? (
                <WasteChart buckets={buckets} />
              ) : (
                <EmptyState title="No waste recorded for these days.">Days show up once they have a menu and scanned plates.</EmptyState>
              ))}
          </div>
        </Card>
      </section>

      {impact.data && !noPlates && (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <FoodsToTarget rows={impact.data.targets} demoPortions={impact.data.labels.demoPortions} />
          <MostWasted rows={impact.data.mostWasted} />
        </div>
      )}

      {impact.data && !noPlates && <NutritionLost data={impact.data} />}

      {plates.status === 'loading' && !plates.data && <LoadingBlock label="Loading plates" />}
      {plates.status === 'error' && <EmptyState title="Couldn't load the plates.">{plates.error}</EmptyState>}
      {plates.data && (
        <PlatesGallery captures={plates.data} neighborExcluded={impact.data?.coverage.capturesWithNeighborFoodExcluded ?? 0} />
      )}

      {rec.status === 'loading' && !recommendation && <LoadingBlock label="Loading suggestion" />}
      {rec.status === 'error' && !recommendation && (
        <EmptyState title="No suggestion right now.">The suggestion could not be written. The numbers above are still current.</EmptyState>
      )}
      {recommendation && !noPlates && (
        <RecommendationCard
          rec={recommendation}
          onRegenerate={async () => setRegenerated(await regenerateRecommendation(range.start, range.end))}
        />
      )}
    </div>
  )
}
