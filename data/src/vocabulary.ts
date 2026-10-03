/**
 * Classification vocabulary (AGENTS.md 2.2 / 4.2).
 *
 * Classification categories come ONLY from the applicable daily menu for the
 * hall/date/service. Anything not on that menu is the separate unknown/
 * non-menu result (FoodMeasurement.itemId = null) — never an invented item.
 */

import { makeServiceId, validateMealLabel } from './ids.js';
import type { MealLabel, MenuBundle } from './types.js';

export interface VocabularyEntry {
  itemId: string;
  displayName: string;
  category?: string;
  description?: string;
}

/**
 * The one allowed non-menu outcome. Not a menu item: it has no itemId, and
 * measurements using it set FoodMeasurement.itemId = null. Unknown items keep
 * their visible-area estimate but are excluded from menu percentages
 * (AGENTS.md §6).
 */
export const UNKNOWN_RESULT = Object.freeze({
  kind: 'unknown_or_non_menu' as const,
  itemId: null,
  label: 'Unknown or non-menu food',
  instruction:
    'Use this result when the visible food does not match any allowed menu item; never invent a new item.',
});

export interface ClassificationVocabulary {
  serviceId: string;
  hallId: string;
  serviceDate: string;
  mealLabel: MealLabel;
  menuId: string;
  menuVersion: number;
  /** The ONLY itemIds a classifier may return for this service. */
  items: VocabularyEntry[];
  /** The separate unknown/non-menu result — not part of `items`. */
  unknown: typeof UNKNOWN_RESULT;
}

/** Builds the classification vocabulary for one stored menu bundle. */
export function buildVocabulary(bundle: MenuBundle): ClassificationVocabulary {
  return {
    serviceId: bundle.service.serviceId,
    hallId: bundle.service.hallId,
    serviceDate: bundle.service.serviceDate,
    mealLabel: bundle.service.mealLabel,
    menuId: bundle.service.menuId,
    menuVersion: bundle.service.menuVersion,
    items: bundle.items.map((item) => ({
      itemId: item.itemId,
      displayName: item.displayName,
      ...(item.category !== undefined ? { category: item.category } : {}),
      ...(item.description !== undefined ? { description: item.description } : {}),
    })),
    unknown: UNKNOWN_RESULT,
  };
}

export type VocabularyLookup =
  | { found: true; vocabulary: ClassificationVocabulary }
  | { found: false; reason: string; serviceId: string };

/**
 * Resolves the vocabulary for a hall/local-date/meal from a set of stored
 * bundles. A missing menu is an explicit absence — classification must not
 * proceed against an empty or guessed vocabulary.
 */
export function findVocabulary(
  bundles: readonly MenuBundle[],
  hallId: string,
  serviceDate: string,
  meal: MealLabel | string,
): VocabularyLookup {
  const mealLabel = validateMealLabel(meal);
  const serviceId = makeServiceId(hallId, serviceDate, mealLabel);
  const bundle = bundles.find((candidate) => candidate.service.serviceId === serviceId);
  if (!bundle) {
    return {
      found: false,
      serviceId,
      reason: `No menu is saved for ${hallId} ${mealLabel} on ${serviceDate}. Add one in Menus.`,
    };
  }
  return { found: true, vocabulary: buildVocabulary(bundle) };
}

/** True when an itemId belongs to the vocabulary (null = unknown is always allowed). */
export function isAllowedClassification(
  vocabulary: ClassificationVocabulary,
  itemId: string | null,
): boolean {
  if (itemId === null) return true;
  return vocabulary.items.some((item) => item.itemId === itemId);
}
