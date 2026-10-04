/**
 * Plain-language copy and small helpers shared by the waste-impact dashboard
 * sections (UI.md writing rules). BIG-PLAN v2: pixels are the headline unit;
 * impact and nutrition are relative points, never kg, litres or dollars.
 * IT_4 adds ESTIMATED grams, kg CO2e and litres of water from the camera
 * calibration; they are always labeled estimates.
 */
import type { ItemImpactRow } from '../data/types'

export const HOW_MEASURED =
  'How we measure: the AI outlines the leftover food on the plate being scanned and counts its pixels. Impact points weight those pixels by each food’s typical weight per cm² and its greenhouse-gas and water footprint. They are relative, for comparing foods, not a scale reading.'

export const RELATIVE_POINTS_NOTE = 'Relative points: they compare foods with each other, not kg or litres.'

export const IMPACT_EXPLANATION =
  'Points compare foods with each other. They are not kilograms, litres, or dollars. For each food, points = pixels ÷ 1,000 × the food’s typical weight per cm² × a footprint factor. Greenhouse-gas points use its greenhouse-gas footprint, water points use its water footprint, and the impact score is 0.19 × greenhouse-gas points + 1.50 × water points. So a beef dish counts for more than the same pixels of rice. Nutrition is not part of it.'

export const PER_PORTION_EXPLANATION =
  'Pixels wasted on scanned plates divided by the portions served for that food on the same days. Only some plates are scanned, so the true amount per portion can be higher. It shows where to look, not why food was left.'

export const NUTRITION_EXPLANATION =
  'Relative points for the nutrients left on plates: pixels ÷ 1,000 × the food’s typical weight per cm² × its nutrients per kilogram. Higher means more nutrition was thrown away. Use them to compare foods. They are shown on their own and are not part of the impact score.'

export const ESTIMATED_TOTALS_EXPLANATION =
  'An estimate, not a scale reading. The camera calibration (a reference object of known area) turns pixels into square centimetres. Each food’s typical weight per cm² turns that into grams, and its footprint per kilogram gives CO2e and water. Only plates scanned with a calibrated camera count here. Pixels wasted stay the measurement.'

export const NEIGHBOR_EXPLANATION =
  'Only the plate being scanned is counted. Food on a neighboring plate in the same photo is outlined as "Other dish (not counted)" and left out.'

/** Why a food has no per-portion number ("Foods to target"). Null = it has one. */
export function perPortionUnavailableReason(row: ItemImpactRow): string | null {
  if (row.itemId === null || row.impact.unavailableReason === 'unknown_item') return 'Not on the menu, so it has no portions'
  if (row.portionsServed === null) return 'No portions entered'
  if (row.portionsServed === 0 || row.perPortion === null) return 'No portions served'
  return null
}

/** Why a food has no impact points. Null = it has them. */
export function impactUnavailableReason(row: ItemImpactRow): string | null {
  if (row.impact.impactPoints != null) return null
  if (row.itemId === null || row.impact.unavailableReason === 'unknown_item') return 'Not on the menu, so no impact points'
  return 'No impact data for this food'
}

/** Split a formatted value at its first space: "1.2M pixels" -> ["1.2M", "pixels"]. */
export function splitUnit(formatted: string): [string, string] {
  const i = formatted.indexOf(' ')
  return i < 0 ? [formatted, ''] : [formatted.slice(0, i), formatted.slice(i + 1)]
}
