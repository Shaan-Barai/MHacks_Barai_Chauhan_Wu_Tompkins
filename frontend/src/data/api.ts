/**
 * Data-access layer for the dashboard. Every screen goes through these async
 * functions, which today read from ./mockData.ts. When Agent 5's API (or
 * approved SpacetimeDB subscriptions) land, swap the bodies here; the screens
 * and their loading/error states stay the same.
 *
 * The summing below stands in for Agent 6's canonical analytics payloads; it
 * only adds up per-service totals that analytics already computed.
 */
import type {
  ApiError,
  DateRange,
  DayMenu,
  Grouping,
  HallSettings,
  IsoDate,
  MealLabel,
  MenuApiConnection,
  Result,
  ServiceDetail,
  SummaryCards,
  TrendPoint,
} from './types'
import { MEALS } from './types'
import { MOCK_HALL, MOCK_MENU_API_RULE, buildMockMenus, buildMockService } from './mockData'
import {
  addDays,
  daysBetween,
  eachDay,
  formatMonth,
  formatShort,
  shiftMonths,
  startOfMonth,
  startOfWeek,
  todayIso,
} from '../lib/dates'

const KEYS = {
  setupDone: 'scrap.setupDone',
  settings: 'scrap.settings',
  menus: 'scrap.menus',
  menuApi: 'scrap.menuApi',
}

const LATENCY_MS = import.meta.env.MODE === 'test' ? 0 : 250

/** `?demo=error` simulates a backend outage so error states can be checked. */
function simulatedOutage(): ApiError | null {
  if (typeof window === 'undefined') return null
  if (new URLSearchParams(window.location.search).get('demo') !== 'error') return null
  return {
    code: 'BACKEND_UNAVAILABLE',
    message: "We couldn't reach the Scrap server. Your data is safe — try again in a minute.",
    retryable: true,
  }
}

async function respond<T>(fn: () => T): Promise<Result<T>> {
  await new Promise((r) => setTimeout(r, LATENCY_MS))
  const outage = simulatedOutage()
  if (outage) return { ok: false, error: outage }
  try {
    return { ok: true, data: fn() }
  } catch (e) {
    return {
      ok: false,
      error: { code: 'UNEXPECTED_ERROR', message: 'Something went wrong loading this. Please try again.', retryable: true, details: { cause: String(e) } },
    }
  }
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value))
}

// ---------------------------------------------------------------- menus ---

let generatedMenus: { today: IsoDate; menus: Record<IsoDate, DayMenu> } | null = null

function allMenus(): Record<IsoDate, DayMenu> {
  const today = todayIso()
  if (generatedMenus?.today !== today) generatedMenus = { today, menus: buildMockMenus(today) }
  return { ...generatedMenus.menus, ...load<Record<IsoDate, DayMenu>>(KEYS.menus, {}) }
}

export function getMenus(): Promise<Result<Record<IsoDate, DayMenu>>> {
  return respond(allMenus)
}

/** Save (add or replace) menus for one or more days. */
export function saveMenus(days: Record<IsoDate, DayMenu>): Promise<Result<{ savedDays: number }>> {
  return respond(() => {
    const userMenus = load<Record<IsoDate, DayMenu>>(KEYS.menus, {})
    save(KEYS.menus, { ...userMenus, ...days })
    serviceCache.clear()
    return { savedDays: Object.keys(days).length }
  })
}

/**
 * Mock "Test connection". The key is only passed through for the request and
 * is never stored in the browser; the real check belongs on the backend.
 */
export async function testMenuApi(url: string, key: string): Promise<Result<{ message: string }>> {
  const res = await respond(() => ({ message: 'Connected! We found menus for the next 7 days.' }))
  if (res.ok && (!MOCK_MENU_API_RULE.test(url.trim()) || !key.trim())) {
    return {
      ok: false,
      error: { code: 'MENU_API_INVALID', message: 'Check the API address (it should start with https://) and the key.', retryable: false },
    }
  }
  return res
}

export function connectMenuApi(url: string): Promise<Result<MenuApiConnection>> {
  return respond(() => {
    const conn = { url: url.trim(), connectedAt: new Date().toISOString() }
    save(KEYS.menuApi, conn)
    return conn
  })
}

export function getMenuApiConnection(): MenuApiConnection | null {
  return load<MenuApiConnection | null>(KEYS.menuApi, null)
}

/**
 * Provisional menu CSV format (open question in contracts/decisions.md):
 * `date,meal,item` with a header row, e.g. `2026-10-03,lunch,Tomato Soup`.
 */
export function parseMenuCsv(text: string): { days: Record<IsoDate, DayMenu>; errors: string[] } {
  const days: Record<IsoDate, DayMenu> = {}
  const errors: string[] = []
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  lines.forEach((line, i) => {
    const [date, meal, ...rest] = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    const item = rest.join(',').trim()
    if (i === 0 && date?.toLowerCase() === 'date') return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return void errors.push(`Line ${i + 1}: date should look like 2026-10-03.`)
    const m = meal?.toLowerCase() as MealLabel
    if (!MEALS.includes(m)) return void errors.push(`Line ${i + 1}: meal should be breakfast, lunch, or dinner.`)
    if (!item) return void errors.push(`Line ${i + 1}: item name is missing.`)
    days[date] ??= { breakfast: [], lunch: [], dinner: [] }
    if (!days[date][m].includes(item)) days[date][m].push(item)
  })
  return { days, errors }
}

// ------------------------------------------------------------- settings ---

export function isSetupDone(): boolean {
  return load(KEYS.setupDone, false)
}

export function markSetupDone() {
  save(KEYS.setupDone, true)
}

export function getSettings(): Promise<Result<HallSettings>> {
  return respond(() => load(KEYS.settings, MOCK_HALL))
}

export function saveSettings(settings: HallSettings): Promise<Result<HallSettings>> {
  return respond(() => {
    save(KEYS.settings, settings)
    return settings
  })
}

// ------------------------------------------------------------- analytics ---

const serviceCache = new Map<string, ServiceDetail>()

function service(date: IsoDate, meal: MealLabel): ServiceDetail {
  const key = `${date}:${meal}`
  let s = serviceCache.get(key)
  if (!s) {
    s = buildMockService(date, meal, allMenus()[date]?.[meal], todayIso())
    serviceCache.set(key, s)
  }
  return s
}

function dayStats(date: IsoDate) {
  let wasteUnits = 0
  let platesScanned = 0
  let hasData = false
  for (const meal of MEALS) {
    const s = service(date, meal)
    if (s.status !== 'ok') continue
    hasData = true
    wasteUnits += s.wasteUnits
    platesScanned += s.platesScanned
  }
  return { wasteUnits, platesScanned, hasData }
}

function rangeWaste(start: IsoDate, end: IsoDate): number | null {
  let total = 0
  let hasData = false
  for (const d of eachDay(start, end)) {
    const s = dayStats(d)
    hasData ||= s.hasData
    total += s.wasteUnits
  }
  return hasData ? total : null
}

export function getServiceDetail(date: IsoDate, meal: MealLabel): Promise<Result<ServiceDetail>> {
  return respond(() => service(date, meal))
}

/**
 * Today / this week (Mon–today) / this month (1st–today), each compared with
 * the same number of days in the previous period.
 */
export function getSummaryCards(): Promise<Result<SummaryCards>> {
  return respond(() => {
    const today = todayIso()
    const week = startOfWeek(today)
    const month = startOfMonth(today)
    const prevMonthStart = shiftMonths(month, -1)
    return {
      today: { wasteUnits: rangeWaste(today, today) ?? 0, previousWasteUnits: rangeWaste(addDays(today, -1), addDays(today, -1)) },
      week: { wasteUnits: rangeWaste(week, today) ?? 0, previousWasteUnits: rangeWaste(addDays(week, -7), addDays(today, -7)) },
      month: {
        wasteUnits: rangeWaste(month, today) ?? 0,
        previousWasteUnits: rangeWaste(prevMonthStart, addDays(prevMonthStart, daysBetween(month, today))),
      },
    }
  })
}

export function getTrend(range: DateRange, grouping: Grouping): Promise<Result<TrendPoint[]>> {
  return respond(() => {
    const buckets = new Map<IsoDate, TrendPoint>()
    for (const d of eachDay(range.start, range.end)) {
      const start = grouping === 'daily' ? d : grouping === 'weekly' ? startOfWeek(d) : startOfMonth(d)
      const label =
        grouping === 'daily' ? formatShort(d) : grouping === 'weekly' ? `Week of ${formatShort(start)}` : formatMonth(start)
      const b = buckets.get(start) ?? { bucketStart: start, label, wasteUnits: null, platesScanned: 0 }
      const s = dayStats(d)
      if (s.hasData) {
        b.wasteUnits = (b.wasteUnits ?? 0) + s.wasteUnits
        b.platesScanned += s.platesScanned
      }
      buckets.set(start, b)
    }
    return [...buckets.values()]
  })
}

/** CSV of per-item waste for every analyzed service in the range. */
export function exportCsv(range: DateRange): Promise<Result<string>> {
  return respond(() => {
    const rows = [
      'date,meal,item,waste_units_estimated_px,share_of_meal_percent,plates_scanned,plates_excluded,attendance_simulated',
    ]
    for (const d of eachDay(range.start, range.end)) {
      for (const meal of MEALS) {
        const s = service(d, meal)
        if (s.status !== 'ok') continue
        for (const it of s.items) {
          const name = `"${it.displayName.replace(/"/g, '""')}"`
          rows.push(
            [d, meal, name, it.wasteUnits, it.sharePercent.toFixed(1), s.platesScanned, s.platesExcluded, s.attendance?.count ?? ''].join(','),
          )
        }
      }
    }
    return rows.join('\n') + '\n'
  })
}

/** Test-only: forget cached mock computations. */
export function __resetCache() {
  serviceCache.clear()
  generatedMenus = null
}
