/**
 * Production sheets over HTTP: upload a sheet photo, read it (Gemini MOCKED in
 * live mode, so no real call), review, edit, confirm/reject. Rows start
 * unconfirmed with confidence + flags, and the photo's storage path is kept.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GeminiGateway } from '@scrap/vision';
import { startTestServer, type TestServer } from './helpers.js';
import { InMemoryProductionStore, localTimeToUtc, utcToLocalTime } from '../src/repo/productionStore.js';

const HALL = 'hall-main';
const DISHES = [
  { dishId: 'mac-and-cheese', displayName: 'Mac and Cheese', category: 'Comfort', serviceStyle: 'entree', isSimulated: false },
  { dishId: 'sticky-rice', displayName: 'Sticky Rice', category: 'Wok', serviceStyle: 'side', isSimulated: false },
];
const f = (value: unknown, confidence = 0.95) => ({ value, confidence });
const SHEET = {
  readable: true,
  notes: 'Coffee stain over row 2.',
  rows: [
    { dish: f('Mac and Cheese'), station: f('Comfort'), mealLabel: f('lunch'), serviceDate: f('2026-10-20'), preppedLb: f(24), preppedPortions: f(96), panLeftoverLb: f(3.5), ranOutTime: f(null) },
    { dish: f('Stiky rice?', 0.5), station: f('Wok'), mealLabel: f('lunch'), serviceDate: f('2026-10-20'), preppedLb: f(10, 0.6), preppedPortions: f(40), panLeftoverLb: f(12), ranOutTime: f(null) },
    { dish: f('Sticky Rice'), station: f('Wok 2'), mealLabel: f('lunch'), serviceDate: f('2026-10-20'), preppedLb: f(20), preppedPortions: f(80), panLeftoverLb: f(0), ranOutTime: f('12:40') },
  ],
};

function sheetGateway(answer: unknown, calls: { n: number }): GeminiGateway {
  return {
    model: 'test-model',
    mode: 'live',
    callCount: 0,
    async generateStructured() {
      calls.n++;
      return JSON.stringify(answer);
    },
    async generateText() {
      throw new Error('not used');
    },
  } as unknown as GeminiGateway;
}

async function uploadSheet(s: TestServer, id: string): Promise<string> {
  const req = await s.api('POST', '/api/images/uploads', { associationKind: 'production_sheet', associationId: id, mimeType: 'image/png', sizeBytes: 48 });
  assert.equal(req.status, 201, JSON.stringify(req.json));
  assert.match(req.json.objectKey, /^production-sheets\/\d{4}-\d{2}-\d{2}\/sheet_1_[0-9a-f]{12}\.png$/);
  const put = await fetch(`${s.baseUrl}${req.json.uploadUrl}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.from('fake-png-bytes-for-testing-only-0123456789abcdef') });
  assert.equal(put.status, 204);
  assert.equal((await s.api('POST', `/api/images/${req.json.objectId}/finalize`)).status, 200);
  return req.json.objectId;
}

async function server(answer: unknown = SHEET, calls = { n: 0 }) {
  return startTestServer(undefined, { gateway: sheetGateway(answer, calls), productionStore: new InMemoryProductionStore(DISHES) });
}

test('a sheet photo becomes UNCONFIRMED rows with confidence, flags and the photo path; re-reading does not duplicate', async (t) => {
  const calls = { n: 0 };
  const s = await server(SHEET, calls);
  t.after(() => s.close());
  const objectId = await uploadSheet(s, 'sheet_1');
  const res = await s.api('POST', '/api/production-sheets/extract', { objectId, hallId: HALL, serviceDate: '2026-10-20', mealLabel: 'lunch' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.notes, 'Coffee stain over row 2.');
  const [a, b, c] = res.json.rows;
  assert.ok(res.json.rows.every((r: any) => r.status === 'unconfirmed' && r.source === 'sheet_photo' && r.sheetImageObjectId === objectId));
  assert.match(a.sheetPhotoPath, /^production-sheets\//);
  assert.equal(a.dishId, 'mac-and-cheese');
  assert.deepEqual(a.reviewFlags, []);
  assert.equal(b.dishId, null);
  assert.equal(b.dishNameRaw, 'Stiky rice?');
  for (const flag of ['unknown_dish', 'low_confidence:dish', 'low_confidence:preppedLb', 'leftover_exceeds_prepped']) assert.ok(b.reviewFlags.includes(flag), flag);
  assert.deepEqual(b.blockingFlags.sort(), ['leftover_exceeds_prepped', 'unknown_dish']);
  assert.equal(c.ranOutTime, '12:40', 'shown in the hall’s local time');
  assert.equal(c.ranOutAt, '2026-10-20T16:40:00.000Z', 'stored as a UTC instant (EDT = UTC-4)');

  const again = await s.api('POST', '/api/production-sheets/extract', { objectId, hallId: HALL });
  assert.equal(again.json.rows.length, 3);
  assert.equal(calls.n, 1, 'the same photo is not sent to Gemini twice');
  assert.equal((await s.api('GET', `/api/production-log?hallId=${HALL}&status=unconfirmed`)).json.rows.length, 3);
});

test('review: flagged rows cannot be confirmed until fixed; edits recompute flags; confirmed rows are locked', async (t) => {
  const s = await server();
  t.after(() => s.close());
  const objectId = await uploadSheet(s, 'sheet_1');
  const rows = (await s.api('POST', '/api/production-sheets/extract', { objectId, hallId: HALL })).json.rows;
  const b = rows[1];

  const blocked = await s.api('POST', `/api/production-log/${b.productionLogId}/confirm`, { confirmedBy: 'Chef Ana' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, 'PRODUCTION_ROW_NEEDS_FIXES');

  assert.equal((await s.api('PATCH', `/api/production-log/${b.productionLogId}`, { dishId: 'not-a-dish' })).status, 400);
  assert.equal((await s.api('PATCH', `/api/production-log/${b.productionLogId}`, { preppedLb: -1 })).status, 400);
  assert.equal((await s.api('PATCH', `/api/production-log/${b.productionLogId}`, { ranOutTime: '7pm' })).status, 400);

  const fixed = await s.api('PATCH', `/api/production-log/${b.productionLogId}`, { dishId: 'sticky-rice', preppedLb: 14, panLeftoverLb: 1.5 });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
  assert.deepEqual(fixed.json.row.blockingFlags, []);
  assert.equal(fixed.json.row.fieldConfidence.preppedLb, 1, 'an edited field is fully confident');
  assert.equal(fixed.json.row.fieldConfidence.dish, 1);
  assert.ok(!fixed.json.row.reviewFlags.includes('low_confidence:preppedLb'));

  assert.equal((await s.api('POST', `/api/production-log/${b.productionLogId}/confirm`, {})).status, 400, 'who confirmed it is required');
  const ok = await s.api('POST', `/api/production-log/${b.productionLogId}/confirm`, { confirmedBy: 'Chef Ana' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.row.status, 'confirmed');
  assert.equal(ok.json.row.confirmedBy, 'Chef Ana');
  assert.ok(ok.json.row.confirmedAt);
  assert.equal((await s.api('PATCH', `/api/production-log/${b.productionLogId}`, { preppedLb: 99 })).status, 409, 'confirmed rows are locked');

  const rej = await s.api('POST', `/api/production-log/${rows[0].productionLogId}/reject`);
  assert.equal(rej.json.row.status, 'rejected');
  assert.deepEqual((await s.api('GET', `/api/production-log?hallId=${HALL}&status=confirmed`)).json.rows.map((r: any) => r.productionLogId), [b.productionLogId]);
});

test('only one confirmed row per dish x station x meal', async (t) => {
  const twice = { ...SHEET, rows: [SHEET.rows[0], SHEET.rows[0]] };
  const s = await server(twice);
  t.after(() => s.close());
  const objectId = await uploadSheet(s, 'sheet_1');
  const [a, b] = (await s.api('POST', '/api/production-sheets/extract', { objectId, hallId: HALL })).json.rows;
  assert.equal((await s.api('POST', `/api/production-log/${a.productionLogId}/confirm`, { confirmedBy: 'Ana' })).status, 200);
  const dup = await s.api('POST', `/api/production-log/${b.productionLogId}/confirm`, { confirmedBy: 'Ana' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'PRODUCTION_ROW_EXISTS');
});

test('without live Gemini, sheets are not read (and mock text never becomes rows)', async (t) => {
  const s = await startTestServer(undefined, { productionStore: new InMemoryProductionStore(DISHES) });
  t.after(() => s.close());
  const objectId = await uploadSheet(s, 'sheet_1');
  const res = await s.api('POST', '/api/production-sheets/extract', { objectId, hallId: HALL });
  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, 'SHEET_READER_UNAVAILABLE');
  const list = await s.api('GET', `/api/production-log?hallId=${HALL}`);
  assert.deepEqual(list.json, { available: false, rows: [] });
});

test('a photo uploaded for something else cannot be read as a sheet; malformed answers are retryable errors', async (t) => {
  const s = await server('not json at all');
  t.after(() => s.close());
  const capture = await s.uploadImage('evt_x');
  assert.equal((await s.api('POST', '/api/production-sheets/extract', { objectId: capture, hallId: HALL })).status, 404);
  const sheet = await uploadSheet(s, 'sheet_1');
  const bad = await s.api('POST', '/api/production-sheets/extract', { objectId: sheet, hallId: HALL });
  assert.equal(bad.status, 502);
  assert.equal(bad.json.error.code, 'VISION_INVALID_RESPONSE');
  assert.equal(bad.json.error.retryable, true);
  assert.equal((await s.api('GET', `/api/production-log?hallId=${HALL}`)).json.rows.length, 0, 'nothing saved');
});

test('ran-out times convert between hall-local HH:MM and UTC across DST', () => {
  assert.equal(localTimeToUtc('2026-10-20', '12:40', 'America/Detroit'), '2026-10-20T16:40:00.000Z');
  assert.equal(localTimeToUtc('2026-01-15', '12:40', 'America/Detroit'), '2026-01-15T17:40:00.000Z');
  assert.equal(localTimeToUtc('2026-11-01', '18:05', 'America/Detroit'), '2026-11-01T23:05:00.000Z', 'the day DST ends');
  assert.equal(utcToLocalTime('2026-10-20T16:40:00.000Z', 'America/Detroit'), '12:40');
});
