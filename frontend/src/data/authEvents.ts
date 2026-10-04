/**
 * "Sign-in needed" signal from the data layer to the UI (IT_4 I11). Any
 * mutation that comes back 401 fires this event; the AuthProvider listens
 * and opens the staff sign-in dialog.
 */
export const AUTH_REQUIRED_EVENT = 'scrap:auth-required'

export const SIGN_IN_TO_CHANGE = 'Sign in to change this.'

export class AuthRequiredError extends Error {
  readonly status = 401
  constructor(message = SIGN_IN_TO_CHANGE) {
    super(message)
    this.name = 'AuthRequiredError'
  }
}

export function notifyAuthRequired(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
}
