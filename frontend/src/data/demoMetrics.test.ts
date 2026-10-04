import { describe, expect, it } from 'vitest'
import { demoDay, getDailyWaste, getSummaryCards, PLATES_RANGE, WASTE_SCORE_RANGE } from './demoMetrics'
import { addDays, eachDay, startOfWeek, todayIso } from '../lib/dates'

const today = todayIso()

describe('demo metrics', () => {
  it('gives each of the last 30 days a waste score of 100-500 and 900-1400 plates, and nothing else', () => {
    const days = eachDay(addDays(today, -29), today).map((d) => demoDay('hall-main', d))
    for (const day of days) {
      expect(day).not.toBeNull()
      expect(day!.wasteScore).toBeGreaterThanOrEqual(WASTE_SCORE_RANGE[0])
      expect(day!.wasteScore).toBeLessThanOrEqual(WASTE_SCORE_RANGE[1])
      expect(day!.plates).toBeGreaterThanOrEqual(PLATES_RANGE[0])
      expect(day!.plates).toBeLessThanOrEqual(PLATES_RANGE[1])
      expect(Number.isInteger(day!.wasteScore) && Number.isInteger(day!.plates)).toBe(true)
    }
    expect(new Set(days.map((d) => d!.wasteScore)).size).toBeGreaterThan(10)
    expect(demoDay('hall-main', addDays(today, -30))).toBeNull()
    expect(demoDay('hall-main', addDays(today, 1))).toBeNull()
  })

  it('stays the same between calls and differs between halls', () => {
    expect(demoDay('hall-main', today)).toEqual(demoDay('hall-main', today))
    const a = eachDay(addDays(today, -29), today).map((d) => demoDay('hall-main', d)!.wasteScore)
    const b = eachDay(addDays(today, -29), today).map((d) => demoDay('hall-b', d)!.wasteScore)
    expect(a).not.toEqual(b)
  })

  it('adds halls together, and the cards match the chart', async () => {
    const both = await getDailyWaste(today, today, ['hall-main', 'hall-b'])
    expect(both[0].pixelsWasted).toBe(demoDay('hall-main', today)!.wasteScore + demoDay('hall-b', today)!.wasteScore)

    const cards = await getSummaryCards(['hall-main'])
    expect(cards.today.pixelsWasted).toBe(demoDay('hall-main', today)!.wasteScore)
    expect(cards.today.platesCounted).toBe(demoDay('hall-main', today)!.plates)
    const week = await getDailyWaste(startOfWeek(today), today, ['hall-main'])
    expect(cards.thisWeek.pixelsWasted).toBe(week.reduce((s, p) => s + (p.pixelsWasted ?? 0), 0))
    expect(cards.today.previousPixelsWasted).toBe(demoDay('hall-main', addDays(today, -1))!.wasteScore)
  })
})
