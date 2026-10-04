/**
 * Waste and nutrition factor tables (BIG-PLAN D1, D4).
 *
 * The data lives in factors.generated.ts, generated from the repo-root CSVs
 * (menu_waste_factors_EastQuad.csv, menu_nutrition_factors_EastQuad.csv,
 * menu_waste_factors_halal_bros.csv, menu_waste_factors_500.csv) by
 * data/scripts/generate-factors.mjs. The CSVs are the source of truth.
 *
 * Menu items match a factor row by `factorKey = slug(displayName)`. Items
 * with no row have no impact factor; callers must show "no impact factor",
 * never zero.
 */

import type { NutritionFactor, WasteFactor } from '../../contracts/types.js';
import {
  COMMON_WASTE_FACTORS,
  HALAL_BROS_NUTRITION_FACTORS,
  HALAL_BROS_WASTE_FACTORS,
  NUTRITION_FACTORS,
  WASTE_FACTORS,
  WASTE_FACTOR_MENU_TEXT,
  type WasteFactorMenuText,
} from './factors.generated.js';
import { slugifyName } from './ids.js';

export {
  COMMON_WASTE_FACTORS,
  HALAL_BROS_NUTRITION_FACTORS,
  HALAL_BROS_WASTE_FACTORS,
  NUTRITION_FACTORS,
  WASTE_FACTORS,
  WASTE_FACTOR_MENU_TEXT,
  type WasteFactorMenuText,
};

/** Stamp on every derived impact so a factor edit is traceable (D3). */
export const WASTE_FACTORS_VERSION = 'waste-factors-v6';

/** Score weights (D1): dollars per kg CO2e and per m³ freshwater. No nutrition term. */
export const CARBON_USD_PER_KG_CO2E = 0.19;
export const WATER_USD_PER_M3 = 1.5;

/** slug: lowercase ASCII, accents stripped, non-alphanumeric runs -> '-', trimmed. */
export function factorKeyFor(displayName: string): string {
  return slugifyName(displayName);
}

const wasteByKey = new Map([...WASTE_FACTORS, ...HALAL_BROS_WASTE_FACTORS].map((f) => [f.factorKey, f] as const));
const commonByKey = new Map(COMMON_WASTE_FACTORS.map((f) => [f.factorKey, f] as const));
const nutritionByKey = new Map([...NUTRITION_FACTORS, ...HALAL_BROS_NUTRITION_FACTORS].map((f) => [f.factorKey, f] as const));
const textByKey = new Map(WASTE_FACTOR_MENU_TEXT.map((f) => [f.factorKey, f] as const));

/**
 * The restaurant tables (East Quad, then Halal Bros; their keys never overlap) win; a menu item
 * they don't cover falls back to the 500-common-foods table by exact factorKey. `factor.table`
 * says which one supplied it.
 */
export function findWasteFactor(displayName: string): WasteFactor | null {
  const key = factorKeyFor(displayName);
  return wasteByKey.get(key) ?? commonByKey.get(key) ?? null;
}

export function findNutritionFactor(displayName: string): NutritionFactor | null {
  return nutritionByKey.get(factorKeyFor(displayName)) ?? null;
}

export function findFactorMenuText(displayName: string): WasteFactorMenuText | null {
  return textByKey.get(factorKeyFor(displayName)) ?? null;
}
