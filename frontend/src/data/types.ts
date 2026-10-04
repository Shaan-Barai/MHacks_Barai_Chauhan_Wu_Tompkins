/**
 * Frontend view types. Field names and conventions mirror contracts/types.ts
 * and the backend GET endpoints (backend/README.md): meal labels, service
 * dates (local YYYY-MM-DD), item/menu IDs. The primary metric is Pixels wasted
 * (contracts/measurement.md): foreground pixels counted in AI-generated
 * leftover-food masks, not grams or servings. Attendance is always labeled
 * "simulated".
 */
import type { IsoDate } from '../lib/dates'

export type { IsoDate }

export type MealLabel = 'breakfast' | 'lunch' | 'dinner'
export const MEALS: MealLabel[] = ['breakfast', 'lunch', 'dinner']
export const MEAL_NAME: Record<MealLabel, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
}

export interface MealHours {
  start: string // "07:00"
  end: string // "10:30"
}

/** Days of the week, Monday first. */
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
export const WEEKDAY_NAME: Record<Weekday, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
}

/** One set of meal times and the days it applies to, e.g. "Weekdays". */
export interface MealTimeSet {
  id: string
  name: string
  days: Weekday[]
  meals: Record<MealLabel, MealHours>
}

/** A one-off event with its own hours, e.g. a football game. */
export interface SpecialEvent {
  id: string
  name: string
  date: IsoDate
  start: string
  end: string
}

/** Saved by first-time setup and Settings (localStorage). */
export interface HallSettings {
  hallId: string
  name: string
  timeSets: MealTimeSet[]
  events: SpecialEvent[]
}

export interface MenuItemLite {
  itemId: string
  displayName: string
}

/** One day's menu across the three meals (GET /api/menus?date=…). */
export interface DayMenu {
  date: IsoDate
  menuId: string
  source: 'mock' | 'user'
  meals: Record<MealLabel, MenuItemLite[]>
}

/** One point of the main chart (dashboard summary series). */
export interface DailyWastePoint {
  date: IsoDate
  /** Pixels wasted that day (counted mask pixels); null = no counted plates. */
  pixelsWasted: number | null
}

export interface ItemWaste extends PhysicalAmounts {
  itemId: string
  displayName: string
  /** Mask pixels counted for this item across the meal. */
  pixelsWasted: number
  /** Share of the meal's wasted pixels, 0–100 (not % of food served). */
  shareOfMealPixelsPercent: number
}

/** AI-generated tip (contract Insight), from mock data in the prototype. */
export interface MealTip {
  recommendation: string
  source: 'gemini' | 'fallback_rules'
}

/** Day-details data per meal (GET /api/dashboard/meal). */
export interface MealDetail {
  portionBenchmark?: PortionBenchmark;
  serviceId: string
  date: IsoDate
  meal: MealLabel
  /** Union of counted mask pixels across the meal's counted plates. */
  pixelsWasted: number
  /** Food pixels not attributable to a menu item (unknown food or overlapping masks). */
  unclassifiedPixels: number
  platesScanned: number
  /**
   * Coverage (AGENTS.md §9.7): plates in the total (incl. validated empty
   * plates) and plates left out (failed, partial, or still processing).
   * Left-out plates are never counted as zero.
   */
  coverage: { platesCounted: number; emptyPlates: number; platesLeftOut: number }
  /** Simulated attendance (contract Attendance; source is always "simulated"). */
  mealSwipes: { count: number; source: 'simulated' }
  /** Sorted by pixelsWasted, descending. Empty when no plate was counted. */
  items: ItemWaste[]
  /** Null when no item counted yet (nothing to ground a tip in). */
  tip: MealTip | null
}

export interface PortionBenchmarkItem {
  itemId: string
  displayName: string
  portionsServed: number | null
  portionsSource: 'manual' | 'csv' | 'demo' | null
  pixelsWasted: number | null
  pixelsWastedPerPortion: number | null
  measuredCaptures: number
  unavailableReason: string | null
}

export interface PortionBenchmark {
  hallId: string
  serviceId: string
  serviceDate: string
  menuVersion: number
  items: PortionBenchmarkItem[]
  capturedDishes: number
  measuredDishes: number
  excludedMeasurements: number
  label: 'Pixels wasted per portion'
  unit: 'pixels/portion'
  coverageNote: string
}

export interface PortionService {
  serviceId: string
  menuVersion: number
  items: MenuItemLite[]
  portions: { itemId: string; count: number; source: 'manual' | 'csv' | 'demo' }[]
}

export interface PortionEntry { itemId: string; count: number | null }

export interface PeriodSummary {
  /** Inclusive local-date window the number covers. */
  start: IsoDate
  end: IsoDate
  pixelsWasted: number
  /** Same-length window immediately before; null when it has no data. */
  previousPixelsWasted: number | null
  /** Mean percent of a full serving left per plate (clean plates 0%); null without plates. */
  averagePlateWastePercent: number | null
  platesCounted: number
}

/** One food label on a scanned plate ("Behind the scenes"). */
export interface PlateFood {
  itemId: string | null
  name: string
  /** Counted leftover pixels for this food (mask pixels, or a legacy estimate). */
  pixelsWasted: number
  /** Leftover as a percent of a full serving (capped at 100); null without a reference serving. */
  percentOfServing: number | null
  flags: string[]
}

/** One scanned plate with its photo reference and labels. */
export interface PlateRecord {
  eventId: string
  capturedAt: string
  source: string
  state: 'pending' | 'processing' | 'succeeded' | 'needs_review' | 'failed'
  imageObjectId: string
  plateWastePercent: number | null
  foods: PlateFood[]
}

/** The three summary cards (Today / This week / This month). */
export interface SummaryCards {
  today: PeriodSummary
  thisWeek: PeriodSummary
  thisMonth: PeriodSummary
}

// ---------------------------------------------------------------------------
// Waste impact (local copy of the contracts/types.ts waste-impact section,
// BIG-PLAN.md v2 2026-10-04). Pixels wasted is the measurement and the
// headline unit. Relative impact points are unitless, derived by analytics,
// and never kg, litres or dollars. No plate-size calibration, no grams.
// ---------------------------------------------------------------------------

export type CaptureSource = 'camera' | 'replay' | 'manual_upload'
export type ProcessingState = 'pending' | 'processing' | 'succeeded' | 'needs_review' | 'failed'

export type ImpactUnavailableReason = 'no_factor' | 'unknown_item'

/**
 * Derived (never stored) relative impact for a set of counted pixels.
 * "Points" are UNITLESS and only comparable with each other:
 *   points = (pixels / 1000) x weight_g_per_cm2 x factor
 * co2Points uses C, waterPoints uses W, impactPoints uses 0.19 C + 1.50 W.
 */
export interface WasteImpact extends PhysicalAmounts {
  pixels: number
  co2Points: number | null
  waterPoints: number | null
  impactPoints: number | null
  /** Separate statistic from nutrient-days/kg. NOT part of impactPoints. */
  nutritionPoints: number | null
  wasteFactorsVersion: string
  unavailableReason?: ImpactUnavailableReason
  /** IT_4: the method behind grams ('area-calibrated-v1'); null when there are no grams. */
  physicalMethod?: PhysicalMethod | null
}

/** Per-portion rates over the same hall/date/service/menu version. */
export interface PerPortion {
  pixels: number
  impactPoints: number | null
  /** IT_4: estimated grams per portion (calibrated captures only); null when unavailable. */
  grams?: number | null
}

export interface ItemImpactRow {
  /** null = unknown / not-on-menu food bucket. */
  itemId: string | null
  displayName: string
  factorKey: string | null
  /** Which factor table supplied CO2/water: the hall's own ('east-quad') or the 500 common foods fallback. */
  factorTable?: 'east-quad' | 'common-500' | null
  impact: WasteImpact
  /** Summed portions served across the window; null when missing. */
  portionsServed: number | null
  portionsSource: 'manual' | 'csv' | 'demo' | null
  /** null when portions are missing or zero, or the item is unknown. */
  perPortion: PerPortion | null
}

/** GET /api/dashboard/impact?start&end[&hallId] */
export interface ImpactDashboard {
  window: { start: string; end: string; hallId?: string }
  totals: WasteImpact & {
    captures: number
    analyzedCaptures: number
    excludedCaptures: number
    /** IT_4: analyzed captures that carried physical estimates (calibrated). Absent from older backends. */
    physicalCoverage?: PhysicalCoverage
  }
  /** Ranked by perPortion.pixels desc ("Foods to target"); unavailable rates last. */
  targets: ItemImpactRow[]
  /** Ranked by impact.pixels desc ("Most wasted"). */
  mostWasted: ItemImpactRow[]
  coverage: {
    itemsWithFactor: number
    itemsWithoutFactor: number
    itemsWithPortions: number
    /** Captures where food outside the scanned (target) dish was excluded. */
    capturesWithNeighborFoodExcluded: number
  }
  labels: { relativeImpact: true; demoPortions: boolean }
}

/** GET /api/captures?start&end: recent plates for the dashboard gallery. */
/** Admin panel row: a plate plus whether an admin hid it from the dashboard. */
export interface AdminCaptureItem extends CaptureListItem {
  hidden: boolean
}

export interface CaptureListItem {
  eventId: string
  capturedAt: string
  serviceId: string
  source: CaptureSource
  state: ProcessingState
  pixelsWasted: number | null
  items: Array<
    { itemId: string | null; displayName: string; pixels: number } & PhysicalAmounts & {
      areaCm2?: number | null
    }
  >
  hasOverlay: boolean
  calibrationId?: string | null
  physicalMethod?: PhysicalMethod | null
}

export interface SignedImage {
  objectId: string
  url: string
  expiresAt: string
}

/** GET /api/captures/:eventId/images */
export interface CaptureImages {
  eventId: string
  original: SignedImage | null
  overlay: SignedImage | null
  masks: Array<SignedImage & { itemId: string | null; displayName: string }>
}

/** GET /api/recommendation?start&end[&hallId] */
export interface Recommendation {
  text: string
  bullets: Array<{ text: string; metric: string }>
  source: 'gemini' | 'fallback'
  generatedAt: string
  inputVersion: string
}

// ---------------------------------------------------------------------------
// IT_4 (2026-10-04): camera calibration, calibrated area, ESTIMATED grams /
// kg CO2e / litres of water. Local copy of the contracts/types.ts IT_4
// section. Area comes only from the camera calibration (pixels x cm2PerPx);
// grams = area x the food's typical weight per cm2. Pixels wasted stay the
// measurement; physical numbers are labeled estimates and are null (never 0)
// when missing. New fields are optional here so payloads from older backends
// still parse.
// ---------------------------------------------------------------------------

export type PhysicalMethod = 'area-calibrated-v1'

export type PhysicalUnavailableReason = 'no_calibration' | 'incompatible_geometry' | 'no_factor' | 'unknown_item'

/** Estimated physical amounts; null or absent = unavailable, never 0. */
export interface PhysicalAmounts {
  grams?: number | null
  kgCo2e?: number | null
  waterLitres?: number | null
  physicalUnavailableReason?: PhysicalUnavailableReason
}

export interface PhysicalCoverage {
  calibratedCaptures: number
  analyzedCaptures: number
}

export interface CameraIntrinsics {
  cameraModel: 'logitech-c920s' | 'other'
  widthPx: number
  heightPx: number
  fxPx: number
  fyPx: number
  cxPx: number
  cyPx: number
  source: 'nominal-fov' | 'checkerboard' | 'configured'
}

export type CameraCalibrationFlag =
  | 'reference_not_found'
  | 'reference_low_confidence'
  | 'reference_touches_edge'

/** POST /api/calibrations, GET /api/calibrations[/:id] */
export interface CameraCalibration {
  calibrationId: string
  hallId: string
  cameraId: string
  createdAt: string
  status: 'processing' | 'succeeded' | 'failed'
  method: 'reference-area-v1'
  imageObjectId: string
  overlayObjectId?: string
  referenceMaskObjectId?: string
  widthPx: number
  heightPx: number
  knownAreaCm2: number
  referenceLabel: string
  referencePixels: number
  cm2PerPx: number
  intrinsics: CameraIntrinsics
  /** Camera height above the table, f x sqrt(k) (cm), from the photo. */
  cameraHeightCmGeometric: number
  flags: CameraCalibrationFlag[]
  error?: { code: string; message: string; retryable?: boolean }
}

/** GET /api/calibrations/:id/images (short-lived links). */
export interface CalibrationImages {
  calibrationId: string
  /** The calibration photo as taken. */
  photo: SignedImage | null
  /** The photo with the reference object outlined. */
  outline: SignedImage | null
}

/** GET/PUT /api/settings/measurement (per hall). */
export interface MeasurementSettings {
  hallId: string
  activeCalibrationId: string | null
  updatedAt: string
}

export interface NewCalibration {
  cameraId: string
  knownAreaCm2: number
  referenceLabel: string
  photo: File
}

/** GET /api/auth/me. `authAvailable: false` = the backend has no sign-in (older local backends). */
export interface AuthSession {
  signedIn: boolean
  authAvailable: boolean
  expiresAt?: string
}
