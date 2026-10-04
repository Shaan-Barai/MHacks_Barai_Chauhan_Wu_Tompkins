/**
 * ALL demo data lives in this one file (UI.md "TECH") so it can be swapped for
 * the real backend / SpacetimeDB later, components never import it directly,
 * they go through src/data/api.ts.
 *
 * Nothing here is real. "Waste units" are mock AI-style estimates of leftover
 * food area (contracts/README.md: observed estimated leftover area in pixels;
 * here pre-scaled so 1 waste unit ≈ 1,000 px² in the normalized top-down
 * space). Attendance ("meal swipes") is simulated, per AGENTS.md §7.
 * Everything is deterministic for a given date so the demo is repeatable.
 */
import { addDays, fromIso } from '../lib/dates'
import type { DayMenu, IsoDate, MealDetail, MealLabel, MenuItemLite } from './types'
import { MEALS, MEAL_NAME } from './types'

export const MOCK_HALL_ID = 'hall-main'

/** How far back mock history goes, and how far ahead mock menus exist. */
export const MOCK_HISTORY_DAYS = 400
export const MOCK_FUTURE_MENU_DAYS = 3

/** Simulated attendance bounds (contracts/decisions provisional default). */
const ATTENDANCE_MIN = 300
const ATTENDANCE_MAX = 1200

interface MockItemDef {
  name: string
  /** Typical leftover fraction of a serving (mock). */
  waste: number
  /** Share of diners who take this item (mock). */
  take: number
  /** One-line, Gemini-style tip shown when this item tops the meal. */
  tip: string
}

const ITEMS: Record<MealLabel, MockItemDef[]> = {
  breakfast: [
    { name: 'Scrambled Eggs', waste: 0.34, take: 0.55, tip: 'Try a smaller batch or a smaller serving scoop.' },
    { name: 'Pancakes', waste: 0.22, take: 0.45, tip: 'Offer single pancakes instead of stacks of three.' },
    { name: 'Hash Browns', waste: 0.18, take: 0.5, tip: 'Cook smaller rounds so they stay crisp through service.' },
    { name: 'Turkey Sausage', waste: 0.12, take: 0.35, tip: 'Serve two links instead of three.' },
    { name: 'Oatmeal', waste: 0.26, take: 0.25, tip: 'Put toppings out so students can make it their own.' },
    { name: 'Fresh Fruit Cup', waste: 0.08, take: 0.4, tip: 'Portions look right for this item, keep them steady.' },
    { name: 'Yogurt Parfait', waste: 0.1, take: 0.2, tip: 'Use a smaller cup for parfaits.' },
  ],
  lunch: [
    { name: 'Chicken Tenders', waste: 0.14, take: 0.5, tip: 'Serve three tenders and let students come back for more.' },
    { name: 'Caesar Salad', waste: 0.3, take: 0.3, tip: 'Dress salads lightly or offer dressing on the side.' },
    { name: 'Veggie Burger', waste: 0.24, take: 0.2, tip: 'Try a different patty or offer it on fewer days.' },
    { name: 'Tomato Soup', waste: 0.28, take: 0.25, tip: 'Offer a half-bowl size.' },
    { name: 'French Fries', waste: 0.2, take: 0.6, tip: 'Use a smaller fry scoop.' },
    { name: 'Pasta Primavera', waste: 0.33, take: 0.3, tip: 'Cook a smaller batch and refill more often.' },
    { name: 'Black Bean Tacos', waste: 0.16, take: 0.25, tip: 'Serve one taco by default with seconds available.' },
  ],
  dinner: [
    { name: 'Roast Chicken', waste: 0.18, take: 0.45, tip: 'Carve smaller pieces.' },
    { name: 'Mashed Potatoes', waste: 0.29, take: 0.5, tip: 'Use a smaller scoop for mashed potatoes.' },
    { name: 'Steamed Broccoli', waste: 0.38, take: 0.4, tip: 'Try roasting it with seasoning instead of steaming.' },
    { name: 'Beef Stir Fry', waste: 0.15, take: 0.35, tip: 'Keep the recipe, serve a little less rice with it.' },
    { name: 'Brown Rice', waste: 0.31, take: 0.4, tip: 'Offer a half scoop of rice by default.' },
    { name: 'Mac & Cheese', waste: 0.12, take: 0.45, tip: 'Popular item, keep portions steady.' },
    { name: 'Garden Salad', waste: 0.27, take: 0.3, tip: 'Pre-portion smaller side salads.' },
  ],
}

/** Small deterministic PRNG seeded from a string (mulberry32 over a hash). */
export function rng(seed: string): () => number {
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

export function itemIdFor(name: string): string {
  return (
    'item_' +
    name
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  )
}

/** A few mock days have no menu (exercises the missing-menu states). */
export function mockDayHasMenu(date: IsoDate, today: IsoDate): boolean {
  if (date > addDays(today, MOCK_FUTURE_MENU_DAYS)) return false
  if (date < addDays(today, -MOCK_HISTORY_DAYS)) return false
  return rng('menu:' + date)() > 0.07
}

/** Deterministic mock menu for a date (null = no menu that day). */
export function mockMenuFor(date: IsoDate, today: IsoDate): DayMenu | null {
  if (!mockDayHasMenu(date, today)) return null
  const meals = {} as Record<MealLabel, MenuItemLite[]>
  for (const meal of MEALS) {
    const r = rng(`items:${date}:${meal}`)
    const pool = ITEMS[meal]
    const count = 5 + Math.floor(r() * (pool.length - 4)) // 5..pool size
    const picked = [...pool].sort(() => r() - 0.5).slice(0, count)
    meals[meal] = picked.map((i) => ({ itemId: itemIdFor(i.name), displayName: i.name }))
  }
  return { date, menuId: `menu_${MOCK_HALL_ID}_${date}`, source: 'mock', meals }
}

/** Stable simulated attendance per hall/date/service (never regenerated). */
export function mockAttendance(date: IsoDate, meal: MealLabel): number {
  const r = rng(`attendance:${date}:${meal}`)()
  return ATTENDANCE_MIN + Math.floor(r * (ATTENDANCE_MAX - ATTENDANCE_MIN + 1))
}

/**
 * Deterministic mock waste detail for one meal service. `menu` is the menu in
 * effect that day (mock or user-uploaded); null when there is no data.
 * Waste exists only for today and earlier.
 */
export function mockMealDetail(date: IsoDate, meal: MealLabel, menu: DayMenu | null, today: IsoDate): MealDetail | null {
  if (!menu || date > today) return null
  const items = menu.meals[meal]
  if (!items.length) return null

  const attendance = mockAttendance(date, meal)
  // The camera only sees a sample of plates (coverage 25–45%).
  const coverage = 0.25 + rng(`coverage:${date}:${meal}`)() * 0.2
  const platesScanned = Math.round(attendance * coverage)

  // Weekly rhythm + slow seasonal drift so the chart has a story.
  const dow = fromIso(date).getDay()
  const weekend = dow === 0 || dow === 6 ? 0.8 : 1
  const drift = 1 + 0.15 * Math.sin(fromIso(date).getTime() / 86_400_000 / 23)

  const defs = ITEMS[meal]
  const rows = items.map((it) => {
    const def = defs.find((d) => itemIdFor(d.name) === it.itemId)
    // User-typed items get middling, seeded behavior.
    const r = rng(`waste:${date}:${meal}:${it.itemId}`)
    const waste = def ? def.waste : 0.12 + r() * 0.2
    const take = def ? def.take : 0.2 + r() * 0.3
    const perPlate = 20 + r() * 25 // mock serving size in waste units
    const noise = 0.75 + r() * 0.5
    const units = platesScanned * take * waste * perPlate * noise * weekend * drift
    return { it, def, units: Math.max(1, Math.round(units)) }
  })

  const total = rows.reduce((s, r) => s + r.units, 0)
  const sorted = rows
    .map(({ it, units }) => ({
      itemId: it.itemId,
      displayName: it.displayName,
      wasteUnits: units,
      shareOfMealWastePercent: (units / total) * 100,
    }))
    .sort((a, b) => b.wasteUnits - a.wasteUnits)

  const top = sorted[0]
  const topDef = rows.find((r) => r.it.itemId === top.itemId)?.def
  const tipLine = topDef ? topDef.tip : 'Watch this item for a few services before changing the recipe.'
  const share = Math.round(top.shareOfMealWastePercent)

  return {
    serviceId: `svc_${MOCK_HALL_ID}_${date}_${meal}`,
    date,
    meal,
    totalWasteUnits: total,
    platesScanned,
    coverage: { platesAnalyzed: platesScanned, platesLeftOut: 0, itemsLeftOut: 0 },
    mealSwipes: { count: attendance, source: 'simulated' },
    items: sorted,
    tip: {
      recommendation: `${top.displayName} made up ${share}% of ${MEAL_NAME[meal].toLowerCase()} waste. ${tipLine}`,
      source: 'gemini',
    },
  }
}
