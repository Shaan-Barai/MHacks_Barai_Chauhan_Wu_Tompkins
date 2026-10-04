/**
 * Staff sign-in (IT_4 I11). Everyone can read the dashboard; changes (menus,
 * portions served, settings, camera calibration) need a staff session. The
 * backend keeps the session in an httpOnly cookie, so this only tracks
 * whether one is active. A 401 from any change opens the sign-in dialog.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { getSession, login, logout, MOCK_PASSCODE, USE_MOCK } from '../data/api'
import { AUTH_REQUIRED_EVENT } from '../data/authEvents'

export type AuthStatus = 'checking' | 'signedIn' | 'signedOut'

export interface AuthValue {
  status: AuthStatus
  /** True when changes are allowed (signed in, or the backend has no sign-in). */
  canEdit: boolean
  /** False when the backend has no sign-in at all (older local backends). */
  authAvailable: boolean
  signIn: (passcode: string) => Promise<void>
  signOut: () => Promise<void>
  /** Open the sign-in dialog, optionally explaining why. */
  openSignIn: (reason?: string) => void
}

const SIGNED_OUT: AuthValue = {
  status: 'signedOut',
  canEdit: false,
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
      openSignIn('Sign in to save this change.')
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
    () => ({ status, canEdit: status === 'signedIn', authAvailable, signIn, signOut, openSignIn }),
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
      setError('Enter the staff passcode.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSignIn(passcode)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't sign in. Try again.")
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
          Staff sign-in
        </h2>
        <p className="mt-1 text-base">{reason ?? 'Sign in to change menus, portions, settings and the camera calibration.'}</p>
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <label htmlFor={inputId} className="mb-1 block text-base font-medium">
            Staff passcode
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
          {USE_MOCK && <p className="mt-1 text-sm">Demo mode: the passcode is {MOCK_PASSCODE}.</p>}
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
              {busy ? 'Signing in' : 'Sign in'}
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

/** Nav control: "Staff sign-in", or "Signed in as staff" with "Sign out". */
export function StaffSignIn() {
  const { status, authAvailable, signOut, openSignIn } = useAuth()
  if (!authAvailable) return null
  if (status === 'checking') return <p className="text-sm">Checking sign-in</p>
  if (status === 'signedIn') {
    return (
      <div className="text-sm">
        <p>Signed in as staff</p>
        <button type="button" onClick={() => void signOut()} className="mt-1 rounded-btn border border-cream px-3 py-1.5 text-base hover:underline">
          Sign out
        </button>
      </div>
    )
  }
  return (
    <button type="button" onClick={() => openSignIn()} className="rounded-btn border border-cream px-3 py-1.5 text-base hover:underline">
      Staff sign-in
    </button>
  )
}

/** Shown in place of a write control when signed out. */
export function SignInHint({ children }: { children?: ReactNode }) {
  const { openSignIn } = useAuth()
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-card border border-dashed border-ink p-4">
      <p className="text-base">
        <span className="font-semibold">Sign in to change this.</span> {children}
      </p>
      <button type="button" onClick={() => openSignIn()} className="rounded-btn border border-ink px-3 py-1.5 text-base hover:underline">
        Staff sign-in
      </button>
    </div>
  )
}
