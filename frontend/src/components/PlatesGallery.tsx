/**
 * Plates gallery: recent scanned plates as a thumbnail grid. Opening one shows
 * the original photo and the AI outline image (the segmented overlay), as a
 * toggle or side by side, with each food's Pixels wasted. Only the scanned
 * plate is counted; food on a neighboring plate is outlined as "Other dish
 * (not counted)" in the AI outline image and left out (BIG-PLAN v2 V3).
 *
 * Tiles show the AI outline image when there is one, analyzed plates come
 * first, and the newest analyzed plate opens side by side, so the segmented
 * images are visible without a click (demo, 2026-10-04).
 *
 * The photo shown is the full original as the camera took it (raw) when the
 * scan has one, else the normalized photo the AI checked. Any image opens
 * larger on click. Generated sample scans (source 'demo') have no photos and
 * are left out of the gallery.
 *
 * Image links are short-lived (GET /api/captures/:id/images). A link that is
 * expired or fails to load is renewed once by asking for the images again;
 * if the fresh link fails too, the image says it is unavailable.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getCaptureImages } from '../data/api'
import type { CaptureImages, CaptureListItem, ProcessingState, SignedImage } from '../data/types'
import { formatNumber } from '../lib/format'
import { PhysicalChips, hasPhysical } from './PhysicalChips'
import { Badge, Card, GhostButton } from './ui'

const SHOW_FIRST = 12
/** Analyzed plates first (newest first within each group), failed and unchecked plates last. */
function analyzedFirst(captures: CaptureListItem[]): CaptureListItem[] {
  const rank = (c: CaptureListItem) => (c.state === 'succeeded' || c.state === 'needs_review' ? 0 : 1)
  return captures.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map(({ c }) => c)
}

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
      if (entry.status === 'ready' && (isExpired(entry.images.original) || isExpired(entry.images.overlay) || isExpired(entry.images.raw ?? null))) {
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
      const urls = [entry.images.original?.url, entry.images.overlay?.url, entry.images.raw?.url]
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
  if (c.state === 'failed') return 'Check failed'
  if (c.state === 'pending' || c.state === 'processing') return 'Being checked'
  if (c.state === 'needs_review') return 'Needs a person to look'
  if (c.notCountedReason) return 'Not counted'
  if (c.pixelsWasted === 0) return 'Clean plate'
  if (c.pixelsWasted !== null) return `${formatNumber(c.pixelsWasted)} pixels`
  return 'Partly checked'
}

function ImageBox({
  image,
  alt,
  entry,
  missingText,
  onBroken,
  onEnlarge,
  className = '',
}: {
  image: SignedImage | null | undefined
  alt: string
  entry: ImageEntry | undefined
  missingText: string
  onBroken: (url: string) => void
  onEnlarge?: (image: SignedImage, alt: string) => void
  className?: string
}) {
  const box = `flex aspect-square w-full items-center justify-center border border-ink p-3 text-center text-sm ${className}`
  if (!entry || entry.status === 'loading') return <div className={box} role="status" aria-busy="true"><span className="sr-only">Loading photo</span></div>
  if (entry.status === 'error') return <div className={`${box} border-dashed`}>Photo unavailable</div>
  if (!image) return <div className={`${box} border-dashed`}>{missingText}</div>
  const img = (
    <img
      src={image.url}
      alt={alt}
      onError={() => onBroken(image.url)}
      className={`aspect-square w-full border border-ink bg-ink object-contain ${className}`}
    />
  )
  if (!onEnlarge) return img
  return (
    <button type="button" onClick={() => onEnlarge(image, alt)} className="block w-full cursor-zoom-in" aria-label={`Enlarge: ${alt}`}>
      {img}
    </button>
  )
}

/** Full-size view of one image; Escape or the Close button closes it. */
function Lightbox({ image, alt, onClose }: { image: SignedImage; alt: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-ink/90 p-4"
      onClick={onClose}
    >
      <img src={image.url} alt={alt} className="max-h-[85vh] max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        className="rounded-btn border border-linen bg-cream px-5 py-2.5 text-base font-medium text-ink hover:underline"
      >
        Close
      </button>
    </div>
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
  focusOnOpen = true,
}: {
  capture: CaptureListItem
  entry: ImageEntry | undefined
  onBroken: (url: string) => void
  onClose: () => void
  /** False for the plate opened automatically on load, so the page doesn't scroll to it. */
  focusOnOpen?: boolean
}) {
  const [view, setView] = useState<View>('both')
  const anyEstimate = capture.items.some(hasPhysical)
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (focusOnOpen) headingRef.current?.focus()
  }, [capture.eventId, focusOnOpen])

  const images = entry?.status === 'ready' ? entry.images : null
  const photo = images?.raw ?? images?.original
  const isRaw = Boolean(images?.raw)
  const [enlarged, setEnlarged] = useState<{ image: SignedImage; alt: string } | null>(null)
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
            {STATE_TEXT[capture.state]} · {capture.source === 'replay' ? 'Test photo' : capture.source === 'camera' ? 'Camera' : 'Uploaded photo'}
          </p>
        </div>
        <GhostButton type="button" onClick={onClose}>
          Close
        </GhostButton>
      </div>

      <div className="mt-3 inline-flex rounded-full border border-ink p-0.5" role="group" aria-label="How to show the plate">
        {VIEWS.map((v) => (
          <button
            key={v.view}
            type="button"
            aria-pressed={view === v.view}
            onClick={() => setView(v.view)}
            className={`rounded-full px-3 py-1 text-sm font-medium ${view === v.view ? 'bg-ink text-cream' : 'bg-cream text-ink hover:opacity-70'}`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className={`mt-3 grid gap-4 ${view === 'both' ? 'sm:grid-cols-2' : 'max-w-xl'}`}>
        {view !== 'outlines' && (
          <figure>
            <ImageBox
              image={photo}
              entry={entry}
              alt={`Photo of the plate at ${when}`}
              missingText="No photo for this plate"
              onBroken={onBroken}
              onEnlarge={(image, alt) => setEnlarged({ image, alt })}
            />
            <figcaption className="mt-1 text-sm">{isRaw ? 'Original' : 'Photo'}</figcaption>
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
              onEnlarge={(image, alt) => setEnlarged({ image, alt })}
            />
            <figcaption className="mt-1 text-sm">AI outlines</figcaption>
          </figure>
        )}
      </div>

      <div className="mt-4">
        {capture.state === 'failed' ? (
          <p>Check failed.</p>
        ) : capture.state === 'pending' || capture.state === 'processing' ? (
          <p>Being checked.</p>
        ) : capture.items.length === 0 ? (
          <p>{capture.pixelsWasted === 0 ? 'Clean plate.' : 'No foods found.'}</p>
        ) : (
          <table className="w-full max-w-2xl text-left text-base">
            <caption className="sr-only">Foods left on this plate</caption>
            <thead>
              <tr className="border-b border-ink text-sm">
                <th scope="col" className="py-1 pr-2">Food</th>
                <th scope="col" className="py-1 pr-2">Pixels wasted</th>
                {anyEstimate && (
                  <th scope="col" className="py-1 font-normal">
                    Estimate
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {capture.items.map((it, i) => (
                <tr key={`${it.itemId ?? 'unknown'}-${i}`} className="border-b border-ink">
                  <th scope="row" className="py-1 pr-2 font-semibold">
                    {it.displayName}
                    {it.itemId === null && <span className="font-normal"> (not on menu)</span>}
                  </th>
                  <td className="py-1 pr-2">{formatNumber(it.pixels)}</td>
                  {anyEstimate && (
                    <td className="py-1">
                      <PhysicalChips amounts={it} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {enlarged && <Lightbox image={enlarged.image} alt={enlarged.alt} onClose={() => setEnlarged(null)} />}
    </Card>
  )
}


function Thumbnail({ entry, onBroken }: { entry: ImageEntry | undefined; onBroken: (url: string) => void }) {
  const overlay = entry?.status === 'ready' ? entry.images.overlay : null
  const img = overlay ?? (entry?.status === 'ready' ? entry.images.original : null)
  if (entry?.status === 'ready' && img) {
    return (
      <span className="relative block">
        <img src={img.url} alt="" onError={() => onBroken(img.url)} className="aspect-square w-full border-b border-ink object-cover" />
        {overlay && <span className="absolute left-2 top-2 rounded-btn bg-ink px-2 py-0.5 text-xs font-semibold text-cream">AI outline</span>}
      </span>
    )
  }
  if (!entry || entry.status === 'loading') {
    return (
      <div className="aspect-square w-full animate-pulse border-b border-ink bg-ink/5" aria-busy="true">
        <span className="sr-only">Loading photo</span>
      </div>
    )
  }
  return <div className="flex aspect-square w-full items-center justify-center border-b border-dashed border-ink text-sm">Photo unavailable</div>
}

export function PlatesGallery({
  captures: allCaptures,
  loadImages = getCaptureImages,
}: {
  captures: CaptureListItem[]
  loadImages?: Loader
}) {
  const { entries, ensure, renew } = useCaptureImageCache(loadImages)
  const [showAll, setShowAll] = useState(false)
  // Sample scans have no photos; the gallery shows real (camera and test-photo) scans only.
  const captures = allCaptures.filter((c) => c.source !== 'demo')
  const ordered = analyzedFirst(captures)
  // undefined = the user hasn't picked yet: show the newest analyzed plate.
  const [picked, setPicked] = useState<string | null | undefined>(undefined)
  const selectedId = picked === undefined ? (ordered.find((c) => c.state === 'succeeded')?.eventId ?? null) : picked
  const setSelectedId = (id: string | null) => setPicked(id)
  const visible = showAll ? ordered : ordered.slice(0, SHOW_FIRST)
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
        <h2 className="text-lg font-semibold text-ink">Plates</h2>
        <p className="text-sm">{formatNumber(captures.length)}</p>
      </div>

      {captures.length === 0 ? (
        <p className="mt-3 rounded-card border border-dashed border-ink p-6 text-center">No plates.</p>
      ) : (
        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((c) => (
            <li key={c.eventId}>
              <button
                type="button"
                onClick={() => {
                  setSelectedId(c.eventId)
                  ensure(c.eventId) // renew expired links even if this plate is already open
                }}
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
                      <Badge>test photo</Badge>
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
          focusOnOpen={picked !== undefined}
        />
      )}
    </Card>
  )
}
