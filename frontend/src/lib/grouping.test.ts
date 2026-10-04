import { describe, expect, it } from 'vitest'
import { dailyBuckets, niceCeil } from './grouping'
import type { DailyWastePoint } from '../data/types'

const points: DailyWastePoint[] = [
  { date: '2026-09-28', pixelsWasted: 100 }, // Monday
  { date: '2026-09-29', pixelsWasted: null },
  { date: '2026-09-30', pixelsWasted: 50 },
  { date: '2026-10-05', pixelsWasted: 70 }, // next Monday
]

describe('dailyBuckets', () => {
  it('keeps one bucket per day and preserves days without data as null', () => {
    const b = dailyBuckets(points)
    expect(b).toHaveLength(4)
    expect(b.map((x) => x.key)).toEqual(points.map((p) => p.date))
    expect(b[1].value).toBeNull()
    expect(b[0].value).toBe(100)
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
