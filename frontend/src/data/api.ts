/**
 * Data-access layer. Components only talk to this module.
 *
 * By default it calls the real backend (liveApi.ts → Agent 5's API, proxied
 * by Vite in dev). Set VITE_USE_MOCK=1 to run the dashboard on the
 * deterministic demo data in mockData.ts instead; unit tests always use mock.
 */
import * as live from './liveApi'
import * as mock from './mockApi'

export const USE_MOCK = import.meta.env.VITE_USE_MOCK === '1' || import.meta.env.MODE === 'test'

const impl = USE_MOCK ? mock : live

export const getMenu = impl.getMenu
export const getMenuDays = impl.getMenuDays
export const saveUserMenu = impl.saveUserMenu
export const getDailyWaste = impl.getDailyWaste
export const getMealDetail = impl.getMealDetail
export const getSummaryCards = impl.getSummaryCards
export const getPortionService = impl.getPortionService
export const savePortions = impl.savePortions
export const importPortionsCsv = impl.importPortionsCsv
export const getPortionBenchmark = impl.getPortionBenchmark
export const getPlates = impl.getPlates
export const getImageUrl = impl.getImageUrl

/** Artificial latency for mock mode so loading states are visible; tests set 0. */
export const setApiLatency = mock.setApiLatency
/** Latest selectable menu date (a few days ahead in both modes). */
export const latestMenuDate = mock.latestMenuDate
