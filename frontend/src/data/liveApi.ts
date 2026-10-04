/**
 * Live data access against Agent 5's backend (backend/README.md). Same
 * function signatures as mockApi.ts; api.ts picks one.
 *
 * Everything is Pixels wasted (contracts/measurement.md): integer counts of
 * foreground pixels in validated leftover-food masks, shown as-is (no
 * "waste units" scaling). Totals, shares, and exclusions are computed
 * server-side by analytics/; components never redo canonical math.
 */
import { loadSettings, primaryHallId } from '../state/settings'
import type {
  CaptureImages,
  CaptureListItem,
  ImpactDashboard,
  Recommendation,
  DailyWastePoint,
  DayMenu,
  IsoDate,
  MealDetail,
  MealLabel,
  MenuItemLite,
  PeriodSummary,
  SummaryCards,
  PortionService,
  PortionEntry,
  PortionBenchmark,
  PlateRecord,
} from './types'
import { MEALS } from './types'
import { todayIso } from '../lib/dates'

/** contracts/decisions.md: hall timezone until a hall config says otherwise. */
export const HALL_TIMEZONE = 'America/Detroit'

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')

function hallId(): string {
  return primaryHallId(loadSettings())
}

interface ApiErrorBody {
  error?: { code: string; message: string }
}

class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, init)
  } catch {
    throw new Error("Can't reach ScrapSaver right now. Try again in a minute.")
  }
  const body = (await res.json().catch(() => ({}))) as T & ApiErrorBody
  if (!res.ok) {
    throw new ApiRequestError(res.status, body.error?.code, body.error?.message ?? 'Something went wrong on the server.')
  }
  return body
}

/** 404 "not found yet" answers become null (friendly empty states), other errors surface. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null
    throw err
  }
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString()

/**
 * Dashboard reads take the halls to show. One hall is sent as `hallId`;
 * several are left out so impact/recommendation/captures total every hall.
 */
const hallParam = (hallIds: string[]): Record<string, string> =>
  hallIds.length === 1 ? { hallId: hallIds[0] } : {}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

interface MenuBundle {
  service: { serviceId: string; menuId: string; menuVersion: number; serviceDate: string; mealLabel: MealLabel }
  items: { itemId: string; displayName: string }[]
}

export async function getMenu(date: IsoDate): Promise<DayMenu | null> {
  const body = await orNull(call<{ menus: MenuBundle[] }>(`/api/menus?${q({ hallId: hallId(), date })}`))
  if (!body || body.menus.length === 0) return null
  const meals: Record<MealLabel, MenuItemLite[]> = { breakfast: [], lunch: [], dinner: [] }
  for (const m of body.menus) {
    meals[m.service.mealLabel] = m.items.map((i) => ({ itemId: i.itemId, displayName: i.displayName }))
  }
  return { date, menuId: body.menus[0].service.menuId, source: 'user', meals }
}

export async function getMenuDays(start: IsoDate, end: IsoDate): Promise<Record<IsoDate, boolean>> {
  const { dates } = await call<{ dates: IsoDate[] }>(`/api/menus/days?${q({ hallId: hallId(), start, end })}`)
  const have = new Set(dates)
  const out: Record<IsoDate, boolean> = {}
  for (let d = start; d <= end; d = nextDay(d)) out[d] = have.has(d)
  return out
}

function nextDay(d: IsoDate): IsoDate {
  const t = new Date(`${d}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + 1)
  return t.toISOString().slice(0, 10)
}

/** POST /api/menus/upload, parsed and versioned by the backend (data/ helpers). */
export async function saveUserMenu(date: IsoDate, meals: Record<MealLabel, MenuItemLite[]>): Promise<DayMenu> {
  const day: Record<string, unknown> = { date }
  for (const meal of MEALS) if (meals[meal].length > 0) day[meal] = meals[meal].map((i) => i.displayName)
  await call('/api/menus/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hallId: hallId(), hallTimezone: HALL_TIMEZONE, days: [day] }),
  })
  return (await getMenu(date)) ?? { date, menuId: '', source: 'user', meals }
}

/** The same menu on several dates (Repeat), sent as one upload. */
export async function saveUserMenuDays(dates: IsoDate[], meals: Record<MealLabel, MenuItemLite[]>): Promise<void> {
  const days = dates.map((date) => {
    const day: Record<string, unknown> = { date }
    for (const meal of MEALS) if (meals[meal].length > 0) day[meal] = meals[meal].map((i) => i.displayName)
    return day
  })
  await call('/api/menus/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hallId: hallId(), hallTimezone: HALL_TIMEZONE, days }),
  })
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function getDailyWaste(start: IsoDate, end: IsoDate, hallIds: string[] = [hallId()]): Promise<DailyWastePoint[]> {
  // The daily endpoint is per hall, so several halls are fetched and added up by date.
  const perHall = await Promise.all(hallIds.map((id) => dailyForHall(id, start, end)))
  if (perHall.length === 1) return perHall[0]
  const byDate = new Map<IsoDate, DailyWastePoint>()
  for (const points of perHall) {
    for (const p of points) {
      const acc = byDate.get(p.date)
      byDate.set(p.date, acc ? { date: p.date, pixelsWasted: addNullable(acc.pixelsWasted, p.pixelsWasted), ...sumGrams(acc, p) } : p)
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

async function dailyForHall(id: string, start: IsoDate, end: IsoDate): Promise<DailyWastePoint[]> {
  const { days } = await call<{ days: { date: IsoDate; pixelsWasted: number | null; grams?: number | null }[] }>(
    `/api/dashboard/daily?${q({ hallId: id, start, end })}`,
  )
  // grams is optional: when the backend sends it the chart shows estimated grams.
  return days.map((d) => ({ date: d.date, pixelsWasted: d.pixelsWasted, ...(d.grams !== undefined ? { grams: d.grams } : {}) }))
}

/** null means "no data", so it only wins when every hall has none. */
function addNullable(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0)
}

function sumGrams(a: DailyWastePoint, b: DailyWastePoint): { grams?: number | null } {
  return a.grams === undefined && b.grams === undefined ? {} : { grams: addNullable(a.grams ?? null, b.grams ?? null) }
}

interface MealResponse {
  portionBenchmark?: PortionBenchmark
  serviceId: string
  summary: {
    captureCount: number
    countedCaptureCount: number
    emptyPlateCount: number
    excludedCaptureCount: number
    pixelsWasted: number
    unclassifiedPixels: number
    items: {
      itemId: string
      displayName?: string
      pixelsWasted: number
      shareOfMealPixelsPercent: number | null
    }[]
  }
  attendance: { count: number; source: 'simulated' }
  insight: { recommendation: string; source: 'gemini' | 'fallback_rules' } | null
}

/** Null = no menu or no scanned plate yet (friendly empty state). */
export async function getMealDetail(date: IsoDate, meal: MealLabel): Promise<MealDetail | null> {
  const body = await orNull(call<MealResponse>(`/api/dashboard/meal?${q({ hallId: hallId(), date, meal })}`))
  // Scanned plates that weren't counted stay visible (AGENTS.md §9.7).
  if (!body || body.summary.captureCount === 0) return null
  const s = body.summary
  return {
    serviceId: body.serviceId,
    date,
    meal,
    pixelsWasted: s.pixelsWasted,
    unclassifiedPixels: s.unclassifiedPixels,
    platesScanned: s.captureCount,
    coverage: {
      platesCounted: s.countedCaptureCount,
      emptyPlates: s.emptyPlateCount,
      platesLeftOut: s.excludedCaptureCount,
    },
    mealSwipes: { count: body.attendance.count, source: 'simulated' },
    items: s.items.map((i) => ({
      itemId: i.itemId,
      displayName: i.displayName ?? i.itemId,
      pixelsWasted: i.pixelsWasted,
      shareOfMealPixelsPercent: i.shareOfMealPixelsPercent ?? 0,
    })),
    tip: body.insight && { recommendation: body.insight.recommendation, source: body.insight.source },
    ...(body.portionBenchmark ? { portionBenchmark: body.portionBenchmark } : {}),
  }
}

export async function getPortionService(date: IsoDate, meal: MealLabel): Promise<PortionService | null> {
  const menus = await orNull(call<{ menus: MenuBundle[] }>(`/api/menus?${q({ hallId: hallId(), date, meal })}`))
  const menu = menus?.menus[0]
  if (!menu) return null
  const body = await call<{ menu: MenuBundle; portions: PortionService['portions'] }>(
    `/api/portions-served?${q({ hallId: hallId(), serviceId: menu.service.serviceId })}`)
  return { serviceId: body.menu.service.serviceId, menuVersion: body.menu.service.menuVersion, items: body.menu.items, portions: body.portions }
}

export async function savePortions(service: PortionService, entries: PortionEntry[]): Promise<void> {
  await call(`/api/portions-served?${q({ hallId: hallId(), serviceId: service.serviceId })}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceId: service.serviceId, menuVersion: service.menuVersion, entries }),
  })
}

export async function importPortionsCsv(service: PortionService, csv: string): Promise<void> {
  await call(`/api/portions-served/csv?${q({ hallId: hallId(), serviceId: service.serviceId })}`, {
    method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv,
  })
}

export async function getPortionBenchmark(serviceId: string): Promise<PortionBenchmark> {
  return call(`/api/portions-served/benchmark?${q({ hallId: hallId(), serviceId })}`)
}

interface PeriodResponse {
  start: IsoDate
  end: IsoDate
  pixelsWasted: number
  previousPixelsWasted: number | null
  averagePlateWastePercent: number | null
  platesCounted: number
}

export async function getSummaryCards(hallIds: string[] = [hallId()]): Promise<SummaryCards> {
  // The cards endpoint is per hall, so several halls are fetched and combined.
  const perHall = await Promise.all(hallIds.map((id) => summaryForHall(id)))
  const combine = (key: keyof SummaryCards): PeriodSummary => perHall.map((c) => c[key]).reduce(addPeriods)
  return { today: combine('today'), thisWeek: combine('thisWeek'), thisMonth: combine('thisMonth') }
}

async function summaryForHall(id: string): Promise<SummaryCards> {
  const body = await call<Record<'today' | 'thisWeek' | 'thisMonth', PeriodResponse>>(
    `/api/dashboard/cards?${q({ hallId: id, today: todayIso() })}`,
  )
  const period = (p: PeriodResponse): PeriodSummary => ({
    start: p.start,
    end: p.end,
    pixelsWasted: p.pixelsWasted,
    previousPixelsWasted: p.previousPixelsWasted,
    averagePlateWastePercent: p.averagePlateWastePercent ?? null,
    platesCounted: p.platesCounted ?? 0,
  })
  return { today: period(body.today), thisWeek: period(body.thisWeek), thisMonth: period(body.thisMonth) }
}

/** Totals add up; the per-plate percent is averaged over every hall's plates. */
function addPeriods(a: PeriodSummary, b: PeriodSummary): PeriodSummary {
  const plates = a.platesCounted + b.platesCounted
  const leftSum = (p: PeriodSummary) => (p.averagePlateWastePercent ?? 0) * p.platesCounted
  return {
    start: a.start,
    end: a.end,
    pixelsWasted: a.pixelsWasted + b.pixelsWasted,
    previousPixelsWasted: addNullable(a.previousPixelsWasted, b.previousPixelsWasted),
    averagePlateWastePercent: plates > 0 ? (leftSum(a) + leftSum(b)) / plates : null,
    platesCounted: plates,
  }
}

// ---------------------------------------------------------------------------
// Behind the scenes: scanned plates, their labels, and photo links
// ---------------------------------------------------------------------------

interface PlatesResponse {
  plates: (Omit<PlateRecord, 'foods'> & {
    foods: { itemId: string | null; name: string; leftoverPx: number; percentOfServing: number | null; flags: string[] }[]
  })[]
}

export async function getPlates(date: IsoDate, meal: MealLabel): Promise<PlateRecord[]> {
  const body = await call<PlatesResponse>(`/api/dashboard/plates?${q({ hallId: hallId(), date, meal })}`)
  return body.plates.map((p) => ({
    ...p,
    foods: p.foods.map((f) => ({
      itemId: f.itemId,
      name: f.name,
      pixelsWasted: f.leftoverPx,
      percentOfServing: f.percentOfServing,
      flags: f.flags,
    })),
  }))
}

/** Short-lived link to a plate photo; ask again when it expires. */
export async function getImageUrl(objectId: string): Promise<string> {
  const body = await call<{ url: string }>(`/api/images/${encodeURIComponent(objectId)}/access`)
  return body.url
}

// ---------------------------------------------------------------------------
// Waste impact dashboard (BIG-PLAN D1-D8, contracts/types.ts waste-impact section)
// ---------------------------------------------------------------------------

export async function getImpactDashboard(start: IsoDate, end: IsoDate, hallIds: string[] = [hallId()]): Promise<ImpactDashboard> {
  return call<ImpactDashboard>(`/api/dashboard/impact?${q({ ...hallParam(hallIds), start, end })}`)
}

/** Accepts a bare array or `{ captures: [...] }`. */
export async function getCaptures(start: IsoDate, end: IsoDate, hallIds: string[] = [hallId()]): Promise<CaptureListItem[]> {
  const body = await call<CaptureListItem[] | { captures: CaptureListItem[] }>(
    `/api/captures?${q({ ...hallParam(hallIds), start, end })}`,
  )
  return Array.isArray(body) ? body : body.captures ?? []
}

/** Short-lived read links for a plate's photo, AI outline image and masks. Ask again when they expire. */
export async function getCaptureImages(eventId: string): Promise<CaptureImages> {
  return call<CaptureImages>(`/api/captures/${encodeURIComponent(eventId)}/images`)
}

export async function getRecommendation(start: IsoDate, end: IsoDate, hallIds: string[] = [hallId()]): Promise<Recommendation> {
  return call<Recommendation>(`/api/recommendation?${q({ ...hallParam(hallIds), start, end })}`)
}
