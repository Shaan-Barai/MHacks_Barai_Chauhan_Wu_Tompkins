/**
 * ALL demo data lives in this one file (UI.md "TECH") so it can be swapped for
 * the real backend / SpacetimeDB later, components never import it directly,
 * they go through src/data/api.ts.
 *
 * Nothing here is real. Pixels wasted are mock values shaped like mask pixel
 * counts in the normalized 1024x1024 top-down space (contracts/measurement.md).
 * Attendance ("meal swipes") is simulated, per AGENTS.md §7.
 * Everything is deterministic for a given date so the demo is repeatable.
 */
import { addDays, fromIso } from '../lib/dates'
import type {
  CaptureImages,
  CaptureListItem,
  DayMenu,
  ImpactDashboard,
  IsoDate,
  ItemImpactRow,
  MealDetail,
  MealLabel,
  MenuItemLite,
  ProcessingState,
  Recommendation,
} from './types'
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
    const perPlate = 20_000 + r() * 25_000 // mock leftover pixels per plate
    const noise = 0.75 + r() * 0.5
    const units = platesScanned * take * waste * perPlate * noise * weekend * drift
    return { it, def, units: Math.max(1, Math.round(units)) }
  })

  const total = rows.reduce((s, r) => s + r.units, 0)
  const sorted = rows
    .map(({ it, units }) => ({
      itemId: it.itemId,
      displayName: it.displayName,
      pixelsWasted: units,
      shareOfMealPixelsPercent: (units / total) * 100,
    }))
    .sort((a, b) => b.pixelsWasted - a.pixelsWasted)

  const top = sorted[0]
  const topDef = rows.find((r) => r.it.itemId === top.itemId)?.def
  const tipLine = topDef ? topDef.tip : 'Watch this item for a few services before changing the recipe.'
  const share = Math.round(top.shareOfMealPixelsPercent)

  return {
    serviceId: `svc_${MOCK_HALL_ID}_${date}_${meal}`,
    date,
    meal,
    pixelsWasted: total,
    platesScanned,
    unclassifiedPixels: 0,
    coverage: { platesCounted: platesScanned, emptyPlates: 0, platesLeftOut: 0 },
    mealSwipes: { count: attendance, source: 'simulated' },
    items: sorted,
    tip: {
      recommendation: `${top.displayName} made up ${share}% of ${MEAL_NAME[meal].toLowerCase()}'s wasted pixels. ${tipLine}`,
      source: 'gemini',
    },
  }
}

// ===========================================================================
// Waste impact demo (BIG-PLAN v2): the dinner menu from
// menu_waste_factors.csv, Pixels wasted, relative impact points
// (points = pixels/1000 x weight_g_per_cm2 x factor), relative nutrition
// points (separate), seeded demo portions, recent plates and their images.
// All of it is mock, deterministic per date. No grams, kg, litres or dollars.
// ===========================================================================

export const WASTE_FACTORS_VERSION = 'waste-factors-v2'
/** Impact score weights (BIG-PLAN v2 V2): impactPoints = 0.19 C + 1.50 W. No nutrition term. */
export const CO2_WEIGHT = 0.19
export const WATER_WEIGHT = 1.5

interface MockFactorFood {
  food: string
  station: string
  /** weight_g_per_cm2, C (kg CO2e/kg), W (m3/kg), O (nutrient-days/kg) from menu_waste_factors.csv */
  weight: number
  c: number
  w: number
  o: number
}

/** The 23 dinner foods, values copied from menu_waste_factors.csv. */
export const MOCK_DINNER_FOODS: MockFactorFood[] = [
  { food: 'Broccoli Cheddar Soup', station: 'Soup', weight: 1.5, c: 4.9, w: 1.07, o: 0.45 },
  { food: 'Baked Boneless Ham', station: 'Signature Maize', weight: 0.9, c: 12.39, w: 1.808, o: 0.38 },
  { food: 'Oven Roasted Garlic Potatoes', station: 'Signature Maize', weight: 1.6, c: 0.62, w: 0.117, o: 0.56 },
  { food: 'Baked Sweet Potatoes', station: 'Signature Maize', weight: 2.0, c: 0.43, w: 0.028, o: 1.8 },
  { food: 'Roasted Cauliflower', station: 'Signature Maize', weight: 1.0, c: 0.54, w: 0.13, o: 1.09 },
  { food: 'Michigan Farmers 4 Bean Stew', station: '24 Carrots', weight: 1.5, c: 0.95, w: 0.198, o: 0.58 },
  { food: 'Farro', station: '24 Carrots', weight: 1.1, c: 0.75, w: 0.311, o: 0.61 },
  { food: 'Shaved Brussel Sprouts', station: '24 Carrots', weight: 0.5, c: 0.97, w: 0.29, o: 1.31 },
  { food: 'Vegetable Cannelloni', station: '24 Carrots', weight: 2.0, c: 3.69, w: 0.883, o: 0.62 },
  { food: 'Panzanella Salad', station: '24 Carrots', weight: 0.9, c: 2.16, w: 0.587, o: 0.58 },
  { food: 'Ancho Flank Steak', station: 'Halal', weight: 1.2, c: 131.69, w: 1.925, o: 1.05 },
  { food: 'Sticky Rice', station: 'Halal', weight: 1.6, c: 1.78, w: 0.899, o: 0.24 },
  { food: 'Vegetable Stir Fry Blend', station: 'Halal', weight: 0.8, c: 0.48, w: 0.08, o: 1.58 },
  { food: 'Cheese Bread', station: 'Pizziti', weight: 0.7, c: 12.64, w: 3.032, o: 0.92 },
  { food: 'Pepperoni Pizza', station: 'Pizziti', weight: 1.0, c: 16.06, w: 1.94, o: 0.69 },
  { food: 'Cheese Pizza', station: 'Pizziti', weight: 1.0, c: 7.65, w: 1.94, o: 0.72 },
  { food: 'Chicken Broccoli Alfredo Pizza', station: 'Pizziti', weight: 1.1, c: 8.75, w: 1.922, o: 0.7 },
  { food: 'Chocolate Coconut Cream Pie', station: 'MBakery', weight: 2.4, c: 5.55, w: 0.303, o: 0.39 },
  { food: 'Pumpkin Pie', station: 'MBakery', weight: 2.2, c: 4.52, w: 0.894, o: 0.97 },
  { food: 'Snickers Brownies with Peanuts', station: 'MBakery', weight: 2.2, c: 12.93, w: 1.365, o: 0.55 },
  { food: 'Peppermint White Chocolate Blondie', station: 'MBakery', weight: 2.0, c: 7.27, w: 1.16, o: 0.41 },
  { food: 'Golden Cake with Chocolate Frosting', station: 'MBakery', weight: 1.8, c: 3.53, w: 0.335, o: 0.4 },
  { food: 'Strawberry Shortcake Bar', station: 'MBakery', weight: 1.5, c: 2.49, w: 0.442, o: 0.55 },
]

/** A menu item with no factor row (exercises the "no impact data" state). */
const NO_FACTOR_FOOD = "Chef's Soup of the Day"
/** Demo menu item whose portions were never entered (exercises "no portions entered"). */
const NO_PORTIONS_FOOD = 'Farro'

export function factorKeyFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

interface MockServiceItem {
  name: string
  factor: MockFactorFood | null
  pixels: number
  portions: number | null
}

interface MockDinnerService {
  date: IsoDate
  serviceId: string
  plates: number
  excluded: number
  /** Plates where food on a neighboring plate was left out (target-dish counting). */
  neighborExcluded: number
  items: MockServiceItem[]
  unknownPixels: number
}

/** One dinner service's mock measurements (null = no menu / future day). */
export function mockDinnerService(date: IsoDate, today: IsoDate): MockDinnerService | null {
  if (date > today || !mockDayHasMenu(date, today)) return null
  const r = rng(`impact:${date}`)
  const plates = 120 + Math.floor(r() * 140)
  const excluded = Math.floor(r() * 6)
  const neighborExcluded = Math.floor(r() * 4)
  const picked = [...MOCK_DINNER_FOODS].sort(() => r() - 0.5).slice(0, 14)
  const names: { name: string; factor: MockFactorFood | null }[] = picked.map((f) => ({ name: f.food, factor: f }))
  if (r() < 0.5) names.push({ name: NO_FACTOR_FOOD, factor: null })
  const items = names.map(({ name, factor }) => {
    const ir = rng(`impact-item:${date}:${name}`)
    const take = 0.15 + rng(`take:${name}`)() * 0.3
    const propensity = 0.15 + rng(`leftover:${name}`)() * 0.45
    const pixels = Math.round((plates - excluded) * take * propensity * 42_000 * (0.75 + ir() * 0.5))
    // D6: seeded demo portions in 40-260, a bit above the plates seen with this food.
    const portions = name === NO_PORTIONS_FOOD ? null : Math.min(260, Math.max(40, Math.round(plates * take * (1.2 + ir() * 0.8))))
    return { name, factor, pixels, portions }
  })
  return {
    date,
    serviceId: `svc_${MOCK_HALL_ID}_${date}_dinner`,
    plates,
    excluded,
    neighborExcluded,
    items,
    unknownPixels: Math.round(plates * 600 * (0.5 + r())),
  }
}

/** Relative points for counted pixels: pixels/1000 x weight_g_per_cm2 x factor. */
function pointsOf(pixels: number, factor: MockFactorFood | null, pick: (f: MockFactorFood) => number): number | null {
  return factor ? (pixels / 1000) * factor.weight * pick(factor) : null
}

function impactFrom(pixels: number, factor: MockFactorFood | null, unavailable?: 'no_factor' | 'unknown_item') {
  const co2Points = pointsOf(pixels, factor, (f) => f.c)
  const waterPoints = pointsOf(pixels, factor, (f) => f.w)
  return {
    pixels,
    co2Points,
    waterPoints,
    impactPoints: co2Points !== null && waterPoints !== null ? CO2_WEIGHT * co2Points + WATER_WEIGHT * waterPoints : null,
    nutritionPoints: pointsOf(pixels, factor, (f) => f.o),
    wasteFactorsVersion: WASTE_FACTORS_VERSION,
    ...(unavailable ? { unavailableReason: unavailable } : {}),
  }
}

/** Mock GET /api/dashboard/impact over a window of dinner services. */
export function mockImpactDashboard(start: IsoDate, end: IsoDate, today: IsoDate): ImpactDashboard {
  const byItem = new Map<string, { name: string; factor: MockFactorFood | null; pixels: number; portions: number | null; portionsMissing: boolean }>()
  let unknownPixels = 0
  let captures = 0
  let excluded = 0
  let neighborExcluded = 0
  for (const date of eachDayInclusive(start, end)) {
    const svc = mockDinnerService(date, today)
    if (!svc) continue
    captures += svc.plates
    excluded += svc.excluded
    neighborExcluded += svc.neighborExcluded
    unknownPixels += svc.unknownPixels
    for (const it of svc.items) {
      const acc = byItem.get(it.name) ?? { name: it.name, factor: it.factor, pixels: 0, portions: 0, portionsMissing: false }
      acc.pixels += it.pixels
      if (it.portions === null) acc.portionsMissing = true
      else acc.portions = (acc.portions ?? 0) + it.portions
      byItem.set(it.name, acc)
    }
  }

  const rows: ItemImpactRow[] = [...byItem.values()].map((acc) => {
    const impact = impactFrom(acc.pixels, acc.factor, acc.factor ? undefined : 'no_factor')
    const portionsServed = acc.portionsMissing ? null : acc.portions
    // Sum then divide (pixels over the window / portions over the window).
    const perPortion =
      portionsServed && portionsServed > 0
        ? {
            pixels: impact.pixels / portionsServed,
            impactPoints: impact.impactPoints === null ? null : impact.impactPoints / portionsServed,
          }
        : null
    return {
      itemId: itemIdFor(acc.name),
      displayName: acc.name,
      factorKey: acc.factor ? factorKeyFor(acc.factor.food) : null,
      impact,
      portionsServed,
      portionsSource: portionsServed === null ? null : 'demo',
      perPortion,
    }
  })
  if (unknownPixels > 0) {
    rows.push({
      itemId: null,
      displayName: 'Food not on the menu',
      factorKey: null,
      impact: impactFrom(unknownPixels, null, 'unknown_item'),
      portionsServed: null,
      portionsSource: null,
      perPortion: null,
    })
  }

  const sum = (pick: (r: ItemImpactRow) => number | null) => {
    let any = false
    let total = 0
    for (const row of rows) {
      const v = pick(row)
      if (v !== null) {
        any = true
        total += v
      }
    }
    return any ? total : null
  }
  const targets = [...rows].sort(
    (a, b) =>
      (a.perPortion === null ? 1 : 0) - (b.perPortion === null ? 1 : 0) ||
      (b.perPortion?.pixels ?? 0) - (a.perPortion?.pixels ?? 0) ||
      b.impact.pixels - a.impact.pixels,
  )
  const mostWasted = [...rows].sort((a, b) => b.impact.pixels - a.impact.pixels)
  const named = rows.filter((r) => r.itemId !== null)

  return {
    window: { start, end, hallId: MOCK_HALL_ID },
    totals: {
      pixels: rows.reduce((s, r) => s + r.impact.pixels, 0),
      co2Points: sum((r) => r.impact.co2Points),
      waterPoints: sum((r) => r.impact.waterPoints),
      impactPoints: sum((r) => r.impact.impactPoints),
      nutritionPoints: sum((r) => r.impact.nutritionPoints),
      wasteFactorsVersion: WASTE_FACTORS_VERSION,
      captures,
      analyzedCaptures: captures - excluded,
      excludedCaptures: excluded,
    },
    targets,
    mostWasted,
    coverage: {
      itemsWithFactor: named.filter((r) => r.factorKey !== null).length,
      itemsWithoutFactor: named.filter((r) => r.factorKey === null).length,
      itemsWithPortions: named.filter((r) => r.portionsServed !== null).length,
      capturesWithNeighborFoodExcluded: neighborExcluded,
    },
    labels: { relativeImpact: true, demoPortions: true },
  }
}

function eachDayInclusive(start: IsoDate, end: IsoDate): IsoDate[] {
  const out: IsoDate[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}

// ---------------------------------------------------------------------------
// Recent plates (gallery) and their mock images
// ---------------------------------------------------------------------------

const PLATES_PER_DAY = 8

/** One mock capture; `n` is its order within the day's dinner (0 = first). */
export function mockCapture(date: IsoDate, n: number, today: IsoDate): CaptureListItem | null {
  const svc = mockDinnerService(date, today)
  if (!svc || n < 0 || n >= PLATES_PER_DAY) return null
  const r = rng(`capture:${date}:${n}`)
  const minutes = 17 * 60 + 30 + n * 17 + Math.floor(r() * 10)
  const at = fromIso(date)
  at.setHours(Math.floor(minutes / 60), minutes % 60, Math.floor(r() * 60))
  const state: ProcessingState = n === 2 ? 'failed' : n === 5 && r() < 0.6 ? 'needs_review' : 'succeeded'
  const clean = n === 6
  const eventId = `cap_${date}_${n}`
  const base = { eventId, capturedAt: at.toISOString(), serviceId: svc.serviceId, source: (n === 7 ? 'replay' : 'camera') as CaptureListItem['source'] }
  if (state === 'failed') return { ...base, state, pixelsWasted: null, items: [], hasOverlay: false }
  if (clean) return { ...base, state, pixelsWasted: 0, items: [], hasOverlay: true }
  const count = 1 + Math.floor(r() * 3)
  const pool = [...svc.items].sort(() => r() - 0.5).slice(0, count)
  const items = pool.map((it) => {
    const pixels = 6_000 + Math.floor(r() * 52_000)
    return { itemId: itemIdFor(it.name), displayName: it.name, pixels }
  })
  return {
    ...base,
    state,
    pixelsWasted: items.reduce((s, i) => s + i.pixels, 0),
    items,
    hasOverlay: true,
  }
}

/** Mock GET /api/captures: the latest few dinners in the window, newest first. */
export function mockCaptures(start: IsoDate, end: IsoDate, today: IsoDate, maxDays = 3): CaptureListItem[] {
  const out: CaptureListItem[] = []
  let days = 0
  for (let d = end > today ? today : end; d >= start && days < maxDays; d = addDays(d, -1)) {
    if (!mockDinnerService(d, today)) continue
    days++
    for (let n = PLATES_PER_DAY - 1; n >= 0; n--) {
      const c = mockCapture(d, n, today)
      if (c) out.push(c)
    }
  }
  return out
}

/** Muted food tints for the mock photo (content, not UI chrome). */
const FOOD_TONES = ['#8a5a3c', '#c9a227', '#6b8e4e', '#b5523b', '#d8c9a3']
/** Overlay tints, one per food, in legend order. */
export const OVERLAY_TINTS = ['#e4572e', '#17bebb', '#ffc914', '#76b041', '#a23b72']

interface Blob {
  cx: number
  cy: number
  rx: number
  ry: number
}

function blobsFor(capture: CaptureListItem): Blob[] {
  const r = rng(`blobs:${capture.eventId}`)
  return capture.items.map((it, i) => {
    // pixels are in a 1024x1024 space; the mock image is 480x480.
    const radius = Math.max(10, Math.sqrt(it.pixels / Math.PI) * (480 / 1024))
    const angle = (i / Math.max(1, capture.items.length)) * Math.PI * 2 + r() * 0.8
    const dist = 40 + r() * 60
    return { cx: 240 + Math.cos(angle) * dist, cy: 240 + Math.sin(angle) * dist, rx: radius * (1.1 + r() * 0.3), ry: radius * (0.8 + r() * 0.2) }
  })
}

function svgUrl(body: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480">${body}</svg>`,
  )}`
}

function plateSvg(blobs: Blob[]): string {
  return (
    '<rect width="480" height="480" fill="#6f655c"/>' +
    '<circle cx="240" cy="240" r="215" fill="#f4f1ea" stroke="#d8d2c4" stroke-width="6"/>' +
    '<circle cx="240" cy="240" r="165" fill="none" stroke="#e6e0d3" stroke-width="3"/>' +
    blobs.map((b, i) => `<ellipse cx="${b.cx.toFixed(1)}" cy="${b.cy.toFixed(1)}" rx="${b.rx.toFixed(1)}" ry="${b.ry.toFixed(1)}" fill="${FOOD_TONES[i % FOOD_TONES.length]}"/>`).join('')
  )
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;').replace(/"/g, '&quot;')
}

/** Mock GET /api/captures/:eventId/images (data URLs, 15-minute "expiry"). */
export function mockCaptureImages(eventId: string, today: IsoDate, now: Date): CaptureImages | null {
  const m = /^cap_(\d{4}-\d{2}-\d{2})_(\d+)$/.exec(eventId)
  const capture = m ? mockCapture(m[1], Number(m[2]), today) : null
  if (!capture) return null
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString()
  const blobs = blobsFor(capture)
  const plate = plateSvg(blobs)
  // One plate per dinner has a neighboring dish at the edge of the photo
  // (target-dish counting: outlined as not counted, BIG-PLAN v2 V3).
  const neighbor = Number(m![2]) === 3
  const neighborSvg = neighbor
    ? '<circle cx="490" cy="470" r="120" fill="#f4f1ea" stroke="#d8d2c4" stroke-width="6"/><ellipse cx="430" cy="430" rx="34" ry="24" fill="#8a5a3c"/>'
    : ''
  const neighborOutline = neighbor
    ? '<ellipse cx="430" cy="430" rx="34" ry="24" fill="none" stroke="#ffffff" stroke-width="3" stroke-dasharray="6 4"/>' +
      '<text x="470" y="474" text-anchor="end" font-family="Times New Roman, serif" font-size="15" fill="#ffffff">Other dish (not counted)</text>'
    : ''
  const photo = plate + neighborSvg
  const original = { objectId: `img_${eventId}`, url: svgUrl(photo), expiresAt }
  if (!capture.hasOverlay) return { eventId, original, overlay: null, masks: [] }
  const overlayBody =
    photo +
    '<rect width="480" height="480" fill="#000" opacity="0.25"/>' +
    '<circle cx="240" cy="240" r="215" fill="none" stroke="#ffffff" stroke-width="3" stroke-dasharray="10 6"/>' +
    blobs
      .map(
        (b, i) =>
          `<ellipse cx="${b.cx.toFixed(1)}" cy="${b.cy.toFixed(1)}" rx="${b.rx.toFixed(1)}" ry="${b.ry.toFixed(1)}" fill="${OVERLAY_TINTS[i % OVERLAY_TINTS.length]}" fill-opacity="0.55" stroke="${OVERLAY_TINTS[i % OVERLAY_TINTS.length]}" stroke-width="3"/>`,
      )
      .join('') +
    capture.items
      .map(
        (it, i) =>
          `<rect x="12" y="${12 + i * 26}" width="16" height="16" fill="${OVERLAY_TINTS[i % OVERLAY_TINTS.length]}"/><text x="34" y="${25 + i * 26}" font-family="Times New Roman, serif" font-size="15" fill="#ffffff">${escapeXml(it.displayName)}</text>`,
      )
      .join('') +
    neighborOutline
  return {
    eventId,
    original,
    overlay: { objectId: `img_${eventId}_overlay`, url: svgUrl(overlayBody), expiresAt },
    masks: capture.items.map((it, i) => ({
      objectId: `img_${eventId}_mask_${i}`,
      url: svgUrl(
        `<rect width="480" height="480" fill="#000"/><ellipse cx="${blobs[i].cx.toFixed(1)}" cy="${blobs[i].cy.toFixed(1)}" rx="${blobs[i].rx.toFixed(1)}" ry="${blobs[i].ry.toFixed(1)}" fill="#fff"/>`,
      ),
      expiresAt,
      itemId: it.itemId,
      displayName: it.displayName,
    })),
  }
}

// ---------------------------------------------------------------------------
// Recommendation (rule-based demo text grounded in the mock dashboard)
// ---------------------------------------------------------------------------

export function mockRecommendation(dash: ImpactDashboard, now: Date): Recommendation {
  const ranked = dash.targets.filter((r) => r.perPortion != null)
  const top = ranked[0]
  const second = ranked[1]
  const most = dash.mostWasted[0]
  const missing = dash.targets.filter((r) => r.itemId !== null && r.portionsServed === null)
  const bullets: Recommendation['bullets'] = []
  const px = (n: number) => `${Math.round(n).toLocaleString()} pixels`
  if (top?.perPortion) {
    bullets.push({
      text: `Try a smaller serving of ${top.displayName} for a week and compare.`,
      metric: `${px(top.perPortion.pixels)} wasted per portion over ${(top.portionsServed ?? 0).toLocaleString()} portions`,
    })
  }
  if (second?.perPortion) {
    bullets.push({
      text: `Cook ${second.displayName} in smaller batches and refill more often.`,
      metric: `${px(second.perPortion.pixels)} wasted per portion`,
    })
  }
  if (most) {
    const pts = most.impact.impactPoints
    bullets.push({
      text: `${most.displayName} had the most food left overall.`,
      metric: `${px(most.impact.pixels)} wasted${pts == null ? '' : `, ${Math.round(pts).toLocaleString()} relative impact points`}`,
    })
  }
  if (missing.length > 0) {
    bullets.push({
      text: `Enter portions served for ${missing.map((m) => m.displayName).join(', ')} so ${missing.length === 1 ? 'it' : 'they'} can be ranked.`,
      metric: 'No portions entered',
    })
  }
  const text = top
    ? `${top.displayName} had the most food left per portion in these days. A smaller serving is the simplest thing to test first. These numbers come from a sample of plates, so they show where to look, not why food was left.`
    : 'Not enough plates with portions served yet to suggest a change.'
  return {
    text,
    bullets,
    source: 'fallback',
    generatedAt: now.toISOString(),
    inputVersion: `demo:${dash.window.start}:${dash.window.end}:${WASTE_FACTORS_VERSION}`,
  }
}
