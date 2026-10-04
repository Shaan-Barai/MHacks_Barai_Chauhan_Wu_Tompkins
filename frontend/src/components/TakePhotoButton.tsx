/**
 * "Take photo": triggers the Uno Q camera through the backend (the same path
 * as `npm run take-photo`). The plate then appears in the gallery once the
 * AI has checked it. Disabled with a hint when no camera is set up.
 */
import { useEffect, useState } from 'react'
import { getCameraStatus, takePhoto } from '../data/api'
import type { CameraStatus } from '../data/types'
import { PrimaryButton } from './ui'

type State = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; text: string } | { kind: 'error'; text: string }

export function TakePhotoButton({ onTaken }: { onTaken: () => void }) {
  const [status, setStatus] = useState<CameraStatus | null>(null)
  const [state, setState] = useState<State>({ kind: 'idle' })

  useEffect(() => {
    let live = true
    getCameraStatus().then(
      (s) => live && setStatus(s),
      () => live && setStatus({ configured: false, busy: false }),
    )
    return () => {
      live = false
    }
  }, [])

  const configured = status?.configured === true
  async function onClick() {
    setState({ kind: 'busy' })
    try {
      const r = await takePhoto()
      setState({
        kind: 'done',
        text: r.state === 'succeeded' ? 'Photo taken and checked.' : r.state === 'failed' ? 'Photo taken, but the check failed.' : 'Photo taken.',
      })
      onTaken()
    } catch (err) {
      setState({ kind: 'error', text: err instanceof Error ? err.message : 'The photo could not be taken.' })
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <PrimaryButton type="button" onClick={onClick} disabled={!configured || state.kind === 'busy'} aria-describedby="take-photo-status">
        {state.kind === 'busy' ? 'Taking photo…' : 'Take photo'}
      </PrimaryButton>
      <p id="take-photo-status" className="max-w-xs text-right text-sm" role="status" aria-live="polite">
        {status && !configured && 'No camera set up (CAMERA_HOST in .env).'}
        {state.kind === 'busy' && 'Taking the photo and checking it. This takes up to a minute.'}
        {state.kind === 'done' && state.text}
        {state.kind === 'error' && state.text}
      </p>
    </div>
  )
}
