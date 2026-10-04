/**
 * Try an Image: upload one plate photo and watch Gemini + SAM 2.1 count the
 * leftover pixels. Results are temporary (nothing is added to the dashboard).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getTryImageJob, getTryImageSample, getTryImageStatus, submitTryImage } from '../data/api'
import type { TryImageJob, TryImageStatus } from '../data/types'
import { Card, GhostButton, PrimaryButton } from './ui'

export const TRY_POLL_MS = 1500

const fmt = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—')

type Phase =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'working'; id: string; job: { status: 'queued' | 'running'; position?: number } }
  | { kind: 'done'; job: TryImageJob }
  | { kind: 'error'; message: string }

const PICTURES = [
  { key: 'original', caption: 'Original photo' },
  { key: 'boxes', caption: "Gemini's food boxes" },
  { key: 'masks', caption: 'SAM 2.1 masks' },
  { key: 'final', caption: 'Counted result' },
] as const

function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
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
      <img src={src} alt={alt} className="max-h-[85vh] max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
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

function Results({ job, onReset }: { job: TryImageJob; onReset: () => void }) {
  const [enlarged, setEnlarged] = useState<{ src: string; alt: string } | null>(null)
  const close = useCallback(() => setEnlarged(null), [])
  const s = job.summary
  const foods = s?.foods ?? []
  const partial = s?.countStatus === 'partial'
  return (
    <div className="space-y-5">
      <Card>
        <p className="text-sm font-medium text-ink/80">Pixels wasted{partial ? ' (partial)' : ''}</p>
        <p className="font-display text-4xl font-bold text-ink" data-testid="try-total">
          {fmt(s?.capturePixelsWasted)} <span className="text-lg font-medium">pixels</span>
        </p>
        <p className="mt-2 text-sm text-ink/80">
          Pixels wasted counts visible leftover-food pixels in AI masks; it is not grams.
        </p>
      </Card>

      <Card>
        <h2 className="font-display text-xl font-bold text-ink">By food</h2>
        {foods.length === 0 ? (
          <p className="mt-2 text-base text-ink">No menu food was found on this plate.</p>
        ) : (
          <table className="mt-2 w-full text-left text-base">
            <thead>
              <tr className="border-b border-linen">
                <th scope="col" className="py-2 pr-3 font-semibold">Food</th>
                <th scope="col" className="py-2 text-right font-semibold">Pixels wasted (pixels)</th>
              </tr>
            </thead>
            <tbody>
              {foods.map((f, i) => (
                <tr key={`${f.itemId ?? 'unclassified'}-${i}`} className="border-b border-linen last:border-0">
                  <td className="py-2 pr-3">{f.food ?? '—'}</td>
                  <td className="py-2 text-right tabular-nums">{fmt(f.pixelsWasted)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {PICTURES.map(({ key, caption }) => {
          const src = job.images?.[key] ?? null
          return (
            <figure key={key} className="space-y-1">
              {src ? (
                <button
                  type="button"
                  onClick={() => setEnlarged({ src, alt: caption })}
                  className="block w-full cursor-zoom-in"
                  aria-label={`Enlarge: ${caption}`}
                >
                  <img src={src} alt={caption} className="w-full rounded-card border border-linen" />
                </button>
              ) : (
                <div className="flex h-40 items-center justify-center rounded-card border border-dashed border-linen text-sm">
                  Picture not available
                </div>
              )}
              <figcaption className="text-sm font-medium text-ink">{caption}</figcaption>
            </figure>
          )
        })}
      </div>

      <GhostButton onClick={onReset}>Try another photo</GhostButton>
      {enlarged && <Lightbox src={enlarged.src} alt={enlarged.alt} onClose={close} />}
    </div>
  )
}

export function TryImage() {
  const [status, setStatus] = useState<TryImageStatus | null>(null)
  const [statusFailed, setStatusFailed] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const fileRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const loadStatus = useCallback(() => {
    getTryImageStatus().then(
      (s) => alive.current && (setStatus(s), setStatusFailed(false)),
      () => alive.current && setStatusFailed(true),
    )
  }, [])
  useEffect(loadStatus, [loadStatus])

  const jobId = phase.kind === 'working' ? phase.id : null
  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const job = await getTryImageJob(jobId)
        if (cancelled) return
        if (job.status === 'done') return setPhase({ kind: 'done', job })
        if (job.status === 'failed') {
          return setPhase({ kind: 'error', message: job.error?.message ?? 'The analysis failed. Please try again.' })
        }
        setPhase({ kind: 'working', id: jobId, job: { status: job.status, position: job.position } })
      } catch (err) {
        if (cancelled) return
        return setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' })
      }
      timer = setTimeout(tick, TRY_POLL_MS)
    }
    timer = setTimeout(tick, TRY_POLL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [jobId])

  const send = async (getBlob: () => Promise<Blob>) => {
    setPhase({ kind: 'sending' })
    try {
      const blob = await getBlob()
      const sub = await submitTryImage(blob)
      if (!alive.current) return
      setPhase({ kind: 'working', id: sub.id, job: { status: 'queued', position: sub.position } })
    } catch (err) {
      if (!alive.current) return
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' })
      loadStatus()
    }
  }

  const reset = () => {
    setPhase({ kind: 'idle' })
    loadStatus()
  }

  const unavailable = status !== null && !status.available
  const busy = phase.kind === 'sending' || phase.kind === 'working'
  const disabled = busy || unavailable
  const reason = unavailable ? (status?.reason ?? 'Try an Image is not available right now.') : null

  return (
    <div className="space-y-5">
      <div className="space-y-2 text-base text-ink">
        <p>
          Upload a photo of a finished plate. Gemini finds the food, SAM 2.1 outlines it, and the app counts the leftover pixels.
        </p>
        <p className="text-sm text-ink/80">
          Foods are matched against Halal Chicken and Halal Rice only. Results are temporary and are not added to the
          dashboard. One photo is checked at a time.
        </p>
      </div>

      {phase.kind === 'done' ? (
        <Results job={phase.job} onReset={reset} />
      ) : (
        <Card className="space-y-3">
          <div className="flex flex-wrap gap-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="sr-only"
              aria-label="Choose a photo"
              tabIndex={-1}
              data-testid="try-file"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void send(async () => file)
              }}
            />
            <PrimaryButton type="button" disabled={disabled} onClick={() => fileRef.current?.click()}>
              Upload a photo
            </PrimaryButton>
            <GhostButton type="button" disabled={disabled} onClick={() => void send(getTryImageSample)}>
              Use the sample photo
            </GhostButton>
          </div>

          {reason && <p role="status" className="text-base text-ink">{reason}</p>}
          {statusFailed && !status && (
            <p role="status" className="text-sm text-ink/80">Couldn't check whether Try an Image is free right now.</p>
          )}
          {status?.available && status.waiting > 0 && phase.kind === 'idle' && (
            <p className="text-sm text-ink/80">{status.waiting} photo{status.waiting === 1 ? '' : 's'} waiting in line.</p>
          )}

          {phase.kind === 'sending' && <p role="status">Sending your photo…</p>}
          {phase.kind === 'working' && (
            <p role="status" aria-live="polite">
              {phase.job.status === 'queued'
                ? `Waiting in line (position ${phase.job.position ?? '—'})`
                : 'Analyzing… about 20–40 s'}
            </p>
          )}
          {phase.kind === 'error' && (
            <div role="alert" className="space-y-2">
              <p className="text-base font-medium text-ink">{phase.message}</p>
              <GhostButton type="button" onClick={reset}>Try again</GhostButton>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
