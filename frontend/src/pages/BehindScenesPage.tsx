/**
 * Behind the scenes: every scanned plate, its photo next to the AI outlines,
 * and each food's Pixels wasted (the raw measurement behind the estimates).
 */
import { useState } from 'react'
import { getCaptures } from '../data/api'
import { useAsync } from '../lib/useAsync'
import { DateRangePicker, rangeForDays, thisWeek, type RangePreset, type DateRange } from '../components/DateRangePicker'
import { PlatesGallery } from '../components/PlatesGallery'
import { EmptyState, LoadingBlock } from '../components/ui'

const PRESETS: RangePreset[] = [
  { label: 'Today', range: () => rangeForDays(1) },
  { label: 'This week', range: thisWeek },
  { label: 'Last 30 days', range: () => rangeForDays(30) },
]

export function BehindScenesPage() {
  const [range, setRange] = useState<DateRange>(thisWeek)
  const plates = useAsync(() => getCaptures(range.start, range.end), [range.start, range.end])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl font-bold tracking-tight text-ink">Behind the scenes</h1>
        <DateRangePicker value={range} onChange={setRange} presets={PRESETS} />
      </div>
      {plates.status === 'loading' && !plates.data && <LoadingBlock label="Loading plates" />}
      {plates.status === 'error' && <EmptyState title="Couldn't load the plates." />}
      {plates.data && <PlatesGallery captures={plates.data} />}
    </div>
  )
}
