/**
 * Behind the scenes: every scanned plate, its photo next to the AI outlines,
 * and each food's Pixels wasted (the raw measurement behind the estimates).
 * A second tab, "Try an Image", runs the same pipeline on one uploaded photo.
 */
import { useState } from 'react'
import { getCaptures } from '../data/api'
import { useAsync } from '../lib/useAsync'
import { DateRangePicker, rangeForDays, thisWeek, type RangePreset, type DateRange } from '../components/DateRangePicker'
import { PlatesGallery } from '../components/PlatesGallery'
import { TryImage } from '../components/TryImage'
import { EmptyState, LoadingBlock } from '../components/ui'

const PRESETS: RangePreset[] = [
  { label: 'Today', range: () => rangeForDays(1) },
  { label: 'This week', range: thisWeek },
  { label: 'Last 30 days', range: () => rangeForDays(30) },
]

export const PLATES_PATH = '/behind-the-scenes'
export const TRY_PATH = '/behind-the-scenes/try-an-image'

const TABS = [
  { id: 'plates', label: 'Scanned plates', path: PLATES_PATH },
  { id: 'try', label: 'Try an Image', path: TRY_PATH },
] as const

function ScannedPlates() {
  const [range, setRange] = useState<DateRange>(thisWeek)
  const plates = useAsync(() => getCaptures(range.start, range.end), [range.start, range.end])
  return (
    <div className="space-y-5">
      <DateRangePicker value={range} onChange={setRange} presets={PRESETS} />
      {plates.status === 'loading' && !plates.data && <LoadingBlock label="Loading plates" />}
      {plates.status === 'error' && <EmptyState title="Couldn't load the plates." />}
      {plates.data && <PlatesGallery captures={plates.data} />}
    </div>
  )
}

/** `path`/`onNavigate` come from the app shell; standalone use falls back to local state. */
export function BehindScenesPage({ path, onNavigate }: { path?: string; onNavigate?: (path: string) => void }) {
  const [localPath, setLocalPath] = useState(PLATES_PATH)
  const current = (path ?? localPath).replace(/\/+$/, '')
  const active = current === TRY_PATH ? 'try' : 'plates'
  const go = (next: string) => (onNavigate ? onNavigate(next) : setLocalPath(next))

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]
    go(next.path)
    requestAnimationFrame(() => document.getElementById(`behind-tab-${next.id}`)?.focus())
  }

  return (
    <div className="space-y-5">
      <h1 className="font-display text-3xl font-bold tracking-tight text-ink">Behind the scenes</h1>
      <div role="tablist" aria-label="Behind the scenes views" className="flex flex-wrap gap-2 border-b border-linen pb-2">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`behind-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            aria-controls="behind-panel"
            tabIndex={active === t.id ? 0 : -1}
            onClick={() => go(t.path)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`rounded-btn px-4 py-2 text-base ${
              active === t.id ? 'bg-ink font-semibold text-cream' : 'border border-linen bg-cream text-ink hover:underline'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="behind-panel" role="tabpanel" aria-labelledby={`behind-tab-${active}`}>
        {active === 'try' ? <TryImage /> : <ScannedPlates />}
      </div>
    </div>
  )
}
