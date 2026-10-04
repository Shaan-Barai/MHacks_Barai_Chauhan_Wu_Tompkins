/**
 * Sample history (DEMO_SEED): flagged everywhere, never touches real
 * services, feeds the dashboard (labeled), and clears completely.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoService, zonedToUtc } from '../src/services/demoService.js';
import { HALL, MENU, startTestServer } from './helpers.js';

const END = '2026-10-03';

test('14 days of sample scans: flagged, labeled on the dashboard, totals = sum of rows', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines(); // the real 2026-10-03 lunch menu
  const demo = new DemoService(s.repo);

  const result = await demo.seedHistory({ hallId: HALL, endDate: END, days: 14 });
  assert.equal(result.services, 14 * 3 - 1, 'every slot except the real lunch');
  assert.deepEqual(result.skippedSlots, ['2026-10-03 lunch']);
  assert.ok(result.captures > 14 * 3 * 4);

  // Real menu untouched; sample services are separate and labeled.
  assert.deepEqual(await s.repo.getMenuByService(MENU.service.serviceId), MENU);
  const services = await s.repo.listServices(HALL);
  const sample = services.filter((x) => x.serviceId.startsWith('svc_demo_'));
  assert.equal(sample.length, result.services);
  const captures = (await s.repo.listCaptureEvents({ hallId: HALL })).filter((c) => c.serviceId.startsWith('svc_demo_'));
  assert.ok(captures.every((c) => c.source === 'demo' && c.state === 'succeeded' && c.imageObjectId === 'demo:none'));
  assert.equal((await s.repo.getScanInfo(captures[0]!.eventId))?.demo, true);
  const portions = await s.repo.listPortionsServed(sample[0]!.serviceId, 1);
  assert.ok(portions.length > 0 && portions.every((p) => p.source === 'demo'));

  // The dashboard counts them, labels them, and its total is the sum of the rows.
  let rowSum = 0;
  for (const c of captures) for (const m of await s.repo.listMeasurementsByEvent(c.eventId)) rowSum += m.remainingAreaPx;
  const dash = await s.api('GET', `/api/dashboard/impact?hallId=${HALL}&start=2026-09-20&end=${END}`);
  assert.equal(dash.status, 200);
  assert.equal(dash.json.totals.pixels, rowSum);
  assert.equal(dash.json.totals.analyzedCaptures, captures.length);
  assert.equal(dash.json.labels.sampleData, true);
  assert.equal(dash.json.coverage.sampleCaptures, captures.length);
  assert.equal(dash.json.labels.demoPortions, true);
  assert.ok(dash.json.targets.length > 0, 'per-portion ranking has foods');

  // Seeding again adds nothing (slots are filled).
  const again = await demo.seedHistory({ hallId: HALL, endDate: END, days: 14 });
  assert.equal(again.captures, 0);

  // One command removes every sample row and nothing else.
  const cleared = await demo.clear();
  assert.ok(cleared.removedRows > result.captures);
  assert.deepEqual((await s.repo.listServices(HALL)).map((x) => x.serviceId), [MENU.service.serviceId]);
  assert.equal((await s.repo.listCaptureEvents({ hallId: HALL })).filter((c) => c.source === 'demo').length, 0);
  assert.equal(await s.repo.getScanInfo(captures[0]!.eventId), undefined);
  const after = await s.api('GET', `/api/dashboard/impact?hallId=${HALL}&start=2026-09-20&end=${END}`);
  assert.equal(after.json.labels.sampleData, false);
  assert.equal(after.json.totals.pixels, 0);
});

test('sample history is deterministic and trends down', async (t) => {
  const s1 = await startTestServer();
  const s2 = await startTestServer();
  t.after(() => Promise.all([s1.close(), s2.close()]));
  await new DemoService(s1.repo).seedHistory({ hallId: HALL, endDate: END, days: 14 });
  await new DemoService(s2.repo).seedHistory({ hallId: HALL, endDate: END, days: 14 });
  const pixels = async (s: typeof s1, date: string) => {
    let sum = 0;
    for (const c of await s.repo.listCaptureEvents({ hallId: HALL })) {
      if (!c.serviceId.includes(date)) continue;
      for (const m of await s.repo.listMeasurementsByEvent(c.eventId)) sum += m.remainingAreaPx;
    }
    return sum;
  };
  assert.equal(await pixels(s1, '2026-09-25'), await pixels(s2, '2026-09-25'));
  let first = 0;
  let last = 0;
  for (const d of ['2026-09-20', '2026-09-21', '2026-09-22']) first += await pixels(s1, d);
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) last += await pixels(s1, d);
  assert.ok(last < first, `waste trends down (${first} → ${last})`);
});

test('meal times are hall-local, including across DST', () => {
  assert.equal(zonedToUtc('2026-10-03', '17:30', 'America/Detroit').toISOString(), '2026-10-03T21:30:00.000Z');
  assert.equal(zonedToUtc('2026-12-03', '17:30', 'America/Detroit').toISOString(), '2026-12-03T22:30:00.000Z');
});

test('GET /api/dashboard/totals: today, week (Mon-today), month (1st-today) equal the sum of their scan rows', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await new DemoService(s.repo).seedHistory({ hallId: HALL, endDate: END, days: 14 });
  const res = await s.api('GET', `/api/dashboard/totals?hallId=${HALL}&today=${END}`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  // 2026-10-03 is a Saturday: the week starts Monday 2026-09-28.
  assert.deepEqual([res.json.week.start, res.json.month.start], ['2026-09-28', '2026-10-01']);
  const rowSum = async (start: string, end: string) => {
    let sum = 0;
    let plates = 0;
    for (const svc of await s.repo.listServices(HALL)) {
      if (svc.serviceDate < start || svc.serviceDate > end) continue;
      for (const c of await s.repo.listCaptureEvents({ serviceId: svc.serviceId })) {
        plates++;
        for (const m of await s.repo.listMeasurementsByEvent(c.eventId)) sum += m.remainingAreaPx;
      }
    }
    return { sum, plates };
  };
  for (const period of ['today', 'week', 'month'] as const) {
    const p = res.json[period];
    const expected = await rowSum(p.start, p.end);
    assert.equal(p.pixels, expected.sum, period);
    assert.equal(p.analyzedCaptures, expected.plates, period);
    assert.equal(p.sampleCaptures, expected.plates, period);
    // Sample scans have no calibration, so no estimates (null, never 0).
    assert.equal(p.estimated, null, period);
  }
  // Here the week (Sep 28-Oct 3) is longer than the month so far (Oct 1-3).
  assert.ok(res.json.today.pixels <= res.json.month.pixels && res.json.month.pixels <= res.json.week.pixels);
  assert.equal((await s.api('GET', `/api/dashboard/totals?hallId=${HALL}&today=nope`)).status, 400);
});
