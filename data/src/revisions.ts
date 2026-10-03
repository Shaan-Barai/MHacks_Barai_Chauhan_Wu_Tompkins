/**
 * Safe menu revision behavior (AGENTS.md 2.5 / 5.4).
 *
 * Re-uploading a menu for a hall/date/meal NEVER silently rewrites the
 * stored one: an identical upload is a no-op, and a changed upload becomes a
 * new menuVersion on the same serviceId/menuId. Analysis attempts freeze the
 * menuVersion they used, so historical results keep pointing at the version
 * that was live when they ran.
 */

import { invalid } from './errors.js';
import type { MenuBundle, MenuItem } from './types.js';

export type MenuRevisionPlan =
  | { action: 'create'; bundle: MenuBundle }
  | { action: 'unchanged'; bundle: MenuBundle }
  | { action: 'revise'; bundle: MenuBundle; previousVersion: number };

function itemFingerprint(item: MenuItem): string {
  return JSON.stringify([item.itemId, item.displayName, item.category ?? null, item.description ?? null]);
}

function sameItems(a: readonly MenuItem[], b: readonly MenuItem[]): boolean {
  if (a.length !== b.length) return false;
  const fingerprints = new Set(a.map(itemFingerprint));
  return b.every((item) => fingerprints.has(itemFingerprint(item)));
}

/**
 * Decides what persisting `incoming` should do given the currently stored
 * bundle for the same service (undefined when none exists).
 *
 * - No existing menu        -> create at incoming's version (1 from parsing).
 * - Same items              -> unchanged; keep the stored bundle and version.
 * - Different items         -> revise: same serviceId/menuId, version + 1.
 * - Different service/hall  -> error; that is not a revision of this menu.
 */
export function planMenuRevision(
  existing: MenuBundle | undefined,
  incoming: MenuBundle,
): MenuRevisionPlan {
  if (!existing) {
    return { action: 'create', bundle: incoming };
  }
  const a = existing.service;
  const b = incoming.service;
  if (
    a.serviceId !== b.serviceId ||
    a.menuId !== b.menuId ||
    a.hallId !== b.hallId ||
    a.serviceDate !== b.serviceDate ||
    a.mealLabel !== b.mealLabel
  ) {
    invalid(
      'SERVICE_MISMATCH',
      'This upload is for a different hall, date, or meal than the stored menu — it is not a revision of it.',
      { existingServiceId: a.serviceId, incomingServiceId: b.serviceId },
    );
  }
  if (a.hallTimezone !== b.hallTimezone) {
    invalid(
      'TIMEZONE_MISMATCH',
      'The hall timezone of a stored service cannot change through a menu re-upload.',
      { existing: a.hallTimezone, incoming: b.hallTimezone },
    );
  }
  if (sameItems(existing.items, incoming.items)) {
    return { action: 'unchanged', bundle: existing };
  }
  return {
    action: 'revise',
    previousVersion: a.menuVersion,
    bundle: {
      service: { ...b, menuVersion: a.menuVersion + 1 },
      items: incoming.items,
    },
  };
}
