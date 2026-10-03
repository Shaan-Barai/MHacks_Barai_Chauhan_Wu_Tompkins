import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeService, buildWasteTrend, computeDataVersion } from '../src/aggregates.js';
import type { Attendance, CaptureEvent, FoodMeasurement, MealService } from '../src/contracts.js';

const service: MealService = {
  serviceId: 'svc_hall-main_2026-10-03_lunch',
  hallId: 'hall-main',
  hallTimezone: 'America/Detroit',
  serviceDate: '2026-10-03',
  mealLabel: 'lunch',
  menuId: 'menu_1',
  menuVersion: 1,
};

const attendance: Attendance = {
  hallId: 'hall-main',
  serviceId: service.serviceId,
  serviceDate: '2026-10-03',
  count: 500,
  source: 'simulated',
  configuredMin: 300,
  configuredMax: 1200,
  seed: 'demo',
  generatorVersion: 'attendance-gen-v1',
};

function makeCapture(eventId: string, state: CaptureEvent['state'] = 'succeeded'): CaptureEvent {
  return {
    eventId,
    hallId: 'hall-main',
    serviceId: service.serviceId,
    capturedAt: '2026-10-03T16:00:00Z',
    imageObjectId: `img_${eventId}`,
    geometry: {
      widthPx: 1024,
      heightPx: 1024,
      coordinateSpace: 'topdown-normalized-v1',
    },
    source: 'replay',
    qualityFlags: [],
    state,
  };
}

function makeMeasurement(
  eventId: string,
  itemId: string | null,
  remaining: number,
  baseline?: number,
  flags: FoodMeasurement['qualityFlags'] = ['ai_estimate'],
): FoodMeasurement {
  const m: FoodMeasurement = {
    measurementId: `meas_${eventId}_${itemId ?? 'unk'}`,
    eventId,
    attemptId: `att_${eventId}`,
    itemId,
    remainingAreaPx: remaining,
    method: 'gemini_area_estimate',
    qualityFlags: flags,
  };
  if (baseline !== undefined) {
    m.baselineAreaPx = baseline;
    m.baselineId = `base_${itemId}`;
    m.rawWasteFraction = remaining / baseline;
    m.displayWastePercent = 100 * Math.min(1, Math.max(0, remaining / baseline));
  } else {
    m.unavailableReason = 'missing baseline';
    m.qualityFlags = [...flags, 'missing_baseline'];
  }
  return m;
}

describe('summarizeService', () => {
  it('computes area-weighted overall waste and per-attendee leftover', () => {
    // Hand calc: remaining 14880+20000=34880, baseline 48000+50000=98000
    // overall = 100 * 34880 / 98000 = 35.591... → 35.6
    // per attendee = 34880 / 500 = 69.76
    const summary = summarizeService({
      service,
      attendance,
      menuItems: [
        { itemId: 'item_eggs', menuId: 'menu_1', displayName: 'Scrambled Eggs' },
        { itemId: 'item_toast', menuId: 'menu_1', displayName: 'Toast' },
      ],
      captures: [makeCapture('c1'), makeCapture('c2')],
      measurements: [
        makeMeasurement('c1', 'item_eggs', 14880, 48000),
        makeMeasurement('c2', 'item_toast', 20000, 50000),
      ],
    });

    assert.equal(summary.eligibleMeasurementCount, 2);
    assert.equal(summary.observedRemainingAreaPx, 34880);
    assert.equal(summary.observedBaselineAreaPx, 98000);
    assert.equal(summary.overallWastePercent, 35.6);
    assert.equal(summary.leftoverAreaPerSimulatedAttendee, 69.76);
    assert.equal(summary.items[0]?.itemId, 'item_toast'); // higher remaining first
    assert.equal(summary.items[0]?.displayName, 'Toast');
    assert.equal(summary.items[0]?.wastePercent, 40);
    assert.equal(summary.items[0]?.shareOfMealWastePercent, 57.3);
    assert.equal(summary.labels.attendanceSource, 'simulated');
  });

  it('excludes invalid measurements and does not count them as zero waste', () => {
    const summary = summarizeService({
      service,
      attendance,
      captures: [makeCapture('ok'), makeCapture('fail', 'failed'), makeCapture('ok2')],
      measurements: [
        makeMeasurement('ok', 'item_eggs', 10000, 40000), // eligible: 25%
        makeMeasurement('fail', 'item_eggs', 0, 40000), // capture failed — excluded
        makeMeasurement('ok2', null, 5000, 40000), // unknown — excluded
        makeMeasurement('ok2', 'item_eggs', 50000, 40000, ['ai_estimate', 'above_baseline']),
        makeMeasurement('ok2', 'item_toast', 1000), // missing baseline
      ],
    });

    assert.equal(summary.succeededCaptureCount, 2);
    assert.equal(summary.excludedCaptureCount, 1);
    assert.equal(summary.eligibleMeasurementCount, 1);
    assert.equal(summary.observedRemainingAreaPx, 10000);
    assert.equal(summary.observedBaselineAreaPx, 40000);
    assert.equal(summary.overallWastePercent, 25);
    // failed capture's measurement is not double-counted in measurement exclusions
    assert.equal(summary.exclusionReasons.unknown_item, 1);
    assert.equal(summary.exclusionReasons.above_baseline, 1);
    assert.equal(summary.exclusionReasons.missing_baseline, 1);
    assert.equal(summary.exclusionReasons.capture_not_succeeded, 1);
  });

  it('returns unavailable overall percent when no eligible baselines', () => {
    const summary = summarizeService({
      service,
      captures: [makeCapture('c1')],
      measurements: [makeMeasurement('c1', 'item_eggs', 1000)],
    });
    assert.equal(summary.overallWastePercent, null);
    assert.match(summary.overallWasteUnavailableReason ?? '', /No eligible/);
    assert.equal(summary.leftoverAreaPerSimulatedAttendee, null);
    assert.match(summary.perAttendeeUnavailableReason ?? '', /not been generated/);
  });

  it('returns unavailable per-attendee when attendance is zero', () => {
    const summary = summarizeService({
      service,
      attendance: { ...attendance, count: 0 },
      captures: [makeCapture('c1')],
      measurements: [makeMeasurement('c1', 'item_eggs', 1000, 4000)],
    });
    assert.equal(summary.overallWastePercent, 25);
    assert.equal(summary.leftoverAreaPerSimulatedAttendee, null);
    assert.match(summary.perAttendeeUnavailableReason ?? '', /zero/);
  });

  it('ignores captures from other services', () => {
    const other: CaptureEvent = {
      ...makeCapture('other'),
      serviceId: 'svc_other',
    };
    const summary = summarizeService({
      service,
      captures: [makeCapture('c1'), other],
      measurements: [
        makeMeasurement('c1', 'item_eggs', 1000, 4000),
        makeMeasurement('other', 'item_eggs', 9999, 4000),
      ],
    });
    assert.equal(summary.captureCount, 1);
    assert.equal(summary.observedRemainingAreaPx, 1000);
  });
});

describe('buildWasteTrend', () => {
  it('orders by date then serviceId', () => {
    const a = summarizeService({
      service: { ...service, serviceId: 'svc_b', serviceDate: '2026-10-02', mealLabel: 'dinner' },
      captures: [],
      measurements: [],
    });
    const b = summarizeService({
      service: { ...service, serviceId: 'svc_a', serviceDate: '2026-10-02', mealLabel: 'lunch' },
      captures: [],
      measurements: [],
    });
    const c = summarizeService({
      service: { ...service, serviceDate: '2026-10-03' },
      captures: [],
      measurements: [],
    });
    const trend = buildWasteTrend([c, a, b]);
    assert.deepEqual(
      trend.map((t) => t.serviceId),
      ['svc_a', 'svc_b', service.serviceId],
    );
  });
});

describe('computeDataVersion', () => {
  it('is stable for the same summary and changes when totals change', () => {
    const s1 = summarizeService({
      service,
      attendance,
      captures: [makeCapture('c1')],
      measurements: [makeMeasurement('c1', 'item_eggs', 1000, 4000)],
    });
    const s2 = summarizeService({
      service,
      attendance,
      captures: [makeCapture('c1')],
      measurements: [makeMeasurement('c1', 'item_eggs', 2000, 4000)],
    });
    assert.equal(computeDataVersion(s1), computeDataVersion(s1));
    assert.notEqual(computeDataVersion(s1), computeDataVersion(s2));
  });
});
