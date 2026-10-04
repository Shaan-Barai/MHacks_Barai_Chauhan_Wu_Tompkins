/**
 * Data-access layer. Components only talk to this module.
 *
 * By default it calls the real backend (liveApi.ts → Agent 5's API, proxied
 * by Vite in dev). Set VITE_USE_MOCK=1 to run the dashboard on the
 * deterministic demo data in mockData.ts instead; unit tests always use mock.
 */
import * as live from './liveApi'
import * as mock from './mockApi'
import * as demo from './demoMetrics'
import { demoImageUrl, demoPlatesFor } from './demoPlates'
import type { IsoDate, MealLabel } from './types'

export const USE_MOCK = import.meta.env.VITE_USE_MOCK === '1' || import.meta.env.MODE === 'test'

const impl = USE_MOCK ? mock : live

export const getMenu = impl.getMenu
export const getMenuDays = impl.getMenuDays
export const saveUserMenu = impl.saveUserMenu
export const saveUserMenuDays = impl.saveUserMenuDays
export const getDailyWaste = impl.getDailyWaste
export const getMealDetail = impl.getMealDetail
export const getSummaryCards = impl.getSummaryCards
export const getPortionService = impl.getPortionService
export const savePortions = impl.savePortions
export const importPortionsCsv = impl.importPortionsCsv
export const getPortionBenchmark = impl.getPortionBenchmark
/** Real scanned plates, with demo plate photos (demoPlates.ts) first while demo numbers are on. */
export async function getPlates(date: IsoDate, meal: MealLabel) {
  const plates = await impl.getPlates(date, meal)
  return DEMO_METRICS ? [...demoPlatesFor(date, meal), ...plates] : plates
}
export async function getImageUrl(objectId: string): Promise<string> {
  return demoImageUrl(objectId) ?? impl.getImageUrl(objectId)
}
export const getImpactDashboard = impl.getImpactDashboard
export const getCaptures = impl.getCaptures
export const getCaptureImages = impl.getCaptureImages
export const getRecommendation = impl.getRecommendation

/**
 * The dashboard's summary cards and daily chart show simulated waste scores
 * (demoMetrics.ts) unless VITE_DEMO_METRICS=0. Unit tests use the mock data.
 */
export const DEMO_METRICS = import.meta.env.MODE !== 'test' && import.meta.env.VITE_DEMO_METRICS !== '0'
export const getDashboardSummary = DEMO_METRICS ? demo.getSummaryCards : impl.getSummaryCards
export const getDashboardDaily = DEMO_METRICS ? demo.getDailyWaste : impl.getDailyWaste

/** Timezone sent with menu uploads (also shown in the menu API example). */
export const HALL_TIMEZONE = live.HALL_TIMEZONE

/** Artificial latency for mock mode so loading states are visible; tests set 0. */
export const setApiLatency = mock.setApiLatency
/** Latest selectable menu date (a few days ahead in both modes). */
export const latestMenuDate = mock.latestMenuDate
