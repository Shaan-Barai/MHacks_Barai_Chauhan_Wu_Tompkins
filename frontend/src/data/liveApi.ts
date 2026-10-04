/**
 * Live data access against Agent 5's backend (backend/README.md). Same
 * function signatures as mockApi.ts; api.ts picks one.
 *
 * Everything is Pixels wasted (contracts/measurement.md): integer counts of
 * foreground pixels in validated leftover-food masks, shown as-is (no
 * "waste units" scaling). Totals, shares, and exclusions are computed
 * server-side by analytics/; components never redo canonical math.
 */
import { loadSettings } from '../state/settings'
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
const HALL_TIMEZONE = 'America/Detroit'

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')

function hallId(): string {
  return loadSettings()?.hallId ?? 'hall-main'
}

/**
 * Which hall a request is about: a hallId, `undefined` for the first hall in
 * Settings, or `null` for every hall together (the dashboard's "All").
 */
export type HallScope = string | null | undefined

function hallParam(hall: HallScope): Record<string, string> {
  if (hall === null) return {}
  return { hallId: hall ?? hallId() }
}

/** Where a hall's own system can send menus (shown on the Menu Schedule page). */
export function menuApiBase(): string {
  return API_BASE || window.location.origin
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

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

interface MenuBundle {
  service: { serviceId: string; menuId: string; menuVersion: number; serviceDate: string; mealLabel: MealLabel }
  items: { itemId: string; displayName: string }[]
}

export async function getMenu(date: IsoDate, hall?: string): Promise<DayMenu | null> {
  const body = await orNull(call<{ menus: MenuBundle[] }>(`/api/menus?${q({ hallId: hall ?? hallId(), date })}`))
  if (!body || body.menus.length === 0) return null
  const meals: Record<MealLabel, MenuItemLite[]> = { breakfast: [], lunch: [], dinner: [] }
  for (const m of body.menus) {
    meals[m.service.mealLabel] = m.items.map((i) => ({ itemId: i.itemId, displayName: i.displayName }))
  }
  return { date, menuId: body.menus[0].service.menuId, source: 'user', meals }
}

export async function getMenuDays(start: IsoDate, end: IsoDate, hall?: string): Promise<Record<IsoDate, boolean>> {
  const { dates } = await call<{ dates: IsoDate[] }>(`/api/menus/days?${q({ hallId: hall ?? hallId(), start, end })}`)
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
export async function saveUserMenu(date: IsoDate, meals: Record<MealLabel, MenuItemLite[]>, hall?: string): Promise<DayMenu> {
  await saveUserMenuDays([date], meals, hall)
  return (await getMenu(date, hall)) ?? { date, menuId: '', source: 'user', meals }
}

/** The same meals on several dates (a repeating menu), in one upload. */
export async function saveUserMenuDays(dates: IsoDate[], meals: Record<MealLabel, MenuItemLite[]>, hall?: string): Promise<void> {
  const days = dates.map((date) => {
    const day: Record<string, unknown> = { date }
    for (const meal of MEALS) if (meals[meal].length > 0) day[meal] = meals[meal].map((i) => i.displayName)
    return day
  })
  await call('/api/menus/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hallId: hall ?? hallId(), hallTimezone: HALL_TIMEZONE, days }),
  })
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function getDailyWaste(start: IsoDate, end: IsoDate, hall?: HallScope): Promise<DailyWastePoint[]> {
  const { days } = await call<{ days: { date: IsoDate; pixelsWasted: number | null }[] }>(
    `/api/dashboard/daily?${q({ ...hallParam(hall), start, end })}`,
  )
  // The chart is pixels only (BIG-PLAN v2); any other per-day fields are ignored.
  return days.map((d) => ({ date: d.date, pixelsWasted: d.pixelsWasted }))
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
export async function getMealDetail(date: IsoDate, meal: MealLabel, hall?: string): Promise<MealDetail | null> {
  const body = await orNull(call<MealResponse>(`/api/dashboard/meal?${q({ hallId: hall ?? hallId(), date, meal })}`))
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

export async function getSummaryCards(): Promise<SummaryCards> {
  const body = await call<Record<'today' | 'thisWeek' | 'thisMonth', PeriodResponse>>(
    `/api/dashboard/cards?${q({ hallId: hallId(), today: todayIso() })}`,
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
// Waste impact dashboard (BIG-PLAN v2, contracts/types.ts waste-impact section)
// ---------------------------------------------------------------------------

export async function getImpactDashboard(start: IsoDate, end: IsoDate, hall?: HallScope): Promise<ImpactDashboard> {
  return call<ImpactDashboard>(`/api/dashboard/impact?${q({ ...hallParam(hall), start, end })}`)
}

/** Accepts a bare array or `{ captures: [...] }`. */
export async function getCaptures(start: IsoDate, end: IsoDate, hall?: HallScope): Promise<CaptureListItem[]> {
  const body = await call<CaptureListItem[] | { captures: CaptureListItem[] }>(
    `/api/captures?${q({ ...hallParam(hall), start, end })}`,
  )
  return Array.isArray(body) ? body : body.captures ?? []
}

/** Short-lived read links for a plate's photo, AI outline image and masks. Ask again when they expire. */
export async function getCaptureImages(eventId: string): Promise<CaptureImages> {
  return call<CaptureImages>(`/api/captures/${encodeURIComponent(eventId)}/images`)
}

export async function getRecommendation(start: IsoDate, end: IsoDate, hall?: HallScope): Promise<Recommendation> {
  return call<Recommendation>(`/api/recommendation?${q({ ...hallParam(hall), start, end })}`)
}
