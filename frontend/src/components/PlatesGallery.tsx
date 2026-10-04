/**
 * Plates gallery: recent scanned plates as a thumbnail grid. Opening one shows
 * the original photo and the AI outline image (the segmented overlay), as a
 * toggle or side by side, with each food's Pixels wasted. Only the scanned
 * plate is counted; food on a neighboring plate is outlined as "Other dish
 * (not counted)" in the AI outline image and left out (BIG-PLAN v2 V3).
 *
 * Image links are short-lived (GET /api/captures/:id/images). A link that is
 * expired or fails to load is renewed once by asking for the images again;
 * if the fresh link fails too, the image says it is unavailable.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { getCaptureImages } from '../data/api'
import type { CaptureImages, CaptureListItem, ProcessingState, SignedImage } from '../data/types'
import { formatNumber } from '../lib/format'
import { NEIGHBOR_EXPLANATION } from './impactCopy'
import { Badge, Card, GhostButton, InfoTip } from './ui'

const SHOW_FIRST = 12
/** Renew a link this long before it expires. */
const EXPIRY_MARGIN_MS = 30_000

export const STATE_TEXT: Record<ProcessingState, string> = {
  pending: 'Waiting to be checked',
  processing: 'Being checked',
  succeeded: 'Checked',
  needs_review: 'Needs a person to look',
  failed: 'Check failed',
}

type ImageEntry = { status: 'loading' } | { status: 'ready'; images: CaptureImages; renewed: boolean } | { status: 'error'; renewed: boolean }

type Loader = (eventId: string) => Promise<CaptureImages>

function isExpired(img: SignedImage | null, now = Date.now()): boolean {
  if (!img) return false
  const t = Date.parse(img.expiresAt)
  return Number.isFinite(t) && t - EXPIRY_MARGIN_MS <= now
}

/** Per-gallery cache of signed image links, with one renewal per plate after a failure. */
function useCaptureImageCache(load: Loader) {
  const [entries, setEntries] = useState<Record<string, ImageEntry>>({})
  const ref = useRef(entries)
  ref.current = entries
  const inFlight = useRef(new Set<string>())

  const fetchImages = useCallback(
    (eventId: string, renewed: boolean) => {
      if (inFlight.current.has(eventId)) return
      inFlight.current.add(eventId)
      setEntries((e) => (e[eventId]?.status === 'ready' ? e : { ...e, [eventId]: { status: 'loading' } }))
      load(eventId).then(
        (images) => {
          inFlight.current.delete(eventId)
          setEntries((e) => ({ ...e, [eventId]: { status: 'ready', images, renewed } }))
        },
        () => {
          inFlight.current.delete(eventId)
          setEntries((e) => ({ ...e, [eventId]: { status: 'error', renewed } }))
        },
      )
    },
    [load],
  )

  /** Load once; refresh links that are about to expire. */
  const ensure = useCallback(
    (eventId: string) => {
      const entry = ref.current[eventId]
      if (!entry) return fetchImages(eventId, false)
      if (entry.status === 'error' && !entry.renewed) return fetchImages(eventId, true)
      if (entry.status === 'ready' && (isExpired(entry.images.original) || isExpired(entry.images.overlay))) {
        fetchImages(eventId, false)
      }
    },
    [fetchImages],
  )

  /** An <img> failed to load `failedUrl`: renew the links once, then give up. */
  const renew = useCallback(
    (eventId: string, failedUrl: string) => {
      const entry = ref.current[eventId]
      if (!entry || entry.status !== 'ready') return
      const urls = [entry.images.original?.url, entry.images.overlay?.url]
      if (!urls.includes(failedUrl)) return // already replaced by a fresh link
      if (entry.renewed) {
        setEntries((e) => ({ ...e, [eventId]: { status: 'error', renewed: true } }))
        return
      }
      fetchImages(eventId, true)
    },
    [fetchImages],
  )

  return { entries, ensure, renew }
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function tileSummary(c: CaptureListItem): string {
  if (c.state === 'failed') return 'Check failed. Not in the totals.'
  if (c.state === 'pending' || c.state === 'processing') return 'Being checked'
  if (c.state === 'needs_review') return 'Needs a person to look'
  if (c.pixelsWasted === 0) return 'Clean plate'
  if (c.pixelsWasted !== null) return `${formatNumber(c.pixelsWasted)} pixels wasted`
  return 'Only partly checked. Not in the totals.'
}

function ImageBox({
  image,
  alt,
  entry,
  missingText,
  onBroken,
  className = '',
}: {
  image: SignedImage | null | undefined
  alt: string
  entry: ImageEntry | undefined
  missingText: string
  onBroken: (url: string) => void
  className?: string
}) {
  const box = `flex aspect-square w-full items-center justify-center border border-ink p-3 text-center text-sm ${className}`
  if (!entry || entry.status === 'loading') return <div className={box} role="status">Loading photo</div>
  if (entry.status === 'error') return <div className={`${box} border-dashed`}>Photo unavailable</div>
  if (!image) return <div className={`${box} border-dashed`}>{missingText}</div>
  return (
    <img
      src={image.url}
      alt={alt}
      onError={() => onBroken(image.url)}
      className={`aspect-square w-full border border-ink bg-ink object-contain ${className}`}
    />
  )
}

type View = 'both' | 'photo' | 'outlines'
const VIEWS: { view: View; label: string }[] = [
  { view: 'both', label: 'Side by side' },
  { view: 'photo', label: 'Photo' },
  { view: 'outlines', label: 'AI outlines' },
]

function PlateViewer({
  capture,
  entry,
  onBroken,
  onClose,
}: {
  capture: CaptureListItem
  entry: ImageEntry | undefined
  onBroken: (url: string) => void
  onClose: () => void
}) {
  const [view, setView] = useState<View>('both')
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [capture.eventId])

  const images = entry?.status === 'ready' ? entry.images : null
  const when = timeLabel(capture.capturedAt)
  const noOverlayText = capture.state === 'failed' ? 'No AI outlines: the check failed' : 'No AI outline image for this plate yet'

  return (
    <Card className="mt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
            Plate at {when}
          </h3>
          <p className="text-sm">
            {STATE_TEXT[capture.state]} · {capture.source === 'replay' ? 'Demo photo' : capture.source === 'camera' ? 'Camera' : 'Uploaded photo'}
          </p>
        </div>
        <GhostButton type="button" onClick={onClose}>
          Close
        </GhostButton>
      </div>

      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="How to show the plate">
        {VIEWS.map((v) => (
          <button
            key={v.view}
            type="button"
            aria-pressed={view === v.view}
            onClick={() => setView(v.view)}
            className={`rounded-btn border border-ink px-3 py-1.5 text-base ${view === v.view ? 'bg-ink font-semibold text-cream' : 'bg-cream text-ink hover:underline'}`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className={`mt-3 grid gap-4 ${view === 'both' ? 'sm:grid-cols-2' : 'max-w-xl'}`}>
        {view !== 'outlines' && (
          <figure>
            <ImageBox
              image={images?.original}
              entry={entry}
              alt={`Photo of the plate at ${when}`}
              missingText="No photo for this plate"
              onBroken={onBroken}
            />
            <figcaption className="mt-1 text-sm">Photo</figcaption>
          </figure>
        )}
        {view !== 'photo' && (
          <figure>
            <ImageBox
              image={images?.overlay}
              entry={entry}
              alt={`The same plate with the leftover food the AI outlined, at ${when}`}
              missingText={noOverlayText}
              onBroken={onBroken}
            />
            <figcaption className="mt-1 text-sm">AI outlines of the leftover food on the scanned plate</figcaption>
          </figure>
        )}
      </div>

      <div className="mt-4">
        {capture.state === 'failed' ? (
          <p>The AI couldn't check this plate, so it is not in the totals.</p>
        ) : capture.state === 'pending' || capture.state === 'processing' ? (
          <p>This plate is still being checked.</p>
        ) : capture.items.length === 0 ? (
          <p>{capture.pixelsWasted === 0 ? 'Clean plate. No food left.' : 'No foods found yet.'}</p>
        ) : (
          <table className="w-full max-w-xl text-left text-base">
            <caption className="sr-only">Foods left on this plate</caption>
            <thead>
              <tr className="border-b border-ink text-sm">
                <th scope="col" className="py-1 pr-2">Food</th>
                <th scope="col" className="py-1">Pixels wasted</th>
              </tr>
            </thead>
            <tbody>
              {capture.items.map((it, i) => (
                <tr key={`${it.itemId ?? 'unknown'}-${i}`} className="border-b border-ink">
                  <th scope="row" className="py-1 pr-2 font-semibold">
                    {it.displayName}
                    {it.itemId === null && <span className="font-normal"> (not on the menu)</span>}
                  </th>
                  <td className="py-1">{formatNumber(it.pixels)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {capture.state === 'needs_review' && <p className="mt-2 text-sm">A person should check these labels before relying on them.</p>}
      </div>
    </Card>
  )
}

function Thumbnail({ entry, onBroken }: { entry: ImageEntry | undefined; onBroken: (url: string) => void }) {
  const img = entry?.status === 'ready' ? entry.images.original : null
  if (entry?.status === 'ready' && img) {
    return <img src={img.url} alt="" onError={() => onBroken(img.url)} className="aspect-square w-full border-b border-ink object-cover" />
  }
  const text = !entry || entry.status === 'loading' ? 'Loading photo' : 'Photo unavailable'
  return <div className="flex aspect-square w-full items-center justify-center border-b border-dashed border-ink text-sm">{text}</div>
}

export function PlatesGallery({
  captures,
  neighborExcluded = 0,
  loadImages = getCaptureImages,
}: {
  captures: CaptureListItem[]
  /** coverage.capturesWithNeighborFoodExcluded for the same days. */
  neighborExcluded?: number
  loadImages?: Loader
}) {
  const neighborTip = useId()
  const { entries, ensure, renew } = useCaptureImageCache(loadImages)
  const [showAll, setShowAll] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const visible = showAll ? captures : captures.slice(0, SHOW_FIRST)
  const selected = captures.find((c) => c.eventId === selectedId) ?? null

  useEffect(() => {
    for (const c of visible) ensure(c.eventId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.map((c) => c.eventId).join('|'), ensure])

  useEffect(() => {
    if (selectedId) ensure(selectedId)
  }, [selectedId, ensure])

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold text-ink">Plates</h2>
        <p className="text-sm">
          {formatNumber(captures.length)} recent plate{captures.length === 1 ? '' : 's'}
        </p>
      </div>
      <p className="mt-1 text-sm">Pick a plate to see its photo next to what the AI outlined.</p>
      {neighborExcluded > 0 && (
        <p className="mt-1 text-sm">
          Food on neighboring plates was left out of {formatNumber(neighborExcluded)} plate{neighborExcluded === 1 ? '' : 's'}.
          <InfoTip id={neighborTip} text={NEIGHBOR_EXPLANATION} />
        </p>
      )}

      {captures.length === 0 ? (
        <p className="mt-3 rounded-card border border-dashed border-ink p-6 text-center">No plates were scanned in these days.</p>
      ) : (
        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((c) => (
            <li key={c.eventId}>
              <button
                type="button"
                onClick={() => setSelectedId(c.eventId === selectedId ? null : c.eventId)}
                aria-pressed={c.eventId === selectedId}
                aria-label={`Plate at ${timeLabel(c.capturedAt)}: ${tileSummary(c)}`}
                className={`block w-full overflow-hidden rounded-card border bg-cream text-left ${c.eventId === selectedId ? 'border-[3px] border-ink' : 'border-ink'}`}
              >
                <Thumbnail entry={entries[c.eventId]} onBroken={(url) => renew(c.eventId, url)} />
                <span className="block p-2">
                  <span className="block text-sm">{timeLabel(c.capturedAt)}</span>
                  <span className="block text-base font-semibold">{tileSummary(c)}</span>
                  {c.source === 'replay' && (
                    <span className="mt-1 block">
                      <Badge>demo photo</Badge>
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {captures.length > SHOW_FIRST && (
        <GhostButton type="button" className="mt-3" onClick={() => setShowAll((s) => !s)} aria-expanded={showAll}>
          {showAll ? 'Show fewer plates' : `Show all ${captures.length} plates`}
        </GhostButton>
      )}

      {selected && (
        <PlateViewer
          capture={selected}
          entry={entries[selected.eventId]}
          onBroken={(url) => renew(selected.eventId, url)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </Card>
  )
}
