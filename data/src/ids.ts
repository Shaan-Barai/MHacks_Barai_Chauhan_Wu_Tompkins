/**
 * Deterministic ID scheme (Agent 2).
 *
 * IDs are pure functions of hall + local service date + meal (+ item name),
 * so re-parsing the same upload always yields the same IDs and records join
 * by ID, never by display name (contracts/README.md).
 *
 *   serviceId  = svc_<hallId>_<date>_<meal>
 *   menuId     = menu_<hallId>_<date>_<meal>
 *   itemId     = item_<hallId>_<date>_<meal>_<name-slug>
 *   baselineId = base_<itemId minus "item_">_v<version>
 *
 * `_` separates ID fields, so hallId itself may not contain `_`
 * (enforced by validateHallId). Menu IDs are per hall+date+MEAL — not per
 * date as in contracts/samples.json — because MenuItem joins to its menu by
 * menuId alone and breakfast/lunch/dinner carry different item lists.
 * A date-scoped menuId would make per-service item resolution ambiguous.
 * Recorded as an Agent 2 assumption in data/README.md.
 */

import { invalid } from './errors.js';
import type { MealLabel } from './types.js';

export const MEAL_LABELS: readonly MealLabel[] = ['breakfast', 'lunch', 'dinner'];

const HALL_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateHallId(hallId: unknown): string {
  if (typeof hallId !== 'string' || !HALL_ID_RE.test(hallId)) {
    invalid(
      'INVALID_HALL_ID',
      'Hall IDs must be lowercase letters, digits, and hyphens (e.g. "hall-main").',
      { hallId },
    );
  }
  return hallId;
}

/** Validates YYYY-MM-DD and that it is a real calendar date. */
export function validateServiceDate(date: unknown): string {
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    invalid('INVALID_DATE', 'Dates must look like 2026-10-03 (YYYY-MM-DD).', { date });
  }
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== m - 1 || utc.getUTCDate() !== d) {
    invalid('INVALID_DATE', `"${date}" is not a real calendar date.`, { date });
  }
  return date;
}

export function validateMealLabel(meal: unknown): MealLabel {
  const normalized = typeof meal === 'string' ? meal.trim().toLowerCase() : meal;
  if (normalized === 'breakfast' || normalized === 'lunch' || normalized === 'dinner') {
    return normalized;
  }
  invalid('INVALID_MEAL', 'Meal must be Breakfast, Lunch, or Dinner.', { meal });
}

/** Validates an IANA timezone name using the runtime's timezone database. */
export function validateTimezone(tz: unknown): string {
  if (typeof tz !== 'string' || tz.length === 0) {
    invalid('INVALID_TIMEZONE', 'Hall timezone is required (e.g. "America/Detroit").', { tz });
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    invalid('INVALID_TIMEZONE', `"${tz}" is not a recognized timezone name.`, { tz });
  }
  return tz;
}

/**
 * Slugifies a display name for use inside an item ID: lowercase, accents
 * stripped, every run of non-alphanumerics collapsed to one hyphen.
 * "Scrambled Eggs" -> "scrambled-eggs".
 */
export function slugifyName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function makeServiceId(hallId: string, date: string, meal: MealLabel): string {
  return `svc_${hallId}_${date}_${meal}`;
}

export function makeMenuId(hallId: string, date: string, meal: MealLabel): string {
  return `menu_${hallId}_${date}_${meal}`;
}

export function makeItemId(hallId: string, date: string, meal: MealLabel, name: string): string {
  const slug = slugifyName(name);
  if (!slug) {
    invalid('INVALID_ITEM_NAME', 'Menu item names must contain letters or numbers.', { name });
  }
  return `item_${hallId}_${date}_${meal}_${slug}`;
}

export function makeBaselineId(itemId: string, baselineVersion: number): string {
  return `base_${itemId.replace(/^item_/, '')}_v${baselineVersion}`;
}

/**
 * Resolves the hall-local calendar date for a UTC timestamp — the rule for
 * deciding which serviceDate a capture belongs to (contracts: timestamps in
 * UTC, service membership resolved in the hall's timezone).
 */
export function localServiceDate(utcIsoTimestamp: string, hallTimezone: string): string {
  const t = new Date(utcIsoTimestamp);
  if (Number.isNaN(t.getTime())) {
    invalid('INVALID_TIMESTAMP', 'Timestamps must be UTC ISO 8601 strings.', {
      timestamp: utcIsoTimestamp,
    });
  }
  validateTimezone(hallTimezone);
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: hallTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(t);
}
