/**
 * Display names for menu item ids across menu revisions.
 *
 * An analysis attempt freezes the menu version it used. After a revision the
 * service's current menu may no longer list an item an older capture counted,
 * so a name is resolved in order from: the current menu, any stored menu_item
 * row with that stable itemId, and finally a humanized slug of the id
 * (analytics `readableItemName`, e.g. "...dinner_jasmine-rice" -> "Jasmine Rice").
 * Display only: joins always use the itemId.
 */

import { readableItemName, UNKNOWN_FOOD_LABEL } from '@scrap/analytics';
import type { Repository } from '../repo/repository.js';
import type { MenuBundle, MenuItem } from '../types.js';

export class ItemNameResolver {
  constructor(private readonly repo: Repository) {}

  /**
   * MenuItem for every id in `itemIds`: the current menu's row, else a stored
   * row, else a synthetic row on the service's menu with a humanized name.
   * Only call it with ids validated against this service's menu at analysis
   * time (measurements, mask regions), never with arbitrary input.
   */
  async items(menu: MenuBundle | undefined, itemIds: Iterable<string | null>): Promise<Map<string, MenuItem>> {
    const out = new Map<string, MenuItem>((menu?.items ?? []).map((i) => [i.itemId, i]));
    for (const id of itemIds) {
      if (id === null || out.has(id)) continue;
      const stored = await this.repo.getMenuItem(id);
      out.set(id, stored ?? { itemId: id, menuId: menu?.service.menuId ?? '', displayName: readableItemName(id) });
    }
    return out;
  }

  /** Name lookup function over `items(...)`; null itemId is the unknown-food bucket. */
  async nameOf(menu: MenuBundle | undefined, itemIds: Iterable<string | null>): Promise<(itemId: string | null) => string> {
    const items = await this.items(menu, itemIds);
    return (itemId) => (itemId === null ? UNKNOWN_FOOD_LABEL : items.get(itemId)?.displayName ?? readableItemName(itemId));
  }
}
