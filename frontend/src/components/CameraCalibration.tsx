/**
 * Settings -> Camera calibration (IT_4 I2, I3, I9). Staff lay a flat object
 * of known area (a credit card by default) where plates go, upload a photo
 * from the locked camera, and get cm² per pixel plus the camera height (from
 * the photo geometry). The active calibration is the only source of food
 * area (pixels × cm² per pixel); with each food's typical weight per cm² it
 * turns Pixels wasted into ESTIMATED grams, CO2e and water.
 * Reads are public; every change needs a staff session.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  createCalibration,
  getCalibration,
  getCalibrationImages,
  getCalibrations,
  getMeasurementSettings,
  saveMeasurementSettings,
} from '../data/api'
import type { CameraCalibration, CameraCalibrationFlag, MeasurementSettings } from '../data/types'
import { formatNumber } from '../lib/format'
import { useAsync } from '../lib/useAsync'
import { SignInHint, useAuth } from '../state/auth'
import { Badge, Card, EmptyState, FieldLabel, GhostButton, InfoTip, LoadingBlock, PrimaryButton, inputClass } from './ui'

export const CREDIT_CARD_CM2 = 46.21
export const DEFAULT_CAMERA_ID = 'uno-q-c920s-1'
const MAX_PHOTO_BYTES = 15 * 1024 * 1024
const POLL_MS = 2000
const POLL_TRIES = 45

const cm = (n: number) => `${n.toFixed(1)} cm`

/** Each calibration flag in plain words; null for a flag this dashboard doesn't know (e.g. from an older backend). */
export function flagText(flag: CameraCalibrationFlag, cal: CameraCalibration): string | null {
  const thing = cal.referenceLabel.trim() || 'reference object'
  switch (flag) {
    case 'reference_not_found':
      return `The ${thing} was not found in the photo. Check that it lies flat, fully in view, and nothing covers it.`
    case 'reference_low_confidence':
      return `The AI was unsure of the ${thing}'s outline. Check the outline picture before using this calibration.`
    case 'reference_touches_edge':
      return `The ${thing} touches the edge of the photo, so part of it may be cut off. Move it toward the middle and calibrate again.`
    default:
      return null
  }
}

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'an unknown time'
  return d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const STATUS_TEXT: Record<CameraCalibration['status'], string> = {
  processing: 'Still measuring',
  succeeded: 'Ready',
  failed: "Didn't work",
}

export function CameraCalibrationPanel() {
  const { canEdit } = useAuth()
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((r) => r + 1), [])
  const settings = useAsync(getMeasurementSettings, [revision])
  const list = useAsync(getCalibrations, [revision])
  const [picked, setPicked] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const current = settings.data
  const calibrations = list.data ?? []
  const activeId = current?.activeCalibrationId ?? null
  const shownId = picked ?? activeId ?? calibrations[0]?.calibrationId ?? null
  const shown = calibrations.find((c) => c.calibrationId === shownId) ?? null

  const save = async (patch: Partial<Pick<MeasurementSettings, 'activeCalibrationId'>>, done: string) => {
    if (!current) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await saveMeasurementSettings({ activeCalibrationId: current.activeCalibrationId, ...patch })
      setNote(done)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The change was not saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Camera calibration</h2>
        <p className="mt-1">
          Calibration lets ScrapSaver estimate grams, CO2e and water from the pixels it counts. The reference object of known area gives
          the area of each pixel, and each food's typical weight per cm² turns that area into grams. Pixels wasted stay the measurement;
          the rest are estimates.
        </p>
      </div>

      <HowTo />

      {!canEdit && <SignInHint>Staff can calibrate the camera and change these settings.</SignInHint>}

      {settings.status === 'error' && <EmptyState title="Couldn't load the measurement settings.">{settings.error}</EmptyState>}

      {note && (
        <p role="status" className="font-semibold">
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="font-semibold">
          {error}
        </p>
      )}

      {canEdit && (
        <NewCalibrationForm
          cameraId={calibrations[0]?.cameraId ?? DEFAULT_CAMERA_ID}
          onCreated={(cal) => {
            setPicked(cal.calibrationId)
            setNote(null)
            refresh()
          }}
        />
      )}

      {list.status === 'loading' && !list.data && <LoadingBlock label="Loading calibrations" />}
      {list.status === 'error' && <EmptyState title="Couldn't load the calibrations.">{list.error}</EmptyState>}
      {list.data && calibrations.length === 0 && (
        <EmptyState title="The camera hasn't been calibrated yet.">
          Until it is, the dashboard shows pixels and relative points only.
        </EmptyState>
      )}

      {shown && (
        <CalibrationResult
          key={shown.calibrationId}
          calibration={shown}
          active={shown.calibrationId === activeId}
          canEdit={canEdit}
          busy={busy}
          onActivate={() => void save({ activeCalibrationId: shown.calibrationId }, 'This calibration is now active for new plates.')}
          onSettled={refresh}
        />
      )}

      {calibrations.length > 0 && (
        <CalibrationHistory calibrations={calibrations} activeId={activeId} shownId={shownId} onPick={setPicked} />
      )}
    </Card>
  )
}

function HowTo() {
  return (
    <div>
      <h3 className="text-base font-semibold">How to calibrate</h3>
      <ol className="mt-1 list-decimal space-y-1 pl-6">
        <li>Lock the camera in place and keep its focus fixed.</li>
        <li>Lay a credit card (or another flat object you have measured) flat where the plates go.</li>
        <li>Take the photo with the mounted camera at its usual position, then upload it below.</li>
        <li>Don't move the camera afterwards. If it moves, or its picture size changes, calibrate again.</li>
      </ol>
    </div>
  )
}

function NewCalibrationForm({ cameraId, onCreated }: { cameraId: string; onCreated: (cal: CameraCalibration) => void }) {
  const areaId = useId()
  const labelId = useId()
  const photoId = useId()
  const [area, setArea] = useState(String(CREDIT_CARD_CM2))
  const [label, setLabel] = useState('credit card')
  const [photo, setPhoto] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const isCard = Number(area) === CREDIT_CARD_CM2 && label.trim().toLowerCase() === 'credit card'

  const submit = async () => {
    const knownAreaCm2 = Number(area)
    if (!(area.trim() !== '' && Number.isFinite(knownAreaCm2) && knownAreaCm2 > 0 && knownAreaCm2 <= 5000)) {
      setError('Enter the reference object’s area in cm², more than 0.')
      return
    }
    if (!label.trim()) {
      setError('Say what the reference object is, for example "credit card".')
      return
    }
    if (!photo) {
      setError('Choose the calibration photo.')
      return
    }
    if (!/^image\/(jpeg|png|webp)$/.test(photo.type)) {
      setError('Use a JPEG, PNG or WebP photo.')
      return
    }
    if (photo.size > MAX_PHOTO_BYTES) {
      setError('That photo is too big. Use one under 15 MB.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const cal = await createCalibration({ cameraId, knownAreaCm2, referenceLabel: label.trim(), photo })
      setPhoto(null)
      if (fileRef.current) fileRef.current.value = ''
      onCreated(cal)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The calibration did not run. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="space-y-3 border border-ink p-4"
      aria-label="New calibration"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <h3 className="text-base font-semibold">New calibration</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <FieldLabel htmlFor={areaId}>Known area (cm²)</FieldLabel>
          <input
            id={areaId}
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            className={inputClass}
            value={area}
            disabled={busy}
            onChange={(e) => setArea(e.target.value)}
          />
        </div>
        <GhostButton
          type="button"
          aria-pressed={isCard}
          disabled={busy}
          onClick={() => {
            setArea(String(CREDIT_CARD_CM2))
            setLabel('credit card')
          }}
        >
          Credit card (46.21 cm²)
        </GhostButton>
      </div>
      <p className="text-sm">A bank or ID card is 8.56 × 5.398 cm = 46.21 cm². For anything else, measure it and type its area.</p>
      <div className="max-w-xs">
        <FieldLabel htmlFor={labelId}>What is it?</FieldLabel>
        <input id={labelId} className={inputClass} value={label} placeholder="e.g. credit card" disabled={busy} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div>
        <FieldLabel htmlFor={photoId}>Calibration photo</FieldLabel>
        <input
          ref={fileRef}
          id={photoId}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
          className="block max-w-full text-base file:mr-3 file:rounded-btn file:border file:border-solid file:border-ink file:bg-cream file:px-3 file:py-1 file:font-sans file:text-ink"
        />
        <p className="mt-1 text-sm">
          It must come from the mounted camera that scans the plates, at its usual position. The photo is cropped to the same 1024 × 1024
          centre square as plate photos.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? 'Measuring' : 'Calibrate'}
        </PrimaryButton>
        {busy && (
          <p role="status" className="text-base">
            Uploading the photo and measuring the {label.trim() || 'reference'}. This can take up to a minute.
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="font-semibold">
          {error}
        </p>
      )}
    </form>
  )
}

/** The reference outline picture, renewed once if its link fails. */
function CalibrationPicture({ calibration }: { calibration: CameraCalibration }) {
  const [attempt, setAttempt] = useState(0)
  const images = useAsync(() => getCalibrationImages(calibration.calibrationId), [calibration.calibrationId, attempt])
  const [broken, setBroken] = useState(false)
  const box = 'flex aspect-video w-full items-center justify-center border border-dashed border-ink p-3 text-center text-sm'
  if (images.status === 'loading' && !images.data) return <div className={box} role="status">Loading picture</div>
  if (images.status === 'error' || broken) return <div className={box}>Picture unavailable</div>
  const img = images.data?.outline ?? images.data?.photo ?? null
  if (!img) return <div className={box}>No picture for this calibration</div>
  const isOutline = Boolean(images.data?.outline)
  const thing = calibration.referenceLabel || 'reference object'
  return (
    <figure>
      <img
        src={img.url}
        alt={isOutline ? `Calibration photo with the ${thing} outlined by the AI` : 'Calibration photo'}
        className="aspect-video w-full border border-ink bg-ink object-contain"
        onError={() => (attempt === 0 ? setAttempt(1) : setBroken(true))}
      />
      <figcaption className="mt-1 text-sm">{isOutline ? `The ${thing} as the AI outlined it` : 'Calibration photo'}</figcaption>
    </figure>
  )
}

function CalibrationResult({
  calibration,
  active,
  canEdit,
  busy,
  onActivate,
  onSettled,
}: {
  calibration: CameraCalibration
  active: boolean
  canEdit: boolean
  busy: boolean
  onActivate: () => void
  onSettled: () => void
}) {
  const scaleTip = useId()
  const heightTip = useId()
  const [latest, setLatest] = useState(calibration)
  useEffect(() => setLatest(calibration), [calibration])

  // A calibration still being measured: check again every few seconds.
  useEffect(() => {
    if (latest.status !== 'processing') return
    let tries = 0
    let alive = true
    const timer = setInterval(() => {
      tries++
      getCalibration(latest.calibrationId).then(
        (next) => {
          if (!alive) return
          setLatest(next)
          if (next.status !== 'processing') onSettled()
        },
        () => {},
      )
      if (tries >= POLL_TRIES) clearInterval(timer)
    }, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [latest.status, latest.calibrationId, onSettled])

  const cal = latest
  const thing = cal.referenceLabel || 'reference object'
  const flagTexts = cal.flags.flatMap((f) => {
    const text = flagText(f, cal)
    return text === null ? [] : [[f, text] as const]
  })

  return (
    <section aria-labelledby={`cal-${cal.calibrationId}`} className="border border-ink p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`cal-${cal.calibrationId}`} className="text-base font-semibold">
          Calibration from {when(cal.createdAt)}
        </h3>
        <span className="flex gap-2">
          {active && <Badge>Active</Badge>}
          <Badge>{STATUS_TEXT[cal.status]}</Badge>
        </span>
      </div>

      {cal.status === 'processing' && (
        <p role="status" className="mt-2">
          Still measuring the {thing}. This page checks again every few seconds.
        </p>
      )}
      {cal.status === 'failed' && (
        <p className="mt-2">
          This calibration didn't work{cal.error?.message ? `: ${cal.error.message}` : '.'} Take a new photo and try again.
        </p>
      )}

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <CalibrationPicture calibration={cal} />
        {cal.status === 'succeeded' && (
          <dl className="grid grid-cols-[auto_1fr] content-start gap-x-4 gap-y-1 text-base">
            <dt>Reference</dt>
            <dd className="font-semibold">
              {thing}, {cal.knownAreaCm2} cm²
            </dd>
            <dt>In the photo</dt>
            <dd className="font-semibold">{formatNumber(cal.referencePixels)} pixels</dd>
            <dt>
              Scale
              <InfoTip id={scaleTip} text="The area one pixel covers on the tray: the reference area divided by its pixels. Food area = its pixels × this." />
            </dt>
            <dd className="font-semibold">{Number(cal.cm2PerPx.toPrecision(3))} cm² per pixel</dd>
            <dt>
              Camera height, from the photo
              <InfoTip id={heightTip} text="From the camera's lens (a Logitech C920s) and how big the reference looks in the photo. A check on the setup; it does not change the estimates." />
            </dt>
            <dd className="font-semibold">{cm(cal.cameraHeightCmGeometric)}</dd>
            <dt>Picture size</dt>
            <dd className="font-semibold">
              {cal.widthPx} × {cal.heightPx} pixels
            </dd>
          </dl>
        )}
      </div>

      {flagTexts.length > 0 && (
        <div className="mt-3">
          <h4 className="text-base font-semibold">Check this</h4>
          <ul className="mt-1 list-disc space-y-1 pl-6">
            {flagTexts.map(([f, text]) => (
              <li key={f}>{text}</li>
            ))}
          </ul>
        </div>
      )}

      {cal.status === 'succeeded' && !active && canEdit && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <PrimaryButton type="button" onClick={onActivate} disabled={busy}>
            Activate
          </PrimaryButton>
          <p className="text-sm">New plates use the active calibration. Plates already scanned keep the one they were measured with.</p>
        </div>
      )}
      {active && <p className="mt-3 text-sm">New plates are measured with this calibration.</p>}
    </section>
  )
}

function CalibrationHistory({
  calibrations,
  activeId,
  shownId,
  onPick,
}: {
  calibrations: CameraCalibration[]
  activeId: string | null
  shownId: string | null
  onPick: (id: string) => void
}) {
  return (
    <div>
      <h3 className="text-base font-semibold">Past calibrations</h3>
      <ul className="mt-1 divide-y divide-ink border-y border-ink">
        {calibrations.map((c) => (
          <li key={c.calibrationId} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <span className="font-semibold">{when(c.createdAt)}</span>, {c.referenceLabel || 'reference object'}
              {c.status === 'succeeded' ? `, ${Number(c.cm2PerPx.toPrecision(3))} cm² per pixel` : ''}
              {' · '}
              {STATUS_TEXT[c.status]}
              {c.calibrationId === activeId && (
                <span className="ml-2">
                  <Badge>Active</Badge>
                </span>
              )}
            </span>
            <GhostButton
              type="button"
              className="px-3 py-1.5"
              aria-pressed={c.calibrationId === shownId}
              aria-label={`Show the calibration from ${when(c.createdAt)}`}
              onClick={() => onPick(c.calibrationId)}
            >
              {c.calibrationId === shownId ? 'Showing' : 'Show'}
            </GhostButton>
          </li>
        ))}
      </ul>
    </div>
  )
}
