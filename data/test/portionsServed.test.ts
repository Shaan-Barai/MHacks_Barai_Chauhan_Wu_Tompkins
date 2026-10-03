import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuBundle, parsePortionsServed, parsePortionsCsv } from '../src/index.js';

const menu = buildMenuBundle('hall', 'America/Detroit', '2026-10-03', 'lunch', ['Soup', 'Rice']);
const itemId = menu.items[0]!.itemId;
const input = { serviceId: menu.service.serviceId, menuVersion: 1, entries: [{ itemId, count: 400 }] };
const now = '2026-10-03T20:00:00.000Z';

test('counts are full-service snapshots with provenance and explicit null versus zero', () => {
  const [record] = parsePortionsServed(input, menu, 'manual', now);
  assert.equal(record!.count, 400);
  assert.equal(record!.serviceDate, menu.service.serviceDate);
  assert.equal(record!.source, 'manual');
  assert.equal(record!.updatedAt, now);
  assert.equal(parsePortionsServed({ ...input, entries: [{ itemId, count: null }] }, menu, 'manual', now).length, 0);
  assert.equal(parsePortionsServed({ ...input, entries: [{ itemId, count: 0 }] }, menu, 'manual', now)[0]!.count, 0);
});

test('invalid counts, unknown/duplicate items and old menus fail before persistence', () => {
  for (const count of [-1, 0.5, Infinity, NaN, 4294967296, '100', undefined]) {
    assert.throws(() => parsePortionsServed({ ...input, entries: [{ itemId, count }] }, menu, 'manual', now));
  }
  assert.throws(() => parsePortionsServed({ ...input, menuVersion: 2 }, menu, 'manual', now));
  assert.throws(() => parsePortionsServed({ ...input, entries: [{ itemId: 'unknown', count: 2 }] }, menu, 'manual', now));
  assert.throws(() => parsePortionsServed({ ...input, entries: [...input.entries, ...input.entries] }, menu, 'manual', now));
});

test('CSV accepts quoting and blank counts and binds each row to a service/version', () => {
  const csv = `service_id,menu_version,item_id,portions_served\r\n"${menu.service.serviceId}",1,${itemId},400\r\n${menu.service.serviceId},1,${menu.items[1]!.itemId},\r\n`;
  const rows = parsePortionsCsv(csv, menu, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, 'csv');
  assert.equal(rows[0]!.count, 400);
  assert.throws(() => parsePortionsCsv(csv.replace(',1,', ',2,'), menu, now));
  assert.throws(() => parsePortionsCsv(csv.replace(',400', ',-1'), menu, now));
  assert.throws(() => parsePortionsCsv(csv.replace(',400', ',400,extra'), menu, now));
});
