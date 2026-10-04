/**
 * D6/D14 (DEBUG-PLAN): a Gemini billing outage is visible on /api/ready, and
 * hidden failed plates stay retryable through the (ingest-token) admin list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, HALL } from './helpers.js';

test('GEMINI_BILLING failure is reported by /api/ready and clears on the next success', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();

  assert.equal((await s.api('GET', '/api/ready')).json.providers.gemini.ok, true);

  s.fixtures['cap_bill_1'] = { status: 'failed', errorCode: 'GEMINI_BILLING' };
  const first = await s.submitCapture('cap_bill_1', await s.uploadImage('cap_bill_1'));
  assert.equal(first.json.event.state, 'failed');

  const ready = await s.api('GET', '/api/ready');
  assert.equal(ready.status, 200, 'outage does not make the service unready (other captures still store)');
  assert.equal(ready.json.providers.gemini.ok, false);
  assert.equal(ready.json.providers.gemini.code, 'GEMINI_BILLING');
  assert.ok(ready.json.providers.gemini.since);

  s.fixtures['cap_bill_2'] = { measurements: [{ itemId: 'item_eggs', remainingAreaPx: 100 }] };
  await s.submitCapture('cap_bill_2', await s.uploadImage('cap_bill_2'));
  assert.equal((await s.api('GET', '/api/ready')).json.providers.gemini.ok, true);
});

test('admin list reports total/truncated and includes hidden failed plates', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  s.fixtures['cap_hid_1'] = { status: 'failed', errorCode: 'GEMINI_BILLING' };
  await s.submitCapture('cap_hid_1', await s.uploadImage('cap_hid_1'));
  await s.api('PUT', '/api/admin/captures/visibility', { eventIds: ['cap_hid_1'], hidden: true });

  const d = (await s.api('GET', '/api/captures/cap_hid_1')).json.event.capturedAt.slice(0, 10);
  const list = await s.api('GET', `/api/admin/captures?start=${d}&end=${d}&hallId=${HALL}`);
  assert.equal(list.json.total, 1);
  assert.equal(list.json.truncated, false);
  assert.equal(list.json.captures[0].hidden, true);
  assert.equal(list.json.captures[0].state, 'failed');
});

test('retryable list includes hidden failed plates and skips healthy ones', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  s.fixtures['cap_r_fail'] = { status: 'failed', errorCode: 'GEMINI_BILLING' };
  s.fixtures['cap_r_ok'] = { measurements: [{ itemId: 'item_eggs', remainingAreaPx: 100 }] };
  await s.submitCapture('cap_r_fail', await s.uploadImage('cap_r_fail'));
  await s.submitCapture('cap_r_ok', await s.uploadImage('cap_r_ok'));
  await s.api('PUT', '/api/admin/captures/visibility', { eventIds: ['cap_r_fail'], hidden: true });

  const w = `start=2026-10-03&end=2026-10-03&hallId=${HALL}`;
  const pub = await s.api('GET', `/api/captures?${w}`);
  assert.ok(!pub.json.some((c: { eventId: string }) => c.eventId === 'cap_r_fail'), 'public list hides it');
  const r = await s.api('GET', `/api/captures/retryable?${w}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.captures, [{ eventId: 'cap_r_fail', state: 'failed', hidden: true }]);
});
