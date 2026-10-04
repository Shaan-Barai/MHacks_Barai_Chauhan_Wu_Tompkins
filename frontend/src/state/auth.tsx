/**
 * Owner access (2026-10-04). There is no staff sign-in in the UI: every
 * editing control is shown. A backend run without SCRAP_ADMIN_PASSCODE is
 * open, so saves just work. When the backend does require the passcode, a
 * save that comes back 401 opens a small passcode prompt, and the unlisted
 * /admin page unlocks with it. The session lives in an httpOnly cookie.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { getSession, login, logout } from '../data/api'
import { AUTH_REQUIRED_EVENT } from '../data/authEvents'

export type AuthStatus = 'checking' | 'signedIn' | 'signedOut'

export interface AuthValue {
  status: AuthStatus
  /** Editing controls are always shown; the backend decides whether a save needs the passcode. */
  canEdit: true
  /** False when the backend has no sign-in at all (older local backends). */
  authAvailable: boolean
  signIn: (passcode: string) => Promise<void>
  signOut: () => Promise<void>
  /** Open the sign-in dialog, optionally explaining why. */
  openSignIn: (reason?: string) => void
}

const SIGNED_OUT: AuthValue = {
  status: 'signedOut',
  canEdit: true,
  authAvailable: true,
  signIn: async () => {},
  signOut: async () => {},
  openSignIn: () => {},
}

const AuthContext = createContext<AuthValue>(SIGNED_OUT)

export function useAuth(): AuthValue {
  return useContext(AuthContext)
}

export function AuthProvider({
  children,
  initialStatus,
}: {
  children: ReactNode
  /** Tests: skip the session check and start in this state. */
  initialStatus?: Exclude<AuthStatus, 'checking'>
}) {
  const [status, setStatus] = useState<AuthStatus>(initialStatus ?? 'checking')
  const [authAvailable, setAuthAvailable] = useState(true)
  const [dialog, setDialog] = useState<{ open: boolean; reason?: string }>({ open: false })
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (initialStatus) return
    let alive = true
    getSession().then(
      (s) => {
        if (!alive) return
        setAuthAvailable(s.authAvailable)
        setStatus(s.signedIn ? 'signedIn' : 'signedOut')
      },
      () => alive && setStatus('signedOut'),
    )
    return () => {
      alive = false
    }
  }, [initialStatus])

  const openSignIn = useCallback((reason?: string) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDialog({ open: true, reason })
  }, [])

  // A change came back 401: the session is gone (or never existed).
  useEffect(() => {
    const onRequired = () => {
      setStatus('signedOut')
      openSignIn()
    }
    window.addEventListener(AUTH_REQUIRED_EVENT, onRequired)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onRequired)
  }, [openSignIn])

  const closeDialog = useCallback(() => {
    setDialog({ open: false })
    returnFocus.current?.focus?.()
  }, [])

  const signIn = useCallback(
    async (passcode: string) => {
      await login(passcode)
      setStatus('signedIn')
      closeDialog()
    },
    [closeDialog],
  )

  const signOut = useCallback(async () => {
    try {
      await logout()
    } finally {
      setStatus('signedOut')
    }
  }, [])

  const value = useMemo<AuthValue>(
    () => ({ status, canEdit: true as const, authAvailable, signIn, signOut, openSignIn }),
    [status, authAvailable, signIn, signOut, openSignIn],
  )

  return (
    <AuthContext.Provider value={value}>
      {children}
      {dialog.open && <SignInDialog reason={dialog.reason} onSignIn={signIn} onClose={closeDialog} />}
    </AuthContext.Provider>
  )
}

function SignInDialog({
  reason,
  onSignIn,
  onClose,
}: {
  reason?: string
  onSignIn: (passcode: string) => Promise<void>
  onClose: () => void
}) {
  const titleId = useId()
  const inputId = useId()
  const [passcode, setPasscode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async () => {
    if (!passcode) {
      setError('Enter the passcode.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSignIn(passcode)
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Try again.")
      setBusy(false)
    }
  }

  // Keep keyboard focus inside the dialog; Escape closes it.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab' || !boxRef.current) return
    const items = boxRef.current.querySelectorAll<HTMLElement>('input, button')
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="w-full max-w-sm rounded-card border-2 border-ink bg-cream p-5 text-ink"
      >
        <h2 id={titleId} className="text-xl font-semibold">
          Passcode
        </h2>
        {reason && <p className="mt-1 text-base">{reason}</p>}
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            Passcode
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="password"
            autoComplete="current-password"
            value={passcode}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setPasscode(e.target.value)}
            className="w-full rounded-btn border border-ink bg-cream px-3 py-2 text-base text-ink"
          />
          {error && (
            <p role="alert" className="mt-2 font-semibold">
              {error}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-btn bg-ink px-5 py-2.5 text-base font-semibold text-cream hover:underline disabled:cursor-not-allowed"
            >
              Unlock
            </button>
            <button type="button" onClick={onClose} className="rounded-btn border border-ink px-5 py-2.5 text-base hover:underline">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
