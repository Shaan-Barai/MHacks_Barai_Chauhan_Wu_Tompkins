/**
 * Dashboard summary arithmetic per AGENTS.md §7, checked against a
 * hand-calculated example.
 *
 * HAND CALCULATION
 * ----------------
 * Baselines: eggs = 48,000 px, toast = 30,000 px (mystery stew: none).
 *
 * Captures and their counted measurements:
 *   ev1  eggs   remaining 12,000  (fraction 12000/48000 = 0.25)   ELIGIBLE
 *   ev2  eggs   remaining 24,000  (fraction 24000/48000 = 0.50)   ELIGIBLE
 *        toast  remaining  9,000  (fraction  9000/30000 = 0.30)   ELIGIBLE
 *   ev3  eggs   remaining 60,000  (fraction 60000/48000 = 1.25)   EXCLUDED above_baseline
 *   ev4  null   remaining  5,000  (unknown/non-menu food)         EXCLUDED unknown item
 *   ev5  stew   remaining  7,000  (no baseline exists)            EXCLUDED missing baseline
 *   ev6  analysis failed                                          EXCLUDED failed capture
 *
 * Eligible sums:
 *   sum(remaining) = 12,000 + 24,000 + 9,000           = 45,000 px
 *   sum(baseline)  = 48,000 + 48,000 + 30,000          = 126,000 px
 *   overall_waste_percent = 100 * 45,000 / 126,000     = 35.714285…%
 *
 * This is AREA-WEIGHTED. The naive mean of item percentages would be
 *   eggs  = 100 * 36,000/96,000 = 37.5%
 *   toast = 100 *  9,000/30,000 = 30.0%
 *   mean(37.5, 30.0) = 33.75%  — deliberately NOT the reported metric.
 *
 * Exclusion counts (all visible, never zero waste):
 *   aboveBaseline = 1, unknownItem = 1, missingBaseline = 1, failedCaptures = 1.
 *
 * Attendance (simulated) = 742:
 *   per-attendee = 45,000 / 742 = 60.6469… px/attendee.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, HALL, SERVICE } from './helpers.js';

test('§7 summary: area-weighted overall percent, per-item breakdown, visible exclusions', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();

  s.fixtures['ev1'] = { measurements: [{ itemId: 'item_eggs', remainingAreaPx: 12000 }] };
  s.fixtures['ev2'] = {
    measurements: [
      { itemId: 'item_eggs', remainingAreaPx: 24000 },
      { itemId: 'item_toast', remainingAreaPx: 9000 },
    ],
  };
  s.fixtures['ev3'] = { measurements: [{ itemId: 'item_eggs', remainingAreaPx: 60000 }] }; // above baseline
  s.fixtures['ev4'] = { measurements: [{ itemId: null, remainingAreaPx: 5000 }] }; // unknown food
  s.fixtures['ev5'] = { measurements: [{ itemId: 'item_mystery', remainingAreaPx: 7000 }] }; // no baseline
  s.fixtures['ev6'] = { status: 'failed' };

  for (const eventId of ['ev1', 'ev2', 'ev3', 'ev4', 'ev5', 'ev6']) {
    const objectId = await s.uploadImage(eventId);
    await s.submitCapture(eventId, objectId);
  }
  await s.api('PUT', '/api/attendance', {
    hallId: HALL,
    serviceId: SERVICE,
    serviceDate: '2026-10-03',
    count: 742,
    source: 'simulated',
    configuredMin: 300,
    configuredMax: 1200,
    seed: 'demo-seed-1',
    generatorVersion: 'attendance-gen-v1',
  });

  const res = await s.api('GET', `/api/dashboard/summary?hallId=${HALL}&serviceId=${SERVICE}`);
  assert.equal(res.status, 200);
  const sum = res.json;

  // Totals (hand calculation above).
  assert.equal(sum.totals.capturedDishes, 6);
  assert.equal(sum.totals.analyzedDishes, 5);
  assert.equal(sum.totals.eligibleMeasurements, 3);
  assert.equal(sum.totals.observedRemainingAreaPx, 45000);
  assert.equal(sum.totals.baselineAreaPx, 126000);
  assert.ok(Math.abs(sum.totals.overallWastePercent - (100 * 45000) / 126000) < 1e-9);
  assert.ok(Math.abs(sum.totals.overallWastePercent - 35.714285714285715) < 1e-9);
  // Area-weighted, not the 33.75% naive mean of item percentages.
  assert.ok(Math.abs(sum.totals.overallWastePercent - 33.75) > 1);
  assert.equal(sum.totals.unknownItemRemainingAreaPx, 5000);

  // Exclusions are counted and visible — never reported as zero waste.
  assert.equal(sum.exclusions.aboveBaselineMeasurements, 1);
  assert.equal(sum.exclusions.unknownItemMeasurements, 1);
  assert.equal(sum.exclusions.missingBaselineMeasurements, 1);
  assert.equal(sum.exclusions.failedCaptures, 1);
  assert.equal(sum.exclusions.invalidValueMeasurements, 0);

  // Per-item breakdown (area-weighted per item), sorted by remaining area.
  assert.deepEqual(
    sum.perItem.map((i: any) => ({ itemId: i.itemId, remaining: i.remainingAreaPx, pct: i.wastePercent })),
    [
      { itemId: 'item_eggs', remaining: 36000, pct: 37.5 },
      { itemId: 'item_toast', remaining: 9000, pct: 30 },
    ],
  );
  assert.equal(sum.perItem[0].servings, 2);

  // Attendance normalization, clearly simulated.
  assert.equal(sum.attendance.count, 742);
  assert.equal(sum.attendance.source, 'simulated');
  assert.ok(Math.abs(sum.attendance.observedRemainingAreaPxPerAttendee - 45000 / 742) < 1e-9);
  assert.match(sum.labels.attendanceSource, /simulated/);
  assert.match(sum.labels.measurementMethod, /AI estimate/);
});

test('zero eligible baselines => overall percent unavailable with a reason, never zero', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();

  // Only a failed capture and an unknown-food capture exist.
  s.fixtures['evA'] = { status: 'failed' };
  s.fixtures['evB'] = { measurements: [{ itemId: null, remainingAreaPx: 5000 }] };
  for (const eventId of ['evA', 'evB']) {
    const objectId = await s.uploadImage(eventId);
    await s.submitCapture(eventId, objectId);
  }

  const res = await s.api('GET', `/api/dashboard/summary?hallId=${HALL}&serviceId=${SERVICE}`);
  assert.equal(res.json.totals.overallWastePercent, null);
  assert.equal(res.json.totals.overallUnavailableReason, 'no_eligible_baselines');
  assert.equal(res.json.exclusions.failedCaptures, 1);
  assert.equal(res.json.exclusions.unknownItemMeasurements, 1);
  // Attendance missing => per-attendee unavailable, not zero.
  assert.equal(res.json.attendance.observedRemainingAreaPxPerAttendee, null);
  assert.equal(res.json.attendance.unavailableReason, 'attendance_missing');
});
