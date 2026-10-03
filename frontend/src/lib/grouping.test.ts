import { describe, expect, it } from 'vitest'
import { groupPoints, niceCeil } from './grouping'
import type { DailyWastePoint } from '../data/types'

const points: DailyWastePoint[] = [
  { date: '2026-09-28', pixelsWasted: 100 }, // Monday
  { date: '2026-09-29', pixelsWasted: null },
  { date: '2026-09-30', pixelsWasted: 50 },
  { date: '2026-10-05', pixelsWasted: 70 }, // next Monday
]

describe('groupPoints', () => {
  it('daily keeps one bucket per point and preserves nulls', () => {
    const b = groupPoints(points, 'daily')
    expect(b).toHaveLength(4)
    expect(b[1].pixelsWasted).toBeNull()
  })

  it('weekly sums within Monday-start weeks and ignores null days', () => {
    const b = groupPoints(points, 'weekly')
    expect(b).toHaveLength(2)
    expect(b[0].pixelsWasted).toBe(150)
    expect(b[1].pixelsWasted).toBe(70)
  })

  it('monthly sums by calendar month', () => {
    const b = groupPoints(points, 'monthly')
    expect(b).toHaveLength(2)
    expect(b[0].pixelsWasted).toBe(150)
    expect(b[1].pixelsWasted).toBe(70)
  })

  it('an all-null bucket stays null (no data ≠ zero waste)', () => {
    const b = groupPoints([{ date: '2026-09-29', pixelsWasted: null }], 'weekly')
    expect(b[0].pixelsWasted).toBeNull()
  })
})

describe('niceCeil', () => {
  it('rounds up to clean axis maxima', () => {
    expect(niceCeil(7)).toBe(10)
    expect(niceCeil(130)).toBe(200)
    expect(niceCeil(2400)).toBe(2500)
    expect(niceCeil(0)).toBe(10)
  })
})
