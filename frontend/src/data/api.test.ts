import { beforeEach, describe, expect, it } from 'vitest'
import {
  getDailyWaste,
  getMealDetail,
  getMenu,
  getMenuDays,
  getSummaryCards,
  saveUserMenu,
  setApiLatency,
} from './api'
import { addDays, eachDay, todayIso } from '../lib/dates'

beforeEach(() => {
  localStorage.clear()
  setApiLatency(0)
})

const today = todayIso()
const yesterday = addDays(today, -1)

describe('getDailyWaste', () => {
  it('returns one point per day of the range, in order', async () => {
    const start = addDays(today, -13)
    const points = await getDailyWaste(start, today)
    expect(points.map((p) => p.date)).toEqual(eachDay(start, today))
  })

  it('is deterministic (same mock values on every call)', async () => {
    const a = await getDailyWaste(addDays(today, -6), today)
    const b = await getDailyWaste(addDays(today, -6), today)
    expect(a).toEqual(b)
  })

  it('has no data for future days', async () => {
    const points = await getDailyWaste(addDays(today, 1), addDays(today, 3))
    expect(points.every((p) => p.wasteUnits === null)).toBe(true)
  })
})

describe('getMealDetail', () => {
  async function someDayWithData() {
    for (let i = 1; i <= 20; i++) {
      const date = addDays(today, -i)
      const d = await getMealDetail(date, 'lunch')
      if (d) return d
    }
    throw new Error('mock data should have at least one lunch in 20 days')
  }

  it('items are sorted by waste, shares sum to ~100%, swipes labeled simulated', async () => {
    const d = await someDayWithData()
    const shares = d.items.map((i) => i.shareOfMealWastePercent)
    expect([...d.items].sort((a, b) => b.wasteUnits - a.wasteUnits)).toEqual(d.items)
    expect(shares.reduce((s, v) => s + v, 0)).toBeCloseTo(100, 5)
    expect(d.mealSwipes.source).toBe('simulated')
    expect(d.totalWasteUnits).toBe(d.items.reduce((s, i) => s + i.wasteUnits, 0))
    expect(d.tip?.recommendation.length).toBeGreaterThan(0)
  })

  it('returns null when the day has no menu', async () => {
    // find a mock missing-menu day in the past year
    const days = await getMenuDays(addDays(today, -200), yesterday)
    const missing = Object.entries(days).find(([, has]) => !has)?.[0]
    expect(missing).toBeDefined()
    expect(await getMealDetail(missing!, 'dinner')).toBeNull()
  })
})

describe('user menus (localStorage overlay, swapped for POST /api/menus later)', () => {
  it('saveUserMenu persists and wins over mock data', async () => {
    const date = addDays(today, 10) // future: no mock menu
    expect(await getMenu(date)).toBeNull()
    await saveUserMenu(date, {
      breakfast: [{ itemId: 'item_bagels', displayName: 'Bagels' }],
      lunch: [],
      dinner: [],
    })
    const menu = await getMenu(date)
    expect(menu?.source).toBe('user')
    expect(menu?.meals.breakfast[0].displayName).toBe('Bagels')
    const days = await getMenuDays(date, date)
    expect(days[date]).toBe(true)
  })
})

describe('getSummaryCards', () => {
  it('covers the expected windows and compares to the prior period', async () => {
    const cards = await getSummaryCards()
    expect(cards.today.start).toBe(today)
    expect(cards.today.end).toBe(today)
    expect(cards.thisMonth.start).toBe(today.slice(0, 8) + '01')
    expect(cards.thisWeek.end).toBe(today)
    // previous window exists in 400 days of mock history
    expect(cards.thisWeek.previousWasteUnits).not.toBeNull()
    expect(cards.thisMonth.wasteUnits).toBeGreaterThan(0)
    expect(cards.thisMonth.averagePlateWastePercent).toBeGreaterThanOrEqual(0)
    expect(cards.thisMonth.averagePlateWastePercent).toBeLessThanOrEqual(100)
  })
})
