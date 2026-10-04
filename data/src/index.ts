/**
 * scrap-data — Agent 2's menu/reference validation package.
 * Pure helpers only: no I/O, no database access, no network (AGENTS.md 2.5).
 */

export * from './types.js';
export { parsePortionsServed, parsePortionsCsv, MAX_PORTIONS_SERVED } from './portionsServed.js';
export { DEMO_PORTION_RANGES, portionRole, type PortionRole } from './portionRoles.js';
export { DataValidationError } from './errors.js';
export {
  COMMON_WASTE_FACTORS,
  HALAL_BROS_NUTRITION_FACTORS,
  HALAL_BROS_WASTE_FACTORS,
  WASTE_FACTORS,
  NUTRITION_FACTORS,
  WASTE_FACTOR_MENU_TEXT,
  WASTE_FACTORS_VERSION,
  CARBON_USD_PER_KG_CO2E,
  WATER_USD_PER_M3,
  factorKeyFor,
  findWasteFactor,
  findNutritionFactor,
  findFactorMenuText,
  type WasteFactorMenuText,
} from './factors.js';
export {
  MEAL_LABELS,
  slugifyName,
  makeServiceId,
  makeMenuId,
  makeItemId,
  makeBaselineId,
  localServiceDate,
  validateHallId,
  validateServiceDate,
  validateMealLabel,
  validateTimezone,
} from './ids.js';
export {
  parseMenuUpload,
  buildMenuBundle,
  MAX_NAME_LENGTH,
  MAX_CATEGORY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_ITEMS_PER_MEAL,
} from './menuBundle.js';
export { parseMenuCsv, readCsvRecords } from './menuCsv.js';
export { planMenuRevision, type MenuRevisionPlan } from './revisions.js';
export {
  buildVocabulary,
  findVocabulary,
  isAllowedClassification,
  UNKNOWN_RESULT,
  type ClassificationVocabulary,
  type VocabularyEntry,
  type VocabularyLookup,
} from './vocabulary.js';
export {
  COORDINATE_SPACE,
  REFERENCE_SOURCES,
  DEFAULT_DIAMETER_TOLERANCE,
  validateImageGeometry,
  validateReferencePortion,
  createReferencePortion,
  resolveReferencePortion,
  checkGeometryCompatibility,
  type ReferencePortionInput,
  type ReferenceLookup,
  type GeometryCompatibility,
} from './referencePortions.js';
