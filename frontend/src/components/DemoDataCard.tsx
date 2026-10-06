/**
 * Settings card: load labeled sample scans, hide older scans, or restore the default view. Real scans are never deleted.
 * The read-only site shows the current mode only.
 */
import { useCallback, useEffect, useState } from 'react'
import { clearDemoData, getDemoStatus, loadDemoData, restoreDemoData } from '../data/api'
import { AuthRequiredError } from '../data/authEvents'
import type { DemoStatus } from '../data/types'
import { useAuth } from '../state/auth'
import { Card, GhostButton, PrimaryButton } from './ui'

const SIGN_IN_PROMPT = 'Sign in as staff to change demo data'

export function demoStatusText(s: DemoStatus): string {
  if (s.mode === 'sample') return `Sample data is loaded: ${s.sampleCaptures} labeled sample scans over the last 14 days. They are not real.`
  if (s.mode === 'cleared') {
    const when = s.clearedAt ? new Date(s.clearedAt).toLocaleString() : 'an earlier time'
    return `Cleared at ${when}: the dashboard only shows scans taken after that. Nothing was deleted.`
  }
  return 'Showing the real scans.'
}

export function DemoDataCard({ onDataChanged }: { onDataChanged?: () => void }) {
  const { openSignIn, readOnly } = useAuth()
  const [status, setStatus] = useState<DemoStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getDemoStatus().then(
      (s) => alive && setStatus(s),
      (err: Error) => alive && setError(err.message),
    )
    return () => {
      alive = false
    }
  }, [])

  const run = useCallback(
    async (action: () => Promise<DemoStatus>) => {
      setBusy(true)
      setError(null)
      setNeedsSignIn(false)
      setConfirming(false)
      try {
        setStatus(await action())
        onDataChanged?.()
      } catch (err) {
        if (err instanceof AuthRequiredError) setNeedsSignIn(true)
        else setError((err as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [onDataChanged],
  )

  const statusLine = (
    <p role="status" className="mt-2">
      {status ? demoStatusText(status) : error ? 'Could not check the demo data mode.' : 'Checking demo data…'}
    </p>
  )

  // Read-only site: say which data is shown; nothing can be changed.
  if (readOnly) {
    return (
      <Card>
        <h2 className="text-lg font-semibold">Demo data</h2>
        {statusLine}
      </Card>
    )
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">Demo data</h2>
      {statusLine}
      <p className="mt-1 text-sm">Real scans are never deleted. Restore default returns the dashboard to how it looked before.</p>

      <div className="mt-3 flex flex-wrap gap-3">
        <PrimaryButton type="button" disabled={busy} onClick={() => run(loadDemoData)}>
          Load dummy data
        </PrimaryButton>
        <GhostButton type="button" disabled={busy} onClick={() => setConfirming(true)}>
          Clear data
        </GhostButton>
        {status && status.mode !== 'default' && (
          <GhostButton type="button" disabled={busy} onClick={() => run(restoreDemoData)}>
            Restore default
          </GhostButton>
        )}
      </div>

      {confirming && (
        <div role="alertdialog" aria-labelledby="clear-demo-title" className="mt-3 space-y-3 border border-ink p-4">
          <p id="clear-demo-title" className="font-semibold">
            Clear the dashboard? It will only show scans taken from now on. Nothing is deleted, and you can restore the default view.
          </p>
          <div className="flex gap-3">
            <PrimaryButton type="button" disabled={busy} onClick={() => run(clearDemoData)}>
              Yes, clear data
            </PrimaryButton>
            <GhostButton type="button" onClick={() => setConfirming(false)}>
              Cancel
            </GhostButton>
          </div>
        </div>
      )}

      {busy && <p className="mt-3 font-semibold">Working…</p>}
      {needsSignIn && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-3">
          <p className="font-semibold">{SIGN_IN_PROMPT}</p>
          <GhostButton type="button" onClick={() => openSignIn(SIGN_IN_PROMPT)}>
            Sign in
          </GhostButton>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 font-semibold">
          {error}
        </p>
      )}
    </Card>
  )
}

/** Subtle dashboard line when the view is cleared. */
export function ClearedNotice({ status }: { status: DemoStatus | null }) {
  const { readOnly } = useAuth()
  if (status?.mode !== 'cleared') return null
  const when = status.clearedAt ? new Date(status.clearedAt).toLocaleString() : 'the clear time'
  return (
    <p role="note" className="text-sm text-ink">
      Showing scans since {when}.{readOnly ? '' : ' Restore the default view in Settings.'}
    </p>
  )
}
