/**
 * Readable fallback when a menu no longer lists an item (for example after a
 * menu edit): "item_hall-main_2026-10-03_lunch_margherita-flatbread" →
 * "Margherita Flatbread". Display only; joins always use the stable itemId.
 */
export function readableItemName(itemId: string): string {
  const slug = itemId.split('_').pop() ?? itemId;
  const words = slug.split(/[-\s]+/).filter(Boolean);
  if (words.length === 0) return itemId;
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}
