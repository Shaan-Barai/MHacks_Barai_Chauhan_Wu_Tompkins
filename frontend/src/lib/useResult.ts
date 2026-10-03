import { useCallback, useEffect, useState } from 'react'
import type { ApiError, Result } from '../data/types'

export type Loadable<T> =
  | { state: 'loading' }
  | { state: 'error'; error: ApiError }
  | { state: 'ready'; data: T }

/** Runs an API call whenever deps change; exposes loading/error/ready + retry. */
export function useResult<T>(load: () => Promise<Result<T>>, deps: unknown[]): [Loadable<T>, () => void] {
  const [value, setValue] = useState<Loadable<T>>({ state: 'loading' })
  const [nonce, setNonce] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps)

  useEffect(() => {
    let live = true
    setValue({ state: 'loading' })
    run().then((res) => {
      if (!live) return
      setValue(res.ok ? { state: 'ready', data: res.data } : { state: 'error', error: res.error })
    })
    return () => {
      live = false
    }
  }, [run, nonce])

  return [value, () => setNonce((n) => n + 1)]
}
