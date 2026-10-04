/**
 * Plain-language copy and small helpers shared by the waste-impact dashboard
 * sections (UI.md writing rules: no technical terms beyond "Pixels wasted").
 */
import type { ItemImpactRow } from '../data/types'

export const HOW_MEASURED =
  'How we measure: the AI outlines the leftover food in each plate photo and counts it pixel by pixel. We turn that into grams using the size of the plate and a typical weight for each food. Grams and everything after them are estimates, not a scale reading.'

export const TOTAL_WASTE_EXPLANATION =
  'Estimated weight of the food left on the plates we scanned. It comes from the counted pixels, the plate size, and a typical weight per area for each food. It is not a scale reading.'

export const CO2_EXPLANATION =
  'Greenhouse gases released to grow, make, and ship the food that was left, in kilograms of carbon dioxide equivalent. Estimate based on published figures for each food.'

export const WATER_EXPLANATION =
  'Freshwater used to produce the food that was left. Estimate based on published figures for each food. 1 cubic meter is 1,000 litres.'

export const IMPACT_EXPLANATION =
  'A dollar value for the harm of the wasted food: $0.19 for each kg of greenhouse gases plus $1.50 for each cubic meter of freshwater it took to make (0.19 x CO₂e + 1.50 x water). It is not what the food cost, and nutrition is not part of it.'

export const PER_PORTION_EXPLANATION =
  'Estimated food left on scanned plates divided by the portions served for that food on the same days. Only some plates are scanned, so the true amount per portion can be higher. It shows where to look, not why food was left.'

export const NUTRITION_EXPLANATION =
  'One nutrient-day is enough nutrients for one adult for one day. This is shown on its own and is not part of the waste impact score.'

/** Why a food has no per-portion number ("Foods to target"). Null = it has one. */
export function perPortionUnavailableReason(row: ItemImpactRow): string | null {
  if (row.itemId === null || row.impact.unavailableReason === 'unknown_item') return 'Not on the menu, so it has no portions'
  if (row.portionsServed === null) return 'No portions entered'
  if (row.portionsServed === 0 || row.perPortion === null) return 'No portions served'
  if (row.perPortion.grams === null) return weightUnavailableReason(row) ?? 'No weight estimate for this food'
  return null
}

/** Why a food has no estimated grams ("Most wasted"). Null = it has them. */
export function weightUnavailableReason(row: ItemImpactRow): string | null {
  if (row.impact.grams !== null) return null
  switch (row.impact.unavailableReason) {
    case 'unknown_item':
      return 'Not on the menu, so there is no weight estimate'
    case 'no_calibration':
      return 'Plate size unknown'
    case 'no_factor':
    default:
      return row.itemId === null ? 'Not on the menu, so there is no weight estimate' : 'No weight estimate for this food'
  }
}

/** Split a formatted value at its first space: "1,620 kg CO2e" -> ["1,620", "kg CO2e"]. */
export function splitUnit(formatted: string): [string, string] {
  const i = formatted.indexOf(' ')
  return i < 0 ? [formatted, ''] : [formatted.slice(0, i), formatted.slice(i + 1)]
}

export function formatNutrientDays(days: number): string {
  return days < 10 ? days.toFixed(1) : String(Math.round(days))
}
