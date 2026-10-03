/**
 * Typed/JSON menu upload parsing (UI.md setup step 2, "Upload menus myself"):
 * pick a date, add items under Breakfast / Lunch / Dinner, several days at
 * once. Produces contract-exact MenuBundle records (MealService + MenuItem[])
 * with deterministic IDs (see ids.ts).
 *
 * Menu text is untrusted input (AGENTS.md working rule 8): it is validated,
 * length-capped, and stored as data only — it can never select tools or
 * change application behavior.
 */

import { invalid } from './errors.js';
import {
  MEAL_LABELS,
  makeItemId,
  makeMenuId,
  makeServiceId,
  validateHallId,
  validateMealLabel,
  validateServiceDate,
  validateTimezone,
} from './ids.js';
import type {
  MealLabel,
  MenuBundle,
  MenuItem,
  MenuUpload,
  MenuUploadItem,
} from './types.js';

export const MAX_NAME_LENGTH = 200;
export const MAX_CATEGORY_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_ITEMS_PER_MEAL = 200;

interface NormalizedItem {
  name: string;
  category?: string;
  description?: string;
}

function cleanText(
  value: unknown,
  field: string,
  maxLength: number,
  context: Record<string, unknown>,
): string {
  if (typeof value !== 'string') {
    invalid('INVALID_MENU_ITEM', `Menu item ${field} must be text.`, { ...context, field });
  }
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length > maxLength) {
    invalid('INVALID_MENU_ITEM', `Menu item ${field} is too long (max ${maxLength} characters).`, {
      ...context,
      field,
      length: trimmed.length,
    });
  }
  return trimmed;
}

function normalizeUploadItem(raw: MenuUploadItem, context: Record<string, unknown>): NormalizedItem {
  if (typeof raw === 'string') {
    const name = cleanText(raw, 'name', MAX_NAME_LENGTH, context);
    if (!name) invalid('INVALID_MENU_ITEM', 'Menu item names cannot be empty.', context);
    return { name };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalid('INVALID_MENU_ITEM', 'Each menu item must be a name or an object with a name.', context);
  }
  const name = cleanText(raw.name, 'name', MAX_NAME_LENGTH, context);
  if (!name) invalid('INVALID_MENU_ITEM', 'Menu item names cannot be empty.', context);
  const item: NormalizedItem = { name };
  if (raw.category !== undefined && raw.category !== '') {
    item.category = cleanText(raw.category, 'category', MAX_CATEGORY_LENGTH, context);
  }
  if (raw.description !== undefined && raw.description !== '') {
    item.description = cleanText(raw.description, 'description', MAX_DESCRIPTION_LENGTH, context);
  }
  return item;
}

/**
 * Builds one contract-exact MenuBundle for a hall/date/meal.
 * New bundles always start at menuVersion 1; revisions go through
 * planMenuRevision (revisions.ts), never a silent rewrite.
 */
export function buildMenuBundle(
  hallId: string,
  hallTimezone: string,
  date: string,
  meal: MealLabel,
  rawItems: readonly MenuUploadItem[],
): MenuBundle {
  const context = { hallId, date, meal };
  if (rawItems.length === 0) {
    invalid('EMPTY_MEAL', 'A meal needs at least one menu item.', context);
  }
  if (rawItems.length > MAX_ITEMS_PER_MEAL) {
    invalid('TOO_MANY_ITEMS', `A meal can have at most ${MAX_ITEMS_PER_MEAL} items.`, context);
  }

  const menuId = makeMenuId(hallId, date, meal);
  const seenIds = new Map<string, string>(); // itemId -> original name
  const items: MenuItem[] = rawItems.map((raw, index) => {
    const normalized = normalizeUploadItem(raw, { ...context, index });
    const itemId = makeItemId(hallId, date, meal, normalized.name);
    const clash = seenIds.get(itemId);
    if (clash !== undefined) {
      invalid(
        'DUPLICATE_MENU_ITEM',
        `"${normalized.name}" appears more than once in ${meal} on ${date}` +
          (clash === normalized.name ? '.' : ` (same ID as "${clash}"). Rename one of them.`),
        { ...context, itemId, names: [clash, normalized.name] },
      );
    }
    seenIds.set(itemId, normalized.name);
    return {
      itemId,
      menuId,
      displayName: normalized.name,
      ...(normalized.category !== undefined ? { category: normalized.category } : {}),
      ...(normalized.description !== undefined ? { description: normalized.description } : {}),
    };
  });

  return {
    service: {
      serviceId: makeServiceId(hallId, date, meal),
      hallId,
      hallTimezone,
      serviceDate: date,
      mealLabel: meal,
      menuId,
      menuVersion: 1,
    },
    items,
  };
}

/**
 * Parses and validates a typed menu upload (multiple days, meals optional
 * per day). Returns one MenuBundle per present hall/date/meal, in input
 * order with meals ordered breakfast, lunch, dinner.
 */
export function parseMenuUpload(input: unknown): MenuBundle[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid('INVALID_MENU_UPLOAD', 'Menu upload must be an object with hallId, hallTimezone, and days.');
  }
  const upload = input as Partial<MenuUpload>;
  const hallId = validateHallId(upload.hallId);
  const hallTimezone = validateTimezone(upload.hallTimezone);
  if (!Array.isArray(upload.days) || upload.days.length === 0) {
    invalid('INVALID_MENU_UPLOAD', 'Add at least one day of menus.', { hallId });
  }

  const seenDates = new Set<string>();
  const bundles: MenuBundle[] = [];
  for (const day of upload.days) {
    if (day === null || typeof day !== 'object' || Array.isArray(day)) {
      invalid('INVALID_MENU_UPLOAD', 'Each day must be an object with a date and meals.', { hallId });
    }
    const date = validateServiceDate(day.date);
    if (seenDates.has(date)) {
      invalid('DUPLICATE_DATE', `${date} appears twice in this upload. Merge its meals first.`, {
        hallId,
        date,
      });
    }
    seenDates.add(date);

    const mealsPresent = MEAL_LABELS.filter((meal) => day[meal] !== undefined);
    if (mealsPresent.length === 0) {
      invalid('EMPTY_DAY', `${date} has no meals. Add Breakfast, Lunch, or Dinner items.`, {
        hallId,
        date,
      });
    }
    for (const meal of mealsPresent) {
      const rawItems = day[meal];
      if (!Array.isArray(rawItems)) {
        invalid('INVALID_MENU_UPLOAD', `${meal} on ${date} must be a list of items.`, {
          hallId,
          date,
          meal,
        });
      }
      bundles.push(buildMenuBundle(hallId, hallTimezone, date, validateMealLabel(meal), rawItems));
    }
  }
  return bundles;
}
