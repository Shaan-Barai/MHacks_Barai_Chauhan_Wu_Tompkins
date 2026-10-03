import { describe, expect, it } from 'vitest'
import { severityFor } from './severity'

describe('severityFor (UI.md bands: <10% Sage, 10–25% Squash, >25% Tomato)', () => {
  it('buckets low shares as low', () => {
    expect(severityFor(0)).toBe('low')
    expect(severityFor(9.99)).toBe('low')
  })
  it('buckets 10–25% as medium, inclusive of both bounds', () => {
    expect(severityFor(10)).toBe('medium')
    expect(severityFor(17)).toBe('medium')
    expect(severityFor(25)).toBe('medium')
  })
  it('buckets >25% as high', () => {
    expect(severityFor(25.01)).toBe('high')
    expect(severityFor(100)).toBe('high')
  })
})
