/**
 * Mock data access (VITE_USE_MOCK=1 and unit tests); see api.ts.
 *
 * Every function answers from src/data/mockData.ts (plus the manager's own
 * menus kept in localStorage), with the same signatures as liveApi.ts.
 */
import { addDays, eachDay, startOfMonth, startOfWeek, todayIso } from '../lib/dates'
import { AuthRequiredError, notifyAuthRequired } from './authEvents'
import {
  MOCK_ACTIVE_CALIBRATION_ID,
  MOCK_CARD_PIXELS,
  MOCK_FUTURE_MENU_DAYS,
  MOCK_HALL_ID,
  mockCalibration,
  mockCalibrationHistory,
  mockCalibrationImages,
  mockCaptureImages,
  mockCaptures,
  mockImpactDashboard,
  mockMealDetail,
  mockMenuFor,
  mockRecommendation,
  rng,
} from './mockData'
import type {
  AuthSession,
  CalibrationImages,
  CameraCalibration,
  MeasurementSettings,
  NewCalibration,

  CameraStatus,
  TakePhotoResult,
  DemoStatus,
  WasteTotal,
  WasteTotals,
  CaptureImages,
  AdminCaptureItem,
  CaptureListItem,
  ImpactDashboard,
  Recommendation,
  DailyImpactPoint,
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
  TryImageJob,
  TryImageStatus,
  TryImageSubmitted,
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

/** Which days in [start, end] have a menu, feeds the Menus calendar. */
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
  const counts = storedPortions()
  for (const meal of MEALS) delete counts[`mock|${date}|${meal}`]
  localStorage.setItem(PORTIONS_KEY, JSON.stringify(counts))
  return menu
}

/** Daily waste series for the chart; null pixelsWasted = no data that day. */
export async function getDailyWaste(start: IsoDate, end: IsoDate): Promise<DailyWastePoint[]> {
  await wait()
  const today = todayIso()
  return eachDay(start, end).map((date) => ({ date, pixelsWasted: dailyTotal(date, today) }))
}

function dailyTotal(date: IsoDate, today: IsoDate): number | null {
  if (date > today) return null
  const menu = menuFor(date, today)
  if (!menu) return null
  let sum = 0
  for (const meal of MEALS) {
    const d = mockMealDetail(date, meal, menu, today)
    if (d) sum += d.pixelsWasted
  }
  return sum
}

/** Right-panel detail for one meal service; null = no menu / no data. */
export async function getMealDetail(date: IsoDate, meal: MealLabel): Promise<MealDetail | null> {
  await wait()
  const today = todayIso()
  const detail = mockMealDetail(date, meal, menuFor(date, today), today)
  if (!detail) return null
  const service = await getPortionService(date, meal)
  if (!service) return detail
  return { ...detail, portionBenchmark: await getPortionBenchmark(service.serviceId),
    tip: { source: 'fallback_rules', recommendation: 'Demo area estimates cannot establish pixels wasted per portion. Save portions served and connect validated mask counts before acting on this benchmark.' } }
}

const PORTIONS_KEY = 'scrap.portions.demo.v1'
function storedPortions(): Record<string, PortionService['portions']> {
  try { return JSON.parse(localStorage.getItem(PORTIONS_KEY) ?? '{}') } catch { return {} }
}

export async function getPortionService(date: IsoDate, meal: MealLabel): Promise<PortionService | null> {
  await wait()
  const menu = menuFor(date, todayIso())
  if (!menu || menu.meals[meal].length === 0) return null
  const serviceId = `mock|${date}|${meal}`
  const items = menu.meals[meal]
  const portions = (storedPortions()[serviceId] ?? []).filter(p => items.some(i => i.itemId === p.itemId))
  return { serviceId, menuVersion: 1, items, portions }
}

export async function savePortions(service: PortionService, entries: PortionEntry[]): Promise<void> {
  await wait()
  const seen = new Set<string>()
  for (const e of entries) {
    if (!service.items.some(i => i.itemId === e.itemId) || seen.has(e.itemId)) throw new Error('Unknown or duplicate menu item.')
    if (e.count !== null && (!Number.isInteger(e.count) || e.count < 0 || e.count > 4_294_967_295)) throw new Error('Use a nonnegative whole number for portions served.')
    seen.add(e.itemId)
  }
  const all = storedPortions()
  all[service.serviceId] = entries.filter((e): e is { itemId: string; count: number } => e.count !== null)
    .map(e => ({ ...e, source: 'demo' as const }))
  localStorage.setItem(PORTIONS_KEY, JSON.stringify(all))
}

export async function importPortionsCsv(service: PortionService, csv: string): Promise<void> {
  // Offline demo imports the generated, unquoted template. Live CSV parsing is server-side.
  const rows = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(row => row.split(','))
  const header = rows.shift()?.map(c => c.trim()) ?? []
  if (header.join(',') !== 'service_id,menu_version,item_id,portions_served') throw new Error('Use the downloaded portions template.')
  const entries = rows.map(row => {
    const [serviceId, version, itemId, count] = row.map(c => c.trim())
    if (row.length !== 4 || serviceId !== service.serviceId || version !== String(service.menuVersion)) throw new Error('The CSV service or menu version differs.')
    if (count !== '' && !/^\d+$/.test(count)) throw new Error('Use nonnegative whole-number counts.')
    return { itemId, count: count === '' ? null : Number(count) }
  })
  await savePortions(service, entries)
}

export async function getPortionBenchmark(serviceId: string): Promise<PortionBenchmark> {
  const [, date, meal] = serviceId.split('|')
  const service = await getPortionService(date, meal as MealLabel)
  if (!service) throw new Error('No menu for this meal.')
  return {
    hallId: 'demo', serviceId, serviceDate: date, menuVersion: service.menuVersion,
    items: service.items.map(i => ({ ...i, portionsServed: service.portions.find(p => p.itemId === i.itemId)?.count ?? null,
      portionsSource: service.portions.some(p => p.itemId === i.itemId) ? 'demo' : null,
      pixelsWasted: null, pixelsWastedPerPortion: null, measuredCaptures: 0,
      unavailableReason: 'Demo area estimates are not validated mask counts.' })),
    capturedDishes: 0, measuredDishes: 0, excludedMeasurements: 0,
    label: 'Pixels wasted per portion', unit: 'pixels/portion',
    coverageNote: 'Demo data. Validated masks are not connected; no per-portion values are available.',
  }
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
  // Demo plate percent: a steady 15 to 40% per day, averaged over days with data.
  const percents = days.filter((d) => dailyTotal(d, today) !== null).map((d) => 15 + rng(`plate:${d}`)() * 25)
  return {
    start,
    end,
    pixelsWasted: sum(days) ?? 0,
    previousPixelsWasted: sum(eachDay(prevStart, prevEnd)),
    averagePlateWastePercent: percents.length ? Math.round((percents.reduce((a, b) => a + b, 0) / percents.length) * 10) / 10 : null,
    platesCounted: percents.length,
  }
}

/** Latest selectable menu date (mock menus run a few days ahead). */
export function latestMenuDate(): IsoDate {
  return addDays(todayIso(), MOCK_FUTURE_MENU_DAYS)
}

/** Demo mode has no photos: Behind the scenes shows its empty state. */
export async function getPlates(_date: IsoDate, _meal: MealLabel): Promise<PlateRecord[]> {
  await wait()
  return []
}

export async function getImageUrl(_objectId: string): Promise<string> {
  throw new Error('Demo mode has no photos.')
}

// ---------------------------------------------------------------------------
// Waste impact dashboard (BIG-PLAN D1-D8)
// ---------------------------------------------------------------------------

export async function getImpactDashboard(start: IsoDate, end: IsoDate): Promise<ImpactDashboard> {
  await wait()
  return mockImpactDashboard(start, end, todayIso())
}

export async function getDailyImpact(start: IsoDate, end: IsoDate): Promise<DailyImpactPoint[]> {
  await wait()
  const today = todayIso()
  return eachDay(start, end).map((date) => {
    const t = mockImpactDashboard(date, date, today).totals
    return {
      date,
      pixels: t.analyzedCaptures > 0 ? t.pixels : null,
      kgCo2e: t.kgCo2e ?? null,
      co2Points: t.co2Points,
      analyzedCaptures: t.analyzedCaptures,
      calibratedCaptures: t.physicalCoverage?.calibratedCaptures ?? 0,
    }
  })
}

export async function getCaptures(start: IsoDate, end: IsoDate): Promise<CaptureListItem[]> {
  await wait()
  const hidden = mockHidden()
  return mockCaptures(start, end, todayIso()).filter((c) => !hidden.has(c.eventId))
}

// Admin curation, demo only: hidden plate ids live in this browser.
const HIDDEN_KEY = 'scrap.mock.hiddenCaptures.v1'

function mockHidden(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export async function getAdminCaptures(start: IsoDate, end: IsoDate): Promise<AdminCaptureItem[]> {
  await wait()
  const hidden = mockHidden()
  return mockCaptures(start, end, todayIso()).map((c) => ({ ...c, hidden: hidden.has(c.eventId) }))
}

export async function setCaptureVisibility(eventIds: string[], hidden: boolean): Promise<void> {
  await wait()
  requireSession()
  const set = mockHidden()
  for (const id of eventIds) {
    if (hidden) set.add(id)
    else set.delete(id)
  }
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set]))
  } catch {
    // private mode: the change lasts for this page only
  }
}

export async function getCaptureImages(eventId: string): Promise<CaptureImages> {
  await wait()
  const images = mockCaptureImages(eventId, todayIso(), new Date())
  if (!images) throw new Error('This plate is no longer available.')
  return images
}

// Try an Image (demo fixture: tiny placeholder pictures, not a real analysis).
const PLACEHOLDER_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const tryPolls = new Map<string, number>()

export async function getTryImageStatus(): Promise<TryImageStatus> {
  await wait()
  return { available: true, waiting: 0, running: false, maxWaiting: 3, hourlyRemaining: 20 }
}

export async function getTryImageSample(): Promise<Blob> {
  await wait()
  return new Blob(['demo'], { type: 'image/jpeg' })
}

export async function submitTryImage(_blob: Blob): Promise<TryImageSubmitted> {
  await wait()
  const id = `try_demo_${tryPolls.size + 1}`
  tryPolls.set(id, 0)
  return { id, status: 'queued', position: 1 }
}

export async function getTryImageJob(id: string): Promise<TryImageJob> {
  await wait()
  const n = (tryPolls.get(id) ?? 0) + 1
  tryPolls.set(id, n)
  if (n < 2) return { id, status: 'running' }
  return {
    id,
    status: 'done',
    summary: {
      countStatus: 'complete',
      capturePixelsWasted: 42_000,
      foods: [
        { itemId: 'item_halal-rice', food: 'Halal Rice (demo)', pixelsWasted: 30_000 },
        { itemId: 'item_halal-chicken', food: 'Halal Chicken (demo)', pixelsWasted: 12_000 },
      ],
    },
    images: { original: PLACEHOLDER_PNG, boxes: PLACEHOLDER_PNG, masks: PLACEHOLDER_PNG, final: PLACEHOLDER_PNG },
  }
}

export async function getRecommendation(start: IsoDate, end: IsoDate): Promise<Recommendation> {
  await wait()
  return mockRecommendation(mockImpactDashboard(start, end, todayIso()), new Date())
}

// ---------------------------------------------------------------------------
// Staff sign-in (IT_4 I11), demo only: the passcode is MOCK_PASSCODE and the
// "session" lives in this browser. Real sessions are httpOnly cookies set by
// the backend.
// ---------------------------------------------------------------------------

export const MOCK_PASSCODE = 'scrapsaver'
const SESSION_KEY = 'scrap.mock.session.v1'

function mockSignedIn(): boolean {
  try {
    return localStorage.getItem(SESSION_KEY) === '1'
  } catch {
    return false
  }
}

/** Demo mutations behave like the backend: no session, no change (401). */
function requireSession(): void {
  if (!mockSignedIn()) {
    notifyAuthRequired()
    throw new AuthRequiredError()
  }
}

export async function getSession(): Promise<AuthSession> {
  await wait()
  return { signedIn: mockSignedIn(), authAvailable: true }
}

export async function login(passcode: string): Promise<AuthSession> {
  await wait()
  if (passcode !== MOCK_PASSCODE) throw new Error("That passcode didn't work.")
  localStorage.setItem(SESSION_KEY, '1')
  return { signedIn: true, authAvailable: true }
}

export async function logout(): Promise<void> {
  await wait()
  localStorage.removeItem(SESSION_KEY)
}

// ---------------------------------------------------------------------------
// Camera calibration + measurement settings (IT_4), kept in this browser.
// ---------------------------------------------------------------------------

const CALIBRATION_KEY = 'scrap.mock.calibration.v2'

interface CalibrationStore {
  settings: MeasurementSettings
  calibrations: CameraCalibration[]
}

function readCalibrationStore(): CalibrationStore {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY)
    if (raw) return JSON.parse(raw) as CalibrationStore
  } catch {
    // fall through to the seed
  }
  const today = todayIso()
  return {
    settings: {
      hallId: MOCK_HALL_ID,
      activeCalibrationId: MOCK_ACTIVE_CALIBRATION_ID,
      updatedAt: new Date(`${addDays(today, -20)}T13:00:00Z`).toISOString(),
    },
    calibrations: mockCalibrationHistory(today),
  }
}

function writeCalibrationStore(store: CalibrationStore): void {
  localStorage.setItem(CALIBRATION_KEY, JSON.stringify(store))
}

export async function getMeasurementSettings(): Promise<MeasurementSettings> {
  await wait()
  return readCalibrationStore().settings
}

export async function saveMeasurementSettings(
  next: Pick<MeasurementSettings, 'activeCalibrationId'>,
): Promise<MeasurementSettings> {
  await wait()
  requireSession()
  const store = readCalibrationStore()
  if (next.activeCalibrationId !== null) {
    const cal = store.calibrations.find((c) => c.calibrationId === next.activeCalibrationId)
    if (!cal || cal.status !== 'succeeded') throw new Error('Only a finished calibration can be used.')
  }
  store.settings = { hallId: store.settings.hallId, activeCalibrationId: next.activeCalibrationId, updatedAt: new Date().toISOString() }
  writeCalibrationStore(store)
  return store.settings
}

export async function getCalibrations(): Promise<CameraCalibration[]> {
  await wait()
  return readCalibrationStore().calibrations
}

export async function getCalibration(calibrationId: string): Promise<CameraCalibration> {
  await wait()
  const cal = readCalibrationStore().calibrations.find((c) => c.calibrationId === calibrationId)
  if (!cal) throw new Error('This calibration no longer exists.')
  return cal
}

/**
 * Demo calibration: the "photo" is not analyzed. The card always covers
 * MOCK_CARD_PIXELS (30,730 of the 1024 x 1024 photo), scaled by the known area.
 */
export async function createCalibration(input: NewCalibration): Promise<CameraCalibration> {
  await wait()
  requireSession()
  if (!(Number.isFinite(input.knownAreaCm2) && input.knownAreaCm2 > 0)) throw new Error('Enter the reference size in cm², more than 0.')
  if (!input.photo.type.startsWith('image/')) throw new Error('Choose a photo (JPEG, PNG or WebP).')
  const store = readCalibrationStore()
  const n = store.calibrations.length
  const cal = mockCalibration({
    calibrationId: `cal_demo_new_${n}_${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    knownAreaCm2: input.knownAreaCm2,
    referenceLabel: input.referenceLabel.trim() || 'reference object',
    referencePixels: Math.round(MOCK_CARD_PIXELS * (input.knownAreaCm2 / 46.21)),
  })
  store.calibrations = [{ ...cal, cameraId: input.cameraId }, ...store.calibrations]
  writeCalibrationStore(store)
  return store.calibrations[0]
}

export async function getCalibrationImages(calibrationId: string): Promise<CalibrationImages> {
  const cal = await getCalibration(calibrationId)
  return mockCalibrationImages(cal, new Date())

}

// ---------------------------------------------------------------------------
// End-to-end pipeline (mock): headline totals, camera, regeneration
// ---------------------------------------------------------------------------

function mockTotal(start: IsoDate, end: IsoDate): WasteTotal {
  const d = mockImpactDashboard(start, end, todayIso())
  return {
    start,
    end,
    pixels: d.totals.pixels,
    impactPoints: d.totals.impactPoints,
    captures: d.totals.captures,
    analyzedCaptures: d.totals.analyzedCaptures,
    sampleCaptures: 0,
  }
}

export async function getWasteTotals(today: IsoDate): Promise<WasteTotals> {
  await wait()
  return { today: mockTotal(today, today), week: mockTotal(startOfWeek(today), today), month: mockTotal(startOfMonth(today), today) }
}

export async function getCameraStatus(): Promise<CameraStatus> {
  await wait()
  return { configured: false, busy: false }
}

// Demo data controls: the mock keeps its mode in memory.
let demoStatus: DemoStatus = { hallId: 'hall-main', mode: 'default', sampleLoaded: false, sampleCaptures: 0, clearedAt: null }
export async function getDemoStatus(): Promise<DemoStatus> {
  await wait()
  return { ...demoStatus }
}
export async function loadDemoData(): Promise<DemoStatus> {
  await wait()
  demoStatus = { ...demoStatus, mode: 'sample', sampleLoaded: true, sampleCaptures: 42, clearedAt: null }
  return { ...demoStatus }
}
export async function clearDemoData(): Promise<DemoStatus> {
  await wait()
  demoStatus = { ...demoStatus, mode: 'cleared', clearedAt: new Date().toISOString() }
  return { ...demoStatus }
}
export async function restoreDemoData(): Promise<DemoStatus> {
  await wait()
  demoStatus = { ...demoStatus, mode: 'default', clearedAt: null }
  return { ...demoStatus }
}

export async function takePhoto(): Promise<TakePhotoResult> {
  await wait()
  throw new Error('Demo mode has no camera. Run with the backend to take photos.')
}

export async function regenerateRecommendation(start: IsoDate, end: IsoDate): Promise<Recommendation> {
  await wait()
  return mockRecommendation(mockImpactDashboard(start, end, todayIso()), new Date())
}
