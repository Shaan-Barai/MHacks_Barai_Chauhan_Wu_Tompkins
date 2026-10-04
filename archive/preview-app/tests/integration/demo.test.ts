import test from 'node:test';
import assert from 'node:assert/strict';
import rawDataset from '../../frontend/demo-data.json';
import type { DemoDataset, DemoService } from '../../contracts/demo.js';
import { filterServices, groupTrend, summarize, demoSuggestion } from '../../analytics/demo.js';
import { datesInRange, defaultSettings, foodName, loadSettings, scheduleForDate, validateSettings } from '../../frontend/helpers.js';

const data = rawDataset as DemoDataset;
const service = (): DemoService => ({ ...structuredClone(data.services[0]), captures: [], attendance: { ...data.services[0].attendance, count: 400 } });
const measurement = (baselineAreaPx: number | null, remainingAreaPx: number, itemId = 'test-1', geometryId = data.geometry.id) => ({ itemId, remainingAreaPx, baselineAreaPx, baselineId: `${itemId}:v1`, geometryId, qualityFlags: [], method: 'demo_ai_estimate' as const, isDemo: true as const });

test('fixture spans exactly seven local dates and 21 unique services, all labeled synthetic', () => {
  assert.equal(data.window.start, '2026-09-27');
  assert.equal(data.window.end, '2026-10-03');
  assert.equal(new Set(data.services.map(row => row.localDate)).size, 7);
  assert.equal(data.services.length, 21);
  assert.equal(new Set(data.services.map(row => row.id)).size, 21);
  const captures = data.services.flatMap(row => row.captures);
  assert.equal(new Set(captures.map(row => row.id)).size, captures.length);
  assert.ok(data.services.every(row => row.isDemo && row.attendance.source === 'simulated' && row.attendance.count >= row.attendance.min && row.attendance.count <= row.attendance.max));
  assert.ok(captures.every(row => row.isDemo && row.source === 'demo_replay'));
});

test('overall waste is area weighted, with hand-calculated denominators', () => {
  const row = service();
  row.items = [{ id: 'test-1', name: 'A', baselineId: 'test-1:v1', baselineAreaPx: 100 }, { id: 'test-2', name: 'B', baselineId: 'test-2:v1', baselineAreaPx: 900 }];
  row.captures = [{ id: 'one', capturedAt: '2026-10-03T12:00:00Z', source: 'demo_replay', status: 'succeeded', emptyPlate: false, isDemo: true, measurements: [measurement(100, 50), measurement(900, 90, 'test-2')] }];
  const summary = summarize([row]);
  assert.equal(summary.remainingAreaPx, 140);
  assert.equal(summary.baselineAreaPx, 1000);
  assert.equal(summary.wastePercent, 14);
  assert.equal(summary.remainingAreaPxPerSimulatedAttendee, 0.35);
});

test('plate average includes clean plates as zero without inventing food servings', () => {
  const row = service();
  row.items = [{ id: 'test-1', name: 'A', baselineId: 'test-1:v1', baselineAreaPx: 100 }, { id: 'test-2', name: 'B', baselineId: 'test-2:v1', baselineAreaPx: 900 }];
  row.captures = [
    { id: 'small', capturedAt: '2026-10-03T12:00:00Z', source: 'demo_replay', status: 'succeeded', emptyPlate: false, isDemo: true, measurements: [measurement(100, 50)] },
    { id: 'large', capturedAt: '2026-10-03T12:01:00Z', source: 'demo_replay', status: 'succeeded', emptyPlate: false, isDemo: true, measurements: [measurement(900, 90, 'test-2')] },
    { id: 'clean', capturedAt: '2026-10-03T12:02:00Z', source: 'demo_replay', status: 'succeeded', emptyPlate: true, isDemo: true, measurements: [] },
  ];
  const result = summarize([row]);
  // Three plates: (50% + 10% + 0%) / 3 = 20%. Serving area is still 140/1000 = 14%.
  assert.equal(result.averagePlateWastePercent, 20);
  assert.equal(result.wastePercent, 14);
  assert.equal(result.averagedPlates, 3);
  assert.equal(result.cleanPlates, 1);
  assert.equal(result.assessedServings, 2);
  assert.equal(result.foods.length, 2);
});

test('failed, review, incomplete, and contradictory plates cannot lower the plate average', () => {
  const row = service();
  row.items = [{ id: 'test-1', name: 'A', baselineId: 'test-1:v1', baselineAreaPx: 100 }];
  const capture = { id: 'one', capturedAt: '2026-10-03T12:00:00Z', source: 'demo_replay' as const, status: 'succeeded' as const, emptyPlate: false, isDemo: true as const, measurements: [measurement(100, 50)] };
  row.captures = [capture,
    { ...capture, id: 'failed', status: 'failed' },
    { ...capture, id: 'review', status: 'needs_review' },
    { ...capture, id: 'unread', measurements: [] },
    { ...capture, id: 'partial', measurements: [measurement(100, 20), measurement(null, 15, 'unknown')] },
    { ...capture, id: 'contradiction', emptyPlate: true },
    { ...capture, id: 'above-baseline', measurements: [measurement(100, 110)] },
  ];
  const result = summarize([row]);
  assert.equal(result.averagePlateWastePercent, 50);
  assert.equal(result.averagedPlates, 1);
  assert.equal(result.excludedPlates, 6);
  assert.equal(result.cleanPlates, 0);
  assert.equal(summarize([]).averagePlateWastePercent, null);
});

test('reporting windows average plates across days instead of averaging daily percentages', () => {
  const first = service();
  first.items = [{ id: 'test-1', name: 'A', baselineId: 'test-1:v1', baselineAreaPx: 100 }];
  const capture = { id: 'one', capturedAt: '2026-10-03T12:00:00Z', source: 'demo_replay' as const, status: 'succeeded' as const, emptyPlate: false, isDemo: true as const, measurements: [measurement(100, 60)] };
  first.captures = [capture];
  const second = { ...first, localDate: '2026-09-28', captures: [1, 2, 3].map(i => ({ ...capture, id: String(i), emptyPlate: true, measurements: [] })) };
  assert.equal(summarize([first, second]).averagePlateWastePercent, 15);
});

test('lookback dates stay daily and inclusive across month boundaries', () => {
  assert.deepEqual(datesInRange('2026-10-03', 1), ['2026-10-03']);
  const dates = datesInRange('2026-10-03', 30);
  assert.equal(dates.length, 30);
  assert.equal(dates[0], '2026-09-04');
  assert.equal(dates.at(-1), '2026-10-03');
  assert.equal(new Set(datesInRange('2026-10-03', 90)).size, 90);
});

test('food labels use menu names and readable legacy slugs without exposing internal IDs', () => {
  const id = 'Item_hall-main_2026-10-03-lunch+margherita-flatbread';
  assert.equal(foodName('Margherita flatbread', id), 'Margherita flatbread');
  assert.equal(foodName(id, id), 'Margherita flatbread');
  assert.equal(foodName(undefined, id), 'Margherita flatbread');
  assert.equal(foodName('Item_hall-main_2026-10-03-lunch+margahertia-flatbread', id), 'Margahertia flatbread');
});

test('weekday/weekend schedules and dated football games resolve the correct hours', () => {
  const settings = defaultSettings('Test Hall');
  assert.equal(validateSettings(settings), null);
  assert.equal(scheduleForDate(settings, '2026-10-02')?.meals[0].start, '07:00');
  assert.equal(scheduleForDate(settings, '2026-10-03')?.meals[0].start, '08:00');
  settings.events.push({ id: 'game', name: 'Football game', date: '2026-10-03', meals: [
    { id: 'lunch', name: 'Lunch', start: '10:00', end: '13:00' },
    { id: 'late', name: 'After game meal', start: '20:00', end: '23:00' },
  ] });
  assert.equal(validateSettings(settings), null);
  assert.equal(scheduleForDate(settings, '2026-10-03')?.isEvent, true);
  assert.equal(scheduleForDate(settings, '2026-10-03')?.meals[1].name, 'After game meal');
  assert.equal(scheduleForDate(settings, '2026-10-04')?.name, 'Weekends');
  const reloaded = loadSettings({ getItem: () => JSON.stringify(settings) }, 'Fallback');
  assert.deepEqual(reloaded, settings);
});

test('settings reject ambiguous days, duplicate events, and invalid or reversed times', () => {
  const settings = defaultSettings('Test Hall');
  settings.schedules[1].days.push(1);
  assert.match(validateSettings(settings)!, /Monday has two/);
  settings.schedules[1].days.pop();
  settings.schedules[0].meals[0].end = '06:00';
  assert.match(validateSettings(settings)!, /finish after/);
  settings.schedules[0].meals[0].end = '10:00';
  settings.events.push({ id: 'bad', name: 'Football', date: '2026-02-30', meals: settings.schedules[0].meals });
  assert.match(validateSettings(settings)!, /valid date/);
  settings.events[0].date = '2026-10-03';
  settings.events.push({ ...settings.events[0], id: 'duplicate' });
  assert.match(validateSettings(settings)!, /one event schedule/);
  assert.deepEqual(loadSettings({ getItem: () => '{damaged' }, 'Fallback'), defaultSettings('Fallback'));
  assert.deepEqual(loadSettings({ getItem: () => '{"hallName":"Test"}' }, 'Fallback'), defaultSettings('Fallback'));
});

test('missing/zero baselines, unknown food, above-baseline and mismatched geometry are excluded', () => {
  const row = service();
  row.items = [{ id: 'test-1', name: 'A', baselineId: 'test-1:v1', baselineAreaPx: 100 }];
  row.captures = [{ id: 'one', capturedAt: '2026-10-03T12:00:00Z', source: 'demo_replay', status: 'succeeded', emptyPlate: false, isDemo: true, measurements: [measurement(null, 30), measurement(0, 30), measurement(100, 30, 'unknown'), measurement(100, 110), measurement(100, 30, 'test-1', 'other-geometry'), measurement(100, Number.NaN), measurement(100, -1)] }];
  const summary = summarize([row]);
  assert.equal(summary.excludedMeasurements, 7);
  assert.equal(summary.wastePercent, null);
  assert.equal(summary.assessedServings, 0);
});

test('failed/review captures and empty plates do not become zero-waste servings', () => {
  const row = service();
  row.items = [{ id: 'test-1', name: 'A', baselineId: 'test-1:v1', baselineAreaPx: 100 }];
  row.captures = ['failed', 'needs_review', 'succeeded'].map((status, index) => ({ id: String(index), capturedAt: '2026-10-03T12:00:00Z', source: 'demo_replay', status: status as 'failed' | 'needs_review' | 'succeeded', emptyPlate: status === 'succeeded', isDemo: true, measurements: status === 'succeeded' ? [] : [measurement(100, 20)] }));
  const summary = summarize([row]);
  assert.equal(summary.capturedDishes, 3);
  assert.equal(summary.successfulAnalyses, 1);
  assert.equal(summary.failedAnalyses, 1);
  assert.equal(summary.reviewAnalyses, 1);
  assert.equal(summary.wastePercent, null);
});

test('zero is valid for an assessed serving; zero or missing attendance is unavailable', () => {
  const row = service();
  row.items = [{ id: 'test-1', name: 'A', baselineId: 'test-1:v1', baselineAreaPx: 100 }];
  row.captures = [{ id: 'one', capturedAt: '2026-10-03T12:00:00Z', source: 'demo_replay', status: 'succeeded', emptyPlate: false, isDemo: true, measurements: [measurement(100, 0)] }];
  row.attendance.count = 0;
  const summary = summarize([row]);
  assert.equal(summary.wastePercent, 0);
  assert.equal(summary.assessedServings, 1);
  assert.equal(summary.remainingAreaPxPerSimulatedAttendee, null);
  assert.equal(summarize([]).wastePercent, null);
});

test('filters isolate hall/date and trend grouping preserves eligible area sums', () => {
  const selected = filterServices(data.services, '2026-10-01', '2026-10-02', data.hall.id);
  assert.equal(selected.length, 6);
  assert.equal(filterServices(data.services, '2026-10-01', '2026-10-02', 'other-hall').length, 0);
  assert.equal(groupTrend(selected).length, 2);
  assert.equal(groupTrend(selected).reduce((sum, point) => sum + point.remainingAreaPx, 0), summarize(selected).remainingAreaPx);
  const anotherGeometry = { ...service(), geometryId: 'different' };
  assert.throws(() => summarize([data.services[0], anotherGeometry]), /grouped separately/);
});

test('fixture includes review/failure/empty/unknown cases; attendance remains stable on reads', () => {
  const before = data.services.map(row => row.attendance.count);
  const summary = summarize(data.services);
  assert.ok(summary.failedAnalyses > 0 && summary.reviewAnalyses > 0 && summary.excludedMeasurements > 0);
  assert.ok(data.services.some(row => row.captures.some(capture => capture.emptyPlate)));
  assert.ok(data.services.some(row => row.captures.some(capture => capture.measurements.some(item => item.itemId === null))));
  summarize(data.services);
  assert.deepEqual(data.services.map(row => row.attendance.count), before);
  assert.ok(demoSuggestion(summary).includes(summary.foods[0].name));
});
