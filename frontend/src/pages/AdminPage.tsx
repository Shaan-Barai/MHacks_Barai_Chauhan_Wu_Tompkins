/**
 * Admin: choose which plates the dashboard shows (2026-10-04). Lists every
 * plate in the chosen days, hidden ones included, with a Shown/Hidden toggle
 * per plate and bulk Show/Hide for the plates listed. Hiding never deletes a
 * plate; it only leaves it out of every dashboard number and gallery. Needs a
 * staff session.
 */
import { useEffect, useMemo, useState } from 'react'
import { getAdminCaptures, getCaptureImages, setCaptureVisibility } from '../data/api'
import type { AdminCaptureItem, CaptureImages } from '../data/types'
import { formatNumber } from '../lib/format'
import { useAuth } from '../state/auth'
import { DateRangePicker, rangeForDays, type DateRange } from '../components/DateRangePicker'
import { Card, EmptyState, GhostButton, LoadingBlock, PrimaryButton } from '../components/ui'

type Filter = 'all' | 'shown' | 'hidden'
const FILTERS: { filter: Filter; label: string }[] = [
  { filter: 'all', label: 'All' },
  { filter: 'shown', label: 'Shown' },
  { filter: 'hidden', label: 'Hidden' },
]

function when(iso: string): string {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function meal(serviceId: string): string {
  const m = serviceId.match(/_(breakfast|lunch|dinner)$/)
  return m ? m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1) : ''
}

function result(c: AdminCaptureItem): string {
  if (c.state === 'failed') return 'Check failed'
  if (c.state === 'pending' || c.state === 'processing') return 'Being checked'
  if (c.pixelsWasted === null) return 'Not counted'
  return `${formatNumber(c.pixelsWasted)} pixels`
}

/** Loads image links a few at a time so a long list doesn't flood the server. */
function useImages(ids: string[]): Record<string, CaptureImages | 'error'> {
  const [images, setImages] = useState<Record<string, CaptureImages | 'error'>>({})
  const key = ids.join('|')
  useEffect(() => {
    let alive = true
    const queue = ids.filter((id) => !(id in images))
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined && alive; id = queue.shift()) {
        const loaded = await getCaptureImages(id).catch(() => 'error' as const)
        if (alive) setImages((m) => ({ ...m, [id]: loaded }))
      }
    }
    void Promise.all(Array.from({ length: 6 }, worker))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return images
}

export function AdminPage() {
  const { canEdit, status, openSignIn } = useAuth()
  const [range, setRange] = useState<DateRange>(() => rangeForDays(90))
  const [plates, setPlates] = useState<AdminCaptureItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!canEdit) return
    let alive = true
    setPlates(null)
    setError(null)
    getAdminCaptures(range.start, range.end).then(
      (list) => alive && setPlates(list),
      (err: Error) => alive && setError(err.message),
    )
    return () => {
      alive = false
    }
  }, [canEdit, range.start, range.end])

  const visible = useMemo(
    () => (plates ?? []).filter((p) => filter === 'all' || (filter === 'hidden') === p.hidden),
    [plates, filter],
  )
  const images = useImages(visible.map((p) => p.eventId))

  async function change(eventIds: string[], hidden: boolean) {
    if (eventIds.length === 0) return
    setSaving(true)
    setError(null)
    try {
      await setCaptureVisibility(eventIds, hidden)
      const ids = new Set(eventIds)
      setPlates((list) => list && list.map((p) => (ids.has(p.eventId) ? { ...p, hidden } : p)))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (status === 'checking') return <LoadingBlock label="Checking sign-in" />
  if (!canEdit) {
    return (
      <div className="space-y-5">
        <h1 className="font-display text-3xl font-semibold text-ink">Admin</h1>
        <Card>
          <PrimaryButton type="button" onClick={() => openSignIn('Sign in to choose which plates are shown.')}>
            Sign in
          </PrimaryButton>
        </Card>
      </div>
    )
  }

  const counts = {
    all: plates?.length ?? 0,
    shown: plates?.filter((p) => !p.hidden).length ?? 0,
    hidden: plates?.filter((p) => p.hidden).length ?? 0,
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl font-semibold text-ink">Admin</h1>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Which plates to list">
            {FILTERS.map((f) => (
              <button
                key={f.filter}
                type="button"
                aria-pressed={filter === f.filter}
                onClick={() => setFilter(f.filter)}
                className={`rounded-btn border border-ink px-3 py-1.5 text-base ${filter === f.filter ? 'bg-ink font-semibold text-cream' : 'bg-cream text-ink hover:underline'}`}
              >
                {f.label} ({formatNumber(counts[f.filter])})
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <GhostButton type="button" disabled={saving || visible.every((p) => !p.hidden)} onClick={() => change(visible.filter((p) => p.hidden).map((p) => p.eventId), false)}>
              Show all listed
            </GhostButton>
            <GhostButton type="button" disabled={saving || visible.every((p) => p.hidden)} onClick={() => change(visible.filter((p) => !p.hidden).map((p) => p.eventId), true)}>
              Hide all listed
            </GhostButton>
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-3 font-semibold">
            {error}
          </p>
        )}

        {plates === null && !error && <LoadingBlock label="Loading plates" />}
        {plates !== null && visible.length === 0 && <EmptyState title="No plates here." />}
        {visible.length > 0 && (
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {visible.map((p) => {
              const img = images[p.eventId]
              const src = img && img !== 'error' ? (img.overlay ?? img.original)?.url : undefined
              return (
                <li key={p.eventId} className={`overflow-hidden rounded-card border border-ink bg-cream ${p.hidden ? 'opacity-50' : ''}`}>
                  {src ? (
                    <img src={src} alt={`Plate at ${when(p.capturedAt)}`} className="aspect-square w-full border-b border-ink object-cover" />
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center border-b border-dashed border-ink text-sm">
                      {img === 'error' ? 'Photo unavailable' : 'Loading photo'}
                    </div>
                  )}
                  <div className="space-y-2 p-2">
                    <p className="text-sm">
                      {when(p.capturedAt)} · {meal(p.serviceId)}
                    </p>
                    <p className="text-base font-semibold">{result(p)}</p>
                    <button
                      type="button"
                      disabled={saving}
                      aria-pressed={!p.hidden}
                      aria-label={`${p.hidden ? 'Show' : 'Hide'} the plate at ${when(p.capturedAt)}`}
                      onClick={() => change([p.eventId], !p.hidden)}
                      className={`w-full rounded-btn border border-ink px-3 py-1.5 text-base font-semibold ${p.hidden ? 'bg-cream text-ink' : 'bg-ink text-cream'}`}
                    >
                      {p.hidden ? 'Hidden' : 'Shown'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}
