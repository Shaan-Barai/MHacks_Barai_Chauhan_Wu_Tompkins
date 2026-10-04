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
export const getImpactDashboard = impl.getImpactDashboard
export const getCaptures = impl.getCaptures
export const getCaptureImages = impl.getCaptureImages
export const getRecommendation = impl.getRecommendation

// IT_4: staff sign-in, camera calibration, measurement settings.
export const getSession = impl.getSession
export const login = impl.login
export const logout = impl.logout
export const getMeasurementSettings = impl.getMeasurementSettings
export const saveMeasurementSettings = impl.saveMeasurementSettings
export const getCalibrations = impl.getCalibrations
export const getCalibration = impl.getCalibration
export const createCalibration = impl.createCalibration
export const getCalibrationImages = impl.getCalibrationImages
/** Demo-mode passcode (mock only; the live passcode is set on the server). */
export const MOCK_PASSCODE = mock.MOCK_PASSCODE

/** Artificial latency for mock mode so loading states are visible; tests set 0. */
export const setApiLatency = mock.setApiLatency
/** Latest selectable menu date (a few days ahead in both modes). */
export const latestMenuDate = mock.latestMenuDate
