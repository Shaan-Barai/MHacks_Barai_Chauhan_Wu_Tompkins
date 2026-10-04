/**
 * Dashboard: today or this week at a glance. Estimated carbon emissions,
 * water and food weight (calibrated plates only), plates scanned, and
 * carbon emissions by day (at least the last 7 days). Longer windows, foods to target and the AI
 * recommendation live on Statistics; plate photos on Behind the scenes.
 */
import { useState } from 'react'
import { getImpactDashboard } from '../data/api'
import { useAsync } from '../lib/useAsync'
import { CarbonByDay } from '../components/CarbonByDay'
import { DASHBOARD_PRESETS, DateRangePicker, rangeForDays, type DateRange } from '../components/DateRangePicker'
import { HeadlineCards } from '../components/HeadlineCards'
import { Badge, EmptyState, LoadingBlock } from '../components/ui'

export function DashboardPage() {
  const [range, setRange] = useState<DateRange>(() => rangeForDays(1))
  const impact = useAsync(() => getImpactDashboard(range.start, range.end), [range.start, range.end])
  // A one-day chart is a single bar, so "Today" charts the last 7 days.
  const chartRange = range.start === range.end ? rangeForDays(7) : range

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-3xl font-bold tracking-tight text-ink">Dashboard</h1>
          {impact.data?.labels.sampleData && <Badge>Sample data</Badge>}
        </div>
        <DateRangePicker value={range} onChange={setRange} presets={DASHBOARD_PRESETS} />
      </div>

      {impact.status === 'loading' && !impact.data && <LoadingBlock label="Loading totals" />}
      {impact.status === 'error' && <EmptyState title="Couldn't load the totals." />}
      {impact.data && <HeadlineCards data={impact.data} />}

      <CarbonByDay range={chartRange} />
    </div>
  )
}
