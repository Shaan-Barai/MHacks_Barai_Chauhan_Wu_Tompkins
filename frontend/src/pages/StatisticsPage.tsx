/**
 * Statistics: the last 30 or 90 days. Headline estimates, carbon emissions by
 * day, foods to target (per portion), most wasted foods, and the AI
 * recommendation (regenerated on demand).
 */
import { useEffect, useState } from 'react'
import { getImpactDashboard, getRecommendation, regenerateRecommendation } from '../data/api'
import type { Recommendation } from '../data/types'
import { useAsync } from '../lib/useAsync'
import { CarbonByDay } from '../components/CarbonByDay'
import { DateRangePicker, rangeForDays, STATISTICS_PRESETS, type DateRange } from '../components/DateRangePicker'
import { FoodsToTarget } from '../components/FoodsToTarget'
import { HeadlineCards } from '../components/HeadlineCards'
import { MostWasted } from '../components/MostWasted'
import { RecommendationCard } from '../components/RecommendationCard'
import { Badge, EmptyState, LoadingBlock } from '../components/ui'

export function StatisticsPage({ dataRevision = 0 }: { dataRevision?: number }) {
  const [range, setRange] = useState<DateRange>(() => rangeForDays(30))
  const deps = [range.start, range.end, dataRevision]
  const impact = useAsync(() => getImpactDashboard(range.start, range.end), deps)
  const rec = useAsync(() => getRecommendation(range.start, range.end), deps)
  const [regenerated, setRegenerated] = useState<Recommendation | null>(null)
  useEffect(() => setRegenerated(null), [range.start, range.end, dataRevision])

  const noPlates = impact.data !== undefined && impact.data.totals.captures === 0
  const recommendation = regenerated ?? rec.data

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-3xl font-bold tracking-tight text-ink">Statistics</h1>
          {impact.data?.labels.sampleData && <Badge>Sample data</Badge>}
        </div>
        <DateRangePicker value={range} onChange={setRange} presets={STATISTICS_PRESETS} />
      </div>

      {impact.status === 'loading' && !impact.data && <LoadingBlock label="Loading totals" />}
      {impact.status === 'error' && <EmptyState title="Couldn't load the statistics." />}
      {impact.data && noPlates && <EmptyState title="No plates scanned in these days." />}
      {impact.data && !noPlates && <HeadlineCards data={impact.data} />}

      <CarbonByDay range={range} refresh={dataRevision} />

      {recommendation && !noPlates && (
        <RecommendationCard
          rec={recommendation}
          onRegenerate={async () => setRegenerated(await regenerateRecommendation(range.start, range.end))}
        />
      )}

      {impact.data && !noPlates && (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <FoodsToTarget rows={impact.data.targets} demoPortions={impact.data.labels.demoPortions} />
          <MostWasted rows={impact.data.mostWasted} />
        </div>
      )}
    </div>
  )
}
