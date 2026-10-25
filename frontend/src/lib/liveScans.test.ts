import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeToScans, type ChannelLike, type RealtimeClientLike } from './liveScans'

function fakeClient() {
  const handlers: { filter: { event: string; schema: string; table: string }; cb: () => void }[] = []
  let subscribed = 0
  let removed = 0
  const channel: ChannelLike = {
    on(_type, filter, cb) {
      handlers.push({ filter, cb })
      return channel
    },
    subscribe() {
      subscribed += 1
      return channel
    },
  }
  const client: RealtimeClientLike = { channel: () => channel, removeChannel: () => (removed += 1) }
  return {
    client,
    handlers,
    emit: (table: string) => handlers.filter((h) => h.filter.table === table).forEach((h) => h.cb()),
    stats: () => ({ subscribed, removed }),
  }
}

describe('subscribeToScans', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('listens to scan and measurement changes in the public schema only', () => {
    const f = fakeClient()
    subscribeToScans(f.client, () => {})
    expect(f.handlers.map((h) => h.filter)).toEqual([
      { event: '*', schema: 'public', table: 'capture_event' },
      { event: 'INSERT', schema: 'public', table: 'food_measurement' },
    ])
    expect(f.stats().subscribed).toBe(1)
  })

  it('refreshes once per burst of changes (one analysis writes several rows)', () => {
    const f = fakeClient()
    const onChange = vi.fn()
    subscribeToScans(f.client, onChange, 1000)
    f.emit('capture_event')
    f.emit('food_measurement')
    f.emit('food_measurement')
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(onChange).toHaveBeenCalledTimes(1)
    f.emit('capture_event')
    vi.advanceTimersByTime(1000)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes and drops a pending refresh', () => {
    const f = fakeClient()
    const onChange = vi.fn()
    const stop = subscribeToScans(f.client, onChange, 1000)
    f.emit('capture_event')
    stop()
    vi.advanceTimersByTime(5000)
    expect(onChange).not.toHaveBeenCalled()
    expect(f.stats().removed).toBe(1)
  })
})
