import { useEffect, useState } from 'react'

export type AsyncState<T> =
  | { status: 'loading'; data?: T; error?: undefined }
  | { status: 'ready'; data: T; error?: undefined }
  | { status: 'error'; data?: T; error: string }

/**
 * Tiny async hook for the data-access layer. While refetching it keeps the
 * previous data (status 'loading' + stale data) so charts hold their frame.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' })
  useEffect(() => {
    let alive = true
    setState((prev) => (prev.data !== undefined ? { status: 'loading', data: prev.data } : { status: 'loading' }))
    fn().then(
      (data) => alive && setState({ status: 'ready', data }),
      (err: unknown) => alive && setState({ status: 'error', error: err instanceof Error ? err.message : 'Something went wrong.' }),
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}
