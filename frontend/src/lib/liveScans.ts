/**
 * Live refresh: Supabase Realtime tells the dashboard when scans change, and
 * the pages refetch their numbers from the backend API (so every total, chart
 * and image is computed exactly as before). The browser only ever holds the
 * anon/publishable key; RLS limits it to reading dashboard tables.
 *
 * Off (a no-op) when the build has no VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.
 */
import { useEffect, useRef } from 'react'

/** The slice of a Supabase Realtime channel this module uses. */
export interface ChannelLike {
  on(type: 'postgres_changes', filter: { event: string; schema: string; table: string }, cb: () => void): ChannelLike
  subscribe(): unknown
}
export interface RealtimeClientLike {
  channel(name: string): ChannelLike
  removeChannel(channel: ChannelLike): unknown
}

/** Tables whose changes mean "a scan was added, finished, or failed". */
export const LIVE_TABLES = [
  { event: '*', table: 'capture_event' },
  { event: 'INSERT', table: 'food_measurement' },
] as const

/**
 * Subscribe and call `onChange` at most once per `debounceMs` burst (one analysis
 * writes several rows). Returns an unsubscribe function.
 */
export function subscribeToScans(client: RealtimeClientLike, onChange: () => void, debounceMs = 1500): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      onChange()
    }, debounceMs)
  }
  let channel = client.channel('scrap-live-scans')
  for (const t of LIVE_TABLES) channel = channel.on('postgres_changes', { event: t.event, schema: 'public', table: t.table }, fire)
  channel.subscribe()
  return () => {
    if (timer !== undefined) clearTimeout(timer)
    void client.removeChannel(channel)
  }
}

/** Calls `onChange` whenever new scans (or scan results) arrive. */
export function useLiveScans(onChange: () => void): void {
  const latest = useRef(onChange)
  latest.current = onChange
  useEffect(() => {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
    if (!url || !anonKey) return
    let stop: (() => void) | undefined
    let cancelled = false
    // Loaded on demand so the client library stays out of the first paint.
    import('@supabase/supabase-js')
      .then(({ createClient }) => {
        if (cancelled) return
        const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
        stop = subscribeToScans(client as unknown as RealtimeClientLike, () => latest.current())
      })
      .catch(() => {
        /* Live refresh is optional: the dashboard still works with manual reloads. */
      })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [])
}
