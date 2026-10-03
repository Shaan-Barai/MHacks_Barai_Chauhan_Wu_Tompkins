/**
 * Data-access layer. Components only talk to this module.
 *
 * Today every function answers from src/data/mockData.ts (plus the manager's
 * own menus kept in localStorage). To swap in the real backend, replace the
 * bodies with fetch() calls to Agent 5's GET endpoints (backend/README.md) —
 * the shapes in src/data/types.ts already mirror them:
 *   getMenu           → GET /api/menus?hallId=…&date=…
 *   saveUserMenu      → POST /api/menus
 *   getDailyWaste     → GET /api/dashboard/summary per service, summed per day
 *   getMealDetail     → GET /api/dashboard/summary + /api/attendance + /api/suggestions
 *   getSummaryCards   → derived from the same summary endpoint
 */
import { addDays, eachDay, startOfMonth, startOfWeek, todayIso } from '../lib/dates'
import { MOCK_FUTURE_MENU_DAYS, mockMealDetail, mockMenuFor } from './mockData'
import type {
  DailyWastePoint,
  DayMenu,
  IsoDate,
  MealDetail,
  MealLabel,
  MenuItemLite,
  PeriodSummary,
  SummaryCards,
} from './types'
import { MEALS } from './types'

/** Artificial latency so loading states are visible; tests set it to 0. */
let latencyMs = 250
export function setApiLatency(ms: number): void {
  latencyMs = ms
}
function wait(): Promise<void> {
  return latencyMs > 0 ? new Promise((r) => setTimeout(r, latencyMs)) : Promise.resolve()
}

// ---------------------------------------------------------------------------
// Manager-uploaded menus (localStorage overlay; backend POST /api/menus later)
// ---------------------------------------------------------------------------

const USER_MENUS_KEY = 'scrap.userMenus.v1'

function readUserMenus(): Record<IsoDate, DayMenu> {
  try {
    const raw = localStorage.getItem(USER_MENUS_KEY)
    return raw ? (JSON.parse(raw) as Record<IsoDate, DayMenu>) : {}
  } catch {
    return {}
  }
}

function writeUserMenus(menus: Record<IsoDate, DayMenu>): void {
  localStorage.setItem(USER_MENUS_KEY, JSON.stringify(menus))
}

function menuFor(date: IsoDate, today: IsoDate): DayMenu | null {
  const user = readUserMenus()[date]
  if (user) return user
  return mockMenuFor(date, today)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Menu in effect on a date (manager-uploaded wins over demo data). */
export async function getMenu(date: IsoDate): Promise<DayMenu | null> {
  await wait()
  return menuFor(date, todayIso())
}

/** Which days in [start, end] have a menu — feeds the Menus calendar. */
export async function getMenuDays(start: IsoDate, end: IsoDate): Promise<Record<IsoDate, boolean>> {
  await wait()
  const today = todayIso()
  const out: Record<IsoDate, boolean> = {}
  for (const d of eachDay(start, end)) out[d] = menuFor(d, today) !== null
  return out
}

/** Save (or replace) the manager's menu for one day. */
export async function saveUserMenu(date: IsoDate, meals: Record<MealLabel, MenuItemLite[]>): Promise<DayMenu> {
  await wait()
  const menu: DayMenu = { date, menuId: `menu_user_${date}`, source: 'user', meals }
  const all = readUserMenus()
  all[date] = menu
  writeUserMenus(all)
  return menu
}

/** Mock "Test connection" for the menu-API option (no real network call). */
export async function testMenuConnection(url: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
  await wait()
  if (!url.trim() || !apiKey.trim()) {
    return { ok: false, message: 'Enter both the API URL and the key, then try again.' }
  }
  return { ok: true, message: 'Connection looks good! (Demo: no data was really fetched.)' }
}

/** Daily waste series for the chart; null wasteUnits = no data that day. */
export async function getDailyWaste(start: IsoDate, end: IsoDate): Promise<DailyWastePoint[]> {
  await wait()
  const today = todayIso()
  return eachDay(start, end).map((date) => ({ date, wasteUnits: dailyTotal(date, today) }))
}

function dailyTotal(date: IsoDate, today: IsoDate): number | null {
  if (date > today) return null
  const menu = menuFor(date, today)
  if (!menu) return null
  let sum = 0
  for (const meal of MEALS) {
    const d = mockMealDetail(date, meal, menu, today)
    if (d) sum += d.totalWasteUnits
  }
  return sum
}

/** Right-panel detail for one meal service; null = no menu / no data. */
export async function getMealDetail(date: IsoDate, meal: MealLabel): Promise<MealDetail | null> {
  await wait()
  const today = todayIso()
  return mockMealDetail(date, meal, menuFor(date, today), today)
}

/** The three summary cards. Each compares to the same-length window before it. */
export async function getSummaryCards(): Promise<SummaryCards> {
  await wait()
  const today = todayIso()
  return {
    today: period(today, today, today),
    thisWeek: period(startOfWeek(today), today, today),
    thisMonth: period(startOfMonth(today), today, today),
  }
}

function period(start: IsoDate, end: IsoDate, today: IsoDate): PeriodSummary {
  const days = eachDay(start, end)
  const prevEnd = addDays(start, -1)
  const prevStart = addDays(prevEnd, -(days.length - 1))
  const sum = (ds: IsoDate[]) => {
    let total = 0
    let any = false
    for (const d of ds) {
      const v = dailyTotal(d, today)
      if (v !== null) {
        total += v
        any = true
      }
    }
    return any ? total : null
  }
  return {
    start,
    end,
    wasteUnits: sum(days) ?? 0,
    previousWasteUnits: sum(eachDay(prevStart, prevEnd)),
  }
}

/** Latest selectable menu date (mock menus run a few days ahead). */
export function latestMenuDate(): IsoDate {
  return addDays(todayIso(), MOCK_FUTURE_MENU_DAYS)
}
