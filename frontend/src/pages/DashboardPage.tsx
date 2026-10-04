/** Dashboard: the lookback buttons, three summary cards, and one daily chart. */
import { useMemo } from 'react'
import { getDailyWaste, getSummaryCards } from '../data/api'
import { dailyBuckets } from '../lib/grouping'
import { useAsync } from '../lib/useAsync'
import { DateRangePicker, type DateRange } from '../components/DateRangePicker'
import { SummaryCardsRow } from '../components/SummaryCards'
import { WasteChart } from '../components/WasteChart'
import { Card, EmptyState, LoadingBlock } from '../components/ui'

export function DashboardPage({ range, onRangeChange }: { range: DateRange; onRangeChange: (r: DateRange) => void }) {
  const summary = useAsync(() => getSummaryCards(), [])
  const series = useAsync(() => getDailyWaste(range.start, range.end), [range.start, range.end])
  const buckets = useMemo(() => (series.data ? dailyBuckets(series.data) : []), [series.data])
  const hasAnyData = buckets.some((b) => b.wasteUnits !== null)

  return (
    <div className="space-y-5">
      <h1 className="font-display text-3xl font-semibold text-ink">Dashboard</h1>

      {summary.status === 'loading' && !summary.data && <LoadingBlock label="Loading totals" />}
      {summary.status === 'error' && <EmptyState title="Couldn't load totals.">{summary.error}</EmptyState>}
      {summary.data && <SummaryCardsRow data={summary.data} />}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink">Waste by day</h2>
          <DateRangePicker value={range} onChange={onRangeChange} />
        </div>
        <p className="mt-1 text-sm">Hover over or tab to a bar to see the exact number.</p>
        <div className="mt-3">
          {series.status === 'loading' && !series.data && <LoadingBlock label="Loading chart" />}
          {series.status === 'error' && <EmptyState title="Couldn't load the chart.">{series.error}</EmptyState>}
          {series.data &&
            (hasAnyData ? (
              <WasteChart buckets={buckets} />
            ) : (
              <EmptyState title="No waste recorded for these days.">
                Days show up once they have a menu and scanned plates.
              </EmptyState>
            ))}
        </div>
      </Card>
    </div>
  )
}
