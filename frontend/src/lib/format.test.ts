import { describe, expect, it } from 'vitest'
import { formatCompact, formatNumber, formatPoints } from './format'

describe('number formatting', () => {
  it('formats counts and compact counts', () => {
    expect(formatNumber(1_450_000)).toBe('1,450,000')
    expect(formatCompact(12_900)).toBe('12.9k')
    expect(formatCompact(1_200_000)).toBe('1.2M')
  })

  it('formats relative points: whole from 100, one decimal from 1, two significant digits below 1', () => {
    expect(formatPoints(23_411.6)).toBe('23,412')
    expect(formatPoints(100)).toBe('100')
    expect(formatPoints(95.74)).toBe('95.7')
    expect(formatPoints(4)).toBe('4')
    expect(formatPoints(0.0523)).toBe('0.052')
    expect(formatPoints(0.0004)).toBe('0.0004')
    expect(formatPoints(0)).toBe('0')
  })
})
