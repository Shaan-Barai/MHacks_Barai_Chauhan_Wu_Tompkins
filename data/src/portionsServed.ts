import type { PortionsServed } from '../../contracts/types.js';
import type { MenuBundle } from './types.js';
import { invalid } from './errors.js';
import { readCsvRecords } from './menuCsv.js';

export const MAX_PORTIONS_SERVED = 4_294_967_295;

/** Snapshot semantics: blank/null counts are absent; a retry replaces rather than increments. */
export function parsePortionsServed(input: unknown, menu: MenuBundle, source: PortionsServed['source'], updatedAt: string): PortionsServed[] {
  if (!input || typeof input !== 'object') invalid('INVALID_PORTIONS', 'Send a meal service, menu version, and item counts.');
  const body = input as Record<string, unknown>;
  if (body.serviceId !== menu.service.serviceId || body.menuVersion !== menu.service.menuVersion) {
    invalid('STALE_PORTIONS_MENU', 'The meal menu changed. Reload it before entering portions served.');
  }
  if (!Array.isArray(body.entries) || body.entries.length > menu.items.length) invalid('INVALID_PORTIONS', 'Send one count at most for each menu item.');
  const allowed = new Set(menu.items.map(i => i.itemId));
  const seen = new Set<string>();
  const result: PortionsServed[] = [];
  for (const raw of body.entries) {
    if (!raw || typeof raw !== 'object') invalid('INVALID_PORTIONS', 'Each count needs a menu item ID.');
    const { itemId, count } = raw as Record<string, unknown>;
    if (typeof itemId !== 'string' || !allowed.has(itemId)) invalid('UNKNOWN_PORTIONS_ITEM', 'A portions row does not match this meal menu.');
    if (seen.has(itemId)) invalid('DUPLICATE_PORTIONS_ITEM', 'Include each menu item only once.');
    seen.add(itemId);
    if (count === null) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > MAX_PORTIONS_SERVED) {
      invalid('INVALID_PORTIONS_COUNT', 'Portions served must be a nonnegative whole number; leave unknown counts blank.');
    }
    const s = menu.service;
    result.push({
      recordId: JSON.stringify([s.serviceId, s.menuVersion, itemId]), hallId: s.hallId,
      serviceId: s.serviceId, serviceDate: s.serviceDate, menuId: s.menuId, menuVersion: s.menuVersion,
      itemId, count, source, updatedAt,
    });
  }
  return result;
}

/** Template identifies the service and version; imported counts cannot drift to a different meal. */
export function parsePortionsCsv(csv: string, menu: MenuBundle, updatedAt: string): PortionsServed[] {
  if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > 1_000_000) invalid('INVALID_PORTIONS_CSV', 'Upload a CSV of at most 1 MB.');
  const rows = readCsvRecords(csv.replace(/^\uFEFF/, ''));
  const header = rows.shift();
  const expected = ['service_id', 'menu_version', 'item_id', 'portions_served'];
  const columns = header?.fields.map(f => f.trim().toLowerCase()) ?? [];
  if (new Set(columns).size !== columns.length || expected.some(c => !columns.includes(c)) || rows.length === 0) {
    invalid('INVALID_PORTIONS_CSV', 'Use the downloaded template: service_id,menu_version,item_id,portions_served.');
  }
  const entries: { itemId: string; count: number | null }[] = [];
  for (const row of rows) {
    if (row.fields.length !== columns.length) invalid('INVALID_PORTIONS_CSV', `Line ${row.line}: unexpected number of columns.`);
    const get = (name: string) => (row.fields[columns.indexOf(name)] ?? '').trim();
    const text = get('portions_served');
    if (get('service_id') !== menu.service.serviceId || !/^\d+$/.test(get('menu_version')) || Number(get('menu_version')) !== menu.service.menuVersion) {
      invalid('STALE_PORTIONS_MENU', `Line ${row.line}: the service or menu version differs. Download a new template.`);
    }
    if (text !== '' && !/^\d+$/.test(text)) invalid('INVALID_PORTIONS_COUNT', `Line ${row.line}: use a nonnegative whole number or leave the count blank.`);
    entries.push({ itemId: get('item_id'), count: text === '' ? null : Number(text) });
  }
  return parsePortionsServed({ serviceId: menu.service.serviceId, menuVersion: menu.service.menuVersion, entries }, menu, 'csv', updatedAt);
}
