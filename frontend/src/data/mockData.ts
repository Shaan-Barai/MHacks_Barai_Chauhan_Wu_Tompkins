/**
 * ALL dashboard mock data lives in this one file (UI.md "TECH") so it can be
 * swapped for backend / SpacetimeDB queries later. Nothing here is real:
 * waste figures are fake AI-style pixel-area estimates and attendance is
 * simulated. Values are deterministic for a given date so the demo is
 * repeatable.
 */
import type { DayMenu, HallSettings, IsoDate, MealLabel, ServiceDetail } from './types'
import { MEALS } from './types'
import { addDays } from '../lib/dates'

export const MOCK_HALL: HallSettings = {
  hallId: 'hall-main',
  name: 'South Quad Dining',
  timezone: 'America/Detroit',
  mealTimes: {
    breakfast: { start: '07:00', end: '10:30' },
    lunch: { start: '11:00', end: '14:30' },
    dinner: { start: '17:00', end: '20:30' },
  },
}

/** How many past days of mock history exist, and how far ahead menus go. */
export const MOCK_HISTORY_DAYS = 400
export const MOCK_FUTURE_MENU_DAYS = 5

/** Simulated attendance bounds (contracts/decisions.md, provisional). */
export const MOCK_ATTENDANCE = { min: 300, max: 1200, generatorVersion: 'mock-attendance-v1' }

interface MockItem {
  name: string
  /** Typical leftover fraction of a serving (mock). */
  waste: number
  /** Share of plates that take this item (mock). */
  take: number
  /** Expected uneaten-serving area in normalized pixels (mock baseline). */
  baselinePx: number
  tip: string
}

const ITEMS: Record<MealLabel, MockItem[]> = {
  breakfast: [
    { name: 'Scrambled Eggs', waste: 0.34, take: 0.55, baselinePx: 48000, tip: 'Try a smaller batch or a smaller serving scoop.' },
    { name: 'Pancakes', waste: 0.22, take: 0.45, baselinePx: 62000, tip: 'Offer single pancakes instead of stacks of three.' },
    { name: 'Hash Browns', waste: 0.18, take: 0.5, baselinePx: 40000, tip: 'Cook in smaller rounds so they stay crisp.' },
    { name: 'Turkey Sausage', waste: 0.12, take: 0.35, baselinePx: 22000, tip: 'Serve two links instead of three.' },
    { name: 'Oatmeal', waste: 0.26, take: 0.25, baselinePx: 45000, tip: 'Put toppings out so students can make it their own.' },
    { name: 'Fresh Fruit Cup', waste: 0.08, take: 0.4, baselinePx: 30000, tip: 'Keep portions as they are; this item is doing well.' },
    { name: 'Yogurt Parfait', waste: 0.1, take: 0.2, baselinePx: 28000, tip: 'Use a smaller cup for parfaits.' },
  ],
  lunch: [
    { name: 'Chicken Tenders', waste: 0.14, take: 0.5, baselinePx: 52000, tip: 'Serve three tenders and let students come back for more.' },
    { name: 'Caesar Salad', waste: 0.3, take: 0.3, baselinePx: 70000, tip: 'Dress salads lightly or offer dressing on the side.' },
    { name: 'Veggie Burger', waste: 0.24, take: 0.2, baselinePx: 50000, tip: 'Try a different patty brand or offer it on fewer days.' },
    { name: 'Tomato Soup', waste: 0.28, take: 0.25, baselinePx: 42000, tip: 'Offer a half-bowl size.' },
    { name: 'French Fries', waste: 0.2, take: 0.6, baselinePx: 46000, tip: 'Use a smaller fry scoop.' },
    { name: 'Pasta Primavera', waste: 0.33, take: 0.3, baselinePx: 64000, tip: 'Cook a smaller batch and refill more often.' },
    { name: 'Black Bean Tacos', waste: 0.16, take: 0.25, baselinePx: 44000, tip: 'Serve one taco by default with seconds available.' },
  ],
  dinner: [
    { name: 'Roast Chicken', waste: 0.18, take: 0.45, baselinePx: 58000, tip: 'Carve smaller pieces.' },
    { name: 'Mashed Potatoes', waste: 0.29, take: 0.5, baselinePx: 42000, tip: 'Use a smaller scoop for mashed potatoes.' },
    { name: 'Steamed Broccoli', waste: 0.38, take: 0.4, baselinePx: 36000, tip: 'Try roasting it with seasoning instead of steaming.' },
    { name: 'Beef Stir Fry', waste: 0.15, take: 0.35, baselinePx: 60000, tip: 'Keep the recipe; serve a little less rice with it.' },
    { name: 'Brown Rice', waste: 0.31, take: 0.4, baselinePx: 50000, tip: 'Offer white rice as an option or serve a half scoop.' },
    { name: 'Mac & Cheese', waste: 0.12, take: 0.45, baselinePx: 48000, tip: 'Popular item; keep portions steady.' },
    { name: 'Garden Salad', waste: 0.27, take: 0.3, baselinePx: 66000, tip: 'Pre-portion smaller side salads.' },
  ],
}

/** Small deterministic PRNG seeded from a string (mulberry32 over a hash). */
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function itemId(name: string): string {
  return 'item_' + name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** A few past days have no menu, to exercise the missing-menu states. */
function pastDayHasMenu(date: IsoDate): boolean {
  return rng('menu:' + date)() > 0.06
}

/** Generated menus: past history plus a few upcoming days. */
export function buildMockMenus(today: IsoDate): Record<IsoDate, DayMenu> {
  const menus: Record<IsoDate, DayMenu> = {}
  for (let i = -MOCK_HISTORY_DAYS; i <= MOCK_FUTURE_MENU_DAYS; i++) {
    const date = addDays(today, i)
    if (i < 0 && !pastDayHasMenu(date)) continue
    const r = rng('items:' + date)
    const menu = {} as DayMenu
    for (const meal of MEALS) {
      menu[meal] = ITEMS[meal].filter(() => r() < 0.8).map((it) => it.name)
      if (menu[meal].length < 3) menu[meal] = ITEMS[meal].slice(0, 4).map((it) => it.name)
    }
    menus[date] = menu
  }
  return menus
}

/**
 * Mock analytics output for one service, shaped like the payload Agent 6
 * computes and Agent 5 serves. `menu` is the menu for that meal (if any).
 */
export function buildMockService(
  date: IsoDate,
  meal: MealLabel,
  menu: string[] | undefined,
  today: IsoDate,
): ServiceDetail {
  const empty: ServiceDetail = {
    date,
    meal,
    status: 'no_menu',
    wasteUnits: 0,
    platesScanned: 0,
    platesExcluded: 0,
    unknownWasteUnits: 0,
    attendance: null,
    items: [],
    insight: null,
  }
  if (date > today || (date === today && meal === 'dinner')) {
    return { ...empty, status: menu?.length ? 'upcoming' : 'no_menu' }
  }
  if (!menu?.length) return empty
  const known = ITEMS[meal].filter((it) => menu.includes(it.name))
  // Menus typed in by hand (not in the mock catalog) have no scans yet.
  if (!known.length) return { ...empty, status: 'no_scans' }

  const r = rng(`svc:${date}:${meal}`)
  const dow = new Date(date + 'T12:00:00').getDay()
  const weekend = dow === 0 || dow === 6
  const attendance = Math.round(MOCK_ATTENDANCE.min + r() * (MOCK_ATTENDANCE.max - MOCK_ATTENDANCE.min) * (weekend ? 0.6 : 1))
  const platesScanned = Math.round(attendance * (0.25 + r() * 0.15))
  const platesExcluded = r() < 0.3 ? Math.floor(r() * 6) : 0
  // Slow improvement over time so the trend chart has a story.
  const ageDays = Math.max(0, (Date.parse(today) - Date.parse(date)) / 86_400_000)
  const trend = 0.85 + Math.min(ageDays, 120) / 600

  const items = known
    .map((it) => {
      const servings = platesScanned * it.take
      const fraction = Math.max(0.02, it.waste * trend * (0.7 + r() * 0.6))
      return { itemId: itemId(it.name), displayName: it.name, wasteUnits: Math.round(servings * it.baselinePx * fraction), tip: it.tip }
    })
    .sort((a, b) => b.wasteUnits - a.wasteUnits)
  const wasteUnits = items.reduce((s, it) => s + it.wasteUnits, 0)
  const top = items[0]
  const topShare = (top.wasteUnits / wasteUnits) * 100
  const fallback = r() < 0.12

  return {
    date,
    meal,
    status: 'ok',
    wasteUnits,
    platesScanned,
    platesExcluded,
    unknownWasteUnits: Math.round(wasteUnits * r() * 0.05),
    attendance: { count: attendance, source: 'simulated' },
    items: items.map(({ itemId, displayName, wasteUnits: w }) => ({
      itemId,
      displayName,
      wasteUnits: w,
      sharePercent: (w / wasteUnits) * 100,
    })),
    insight: {
      recommendation: fallback
        ? `${top.displayName} had the most leftover food at ${meal} (${Math.round(topShare)}% of waste). Consider reviewing its portion size.`
        : `${top.displayName} made up ${Math.round(topShare)}% of ${meal} waste. ${top.tip}`,
      source: fallback ? 'fallback_rules' : 'gemini',
      generatedAt: new Date(date + 'T22:00:00').toISOString(),
    },
  }
}

/** Mock menu-API connection test: any https URL with a key succeeds. */
export const MOCK_MENU_API_RULE = /^https?:\/\/.+/
