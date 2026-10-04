/** Estimated carbon emissions per day for the selected days. */
import { useMemo } from 'react'
import { getDailyImpact } from '../data/api'
import { carbonBuckets } from '../lib/grouping'
import { useAsync } from '../lib/useAsync'
import type { DateRange } from './DateRangePicker'
import { Card, EmptyState, LoadingBlock } from './ui'
import { WasteChart } from './WasteChart'

export function CarbonByDay({ range, refresh = 0 }: { range: DateRange; refresh?: number }) {
  const series = useAsync(() => getDailyImpact(range.start, range.end), [range.start, range.end, refresh])
  const buckets = useMemo(() => (series.data ? carbonBuckets(series.data) : []), [series.data])
  return (
    <Card>
      <h2 className="text-lg font-semibold text-ink">Carbon emissions by day</h2>
      <div className="mt-3">
        {series.status === 'loading' && !series.data && <LoadingBlock label="Loading chart" />}
        {series.status === 'error' && <EmptyState title="Couldn't load the chart." />}
        {series.data &&
          (buckets.some((b) => b.value !== null) ? <WasteChart buckets={buckets} /> : <EmptyState title="No data for these days." />)}
      </div>
    </Card>
  )
}
