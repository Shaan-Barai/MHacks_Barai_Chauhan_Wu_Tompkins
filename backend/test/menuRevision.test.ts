/**
 * Menu revisions (BIG-PLAN v2 V4): a capture analyzed against menu v1 keeps
 * its item names, counts and v1 portions after the service is revised to v2
 * (which drops one of its items), and a save older than the stored version is
 * a non-retryable 409. Offline: mock analyzer, in-memory repo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './helpers.js';
import { ItemNameResolver } from '../src/services/itemNames.js';
import type { Repository } from '../src/repo/repository.js';
import type { MenuBundle } from '../src/types.js';

const HALL = 'hall-rev';
const DATE = '2026-10-03';
const SERVICE = `svc_${HALL}_${DATE}_dinner`;
const MENU_ID = `menu_${HALL}_${DATE}_dinner`;
const RICE = `item_${HALL}_${DATE}_dinner_jasmine-rice`;
const HAM = `item_${HALL}_${DATE}_dinner_baked-boneless-ham`;
const STEW = `item_${HALL}_${DATE}_dinner_beef-stew`;
const GEOMETRY = { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' as const };

const service = (menuVersion: number) => ({
  serviceId: SERVICE, hallId: HALL, hallTimezone: 'America/Detroit', serviceDate: DATE, mealLabel: 'dinner' as const, menuId: MENU_ID, menuVersion,
});
const V1: MenuBundle = {
  service: service(1),
  items: [
    { itemId: RICE, menuId: MENU_ID, displayName: 'Steamed Jasmine Rice' },
    { itemId: HAM, menuId: MENU_ID, displayName: 'Baked Boneless Ham' },
  ],
};
const V2: MenuBundle = {
  service: service(2),
  items: [
    { itemId: HAM, menuId: MENU_ID, displayName: 'Baked Boneless Ham' },
    { itemId: STEW, menuId: MENU_ID, displayName: 'Beef Stew' },
  ],
};

async function revisedAfterCapture(): Promise<TestServer> {
  const s = await startTestServer();
  assert.equal((await s.api('POST', '/api/menus', V1)).status, 201);
  s.fixtures.cap_old = { measurements: [{ itemId: RICE, remainingAreaPx: 3000 }, { itemId: HAM, remainingAreaPx: 1000 }] };
  const imageObjectId = await s.uploadImage('cap_old');
  const cap = await s.api('POST', '/api/captures', {
    eventId: 'cap_old', hallId: HALL, serviceId: SERVICE, capturedAt: `${DATE}T23:00:00.000Z`, imageObjectId, geometry: GEOMETRY, source: 'camera',
  });
  assert.equal(cap.status, 201, JSON.stringify(cap.json));
  const put = await s.api('PUT', `/api/portions-served?hallId=${HALL}&serviceId=${SERVICE}`, {
    serviceId: SERVICE, menuVersion: 1, entries: [{ itemId: RICE, count: 10 }, { itemId: HAM, count: 20 }],
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal((await s.api('POST', '/api/menus', V2)).status, 201, 'revision to v2 drops the rice');
  return s;
}

test('after a revision, old captures keep their names (never the raw item id), counts and v1 portions', async (t) => {
  const s = await revisedAfterCapture();
  t.after(() => s.close());

  const list = await s.api('GET', `/api/captures?start=${DATE}&end=${DATE}`);
  assert.equal(list.status, 200, JSON.stringify(list.json));
  const names = Object.fromEntries(list.json[0].items.map((i: any) => [i.itemId, i.displayName]));
  assert.deepEqual(names, { [RICE]: 'Steamed Jasmine Rice', [HAM]: 'Baked Boneless Ham' });

  const images = await s.api('GET', '/api/captures/cap_old/images');
  assert.equal(images.status, 200, JSON.stringify(images.json));
  assert.deepEqual(images.json.masks.map((m: any) => m.displayName).sort(), ['Baked Boneless Ham', 'Steamed Jasmine Rice']);

  const d = (await s.api('GET', `/api/dashboard/impact?start=${DATE}&end=${DATE}&hallId=${HALL}`)).json;
  assert.equal(d.totals.analyzedCaptures, 1, 'the v1 capture still counts after the revision');
  assert.equal(d.totals.pixels, 4000);
  const rice = d.mostWasted.find((r: any) => r.itemId === RICE);
  assert.equal(rice.displayName, 'Steamed Jasmine Rice');
  assert.equal(rice.portionsServed, 10, 'paired with the v1 portions snapshot');
  assert.equal(rice.perPortion.pixels, 300);
  const ham = d.mostWasted.find((r: any) => r.itemId === HAM);
  assert.equal(ham.perPortion.pixels, 50); // 1000 px / 20 portions (v1)
  for (const row of [...d.mostWasted, ...d.targets]) assert.doesNotMatch(row.displayName, /^item_/);
});

test('POST /api/menus with a version older than the stored one is a non-retryable 409', async (t) => {
  const s = await revisedAfterCapture();
  t.after(() => s.close());
  const res = await s.api('POST', '/api/menus', V1);
  assert.equal(res.status, 409, JSON.stringify(res.json));
  assert.equal(res.json.error.code, 'MENU_VERSION_CONFLICT');
  assert.equal(res.json.error.retryable, false);
  assert.match(res.json.error.message, /newer version/);
  assert.equal((await s.api('GET', `/api/menus?hallId=${HALL}&date=${DATE}`)).json.menus[0].service.menuVersion, 2, 'stored menu unchanged');
});

test('ItemNameResolver: current menu, then a stored row, then a humanized id', async () => {
  const stored = { itemId: 'item_h_2026-10-01_dinner_old-soup', menuId: 'menu_h', displayName: 'Old Soup (v1)' };
  const repo = { getMenuItem: async (id: string) => (id === stored.itemId ? stored : undefined) } as unknown as Repository;
  const menu: MenuBundle = { service: { ...service(2), menuId: 'menu_h' }, items: [{ itemId: 'item_x', menuId: 'menu_h', displayName: 'Current' }] };
  const nameOf = await new ItemNameResolver(repo).nameOf(menu, ['item_x', stored.itemId, 'item_h_2026-10-01_dinner_jasmine-rice', null]);
  assert.equal(nameOf('item_x'), 'Current');
  assert.equal(nameOf(stored.itemId), 'Old Soup (v1)');
  assert.equal(nameOf('item_h_2026-10-01_dinner_jasmine-rice'), 'Jasmine Rice');
  assert.equal(nameOf(null), 'Food not on the menu');
});
