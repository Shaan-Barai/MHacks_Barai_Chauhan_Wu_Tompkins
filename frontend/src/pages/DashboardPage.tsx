/**
 * Middle column (UI.md): date picker, three summary cards, ONE main chart with
 * a Daily/Weekly/Monthly toggle above it. Nothing else.
 */
import { useMemo, useState } from 'react'
import { getDailyWaste, getSummaryCards } from '../data/api'
import { groupPoints, type Grouping } from '../lib/grouping'
import { useAsync } from '../lib/useAsync'
import { DateRangePicker, type DateRange } from '../components/DateRangePicker'
import { SummaryCardsRow } from '../components/SummaryCards'
import { WasteChart } from '../components/WasteChart'
import { Card, EmptyState, LoadingBlock } from '../components/ui'

const GROUPINGS: { value: Grouping; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
]

export function DashboardPage({ range, onRangeChange }: { range: DateRange; onRangeChange: (r: DateRange) => void }) {
  const [grouping, setGrouping] = useState<Grouping>('daily')

  const summary = useAsync(() => getSummaryCards(), [])
  const series = useAsync(() => getDailyWaste(range.start, range.end), [range.start, range.end])
  const buckets = useMemo(
    () => (series.data ? groupPoints(series.data, grouping) : []),
    [series.data, grouping],
  )
  const hasAnyData = buckets.some((b) => b.pixelsWasted !== null)

  return (
    <div className="space-y-5">
      <h1 className="font-display text-3xl font-semibold text-ink">Dashboard</h1>

      <DateRangePicker value={range} onChange={onRangeChange} />

      {summary.status === 'loading' && !summary.data && <LoadingBlock label="Loading waste totals…" />}
      {summary.status === 'error' && <EmptyState title="Couldn't load totals.">{summary.error}</EmptyState>}
      {summary.data && <SummaryCardsRow data={summary.data} />}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink">Waste over time</h2>
          <div role="radiogroup" aria-label="Chart grouping" className="flex rounded-btn border border-linen bg-oat p-1">
            {GROUPINGS.map((g) => (
              <button
                key={g.value}
                role="radio"
                aria-checked={grouping === g.value}
                onClick={() => setGrouping(g.value)}
                className={`rounded-[6px] px-3 py-1 text-base transition-colors ${
                  grouping === g.value ? 'bg-basil font-semibold text-cream' : 'text-ink hover:bg-basil-tint'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-1 text-sm text-thyme">
          Pixels wasted per {grouping === 'daily' ? 'day' : grouping === 'weekly' ? 'week' : 'month'} — counted inside AI-drawn
          leftover-food outlines. Hover or focus a bar for the exact value.
        </p>
        <div className={`mt-3 ${series.status === 'loading' && series.data ? 'opacity-60' : ''}`}>
          {series.status === 'loading' && !series.data && <LoadingBlock label="Loading chart…" />}
          {series.status === 'error' && <EmptyState title="Couldn't load the chart.">{series.error}</EmptyState>}
          {series.data &&
            (hasAnyData ? (
              <WasteChart buckets={buckets} />
            ) : (
              <EmptyState title="No waste data in this date range yet.">
                Data appears for days that have a menu and scanned plates. Try a different range, or add menus in Menus.
              </EmptyState>
            ))}
        </div>
      </Card>
    </div>
  )
}
