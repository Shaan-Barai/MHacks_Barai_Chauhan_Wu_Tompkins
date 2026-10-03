import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, MENU, SERVICE, HALL, GEOMETRY } from './helpers.js';
import { JsonFileRepository } from '../src/repo/jsonFileRepository.js';
import type { FoodMeasurement, PortionsServed } from '../src/types.js';
import type { Analyzer } from '../src/analysis/analyzer.js';

const path = `/api/portions-served?hallId=${HALL}&serviceId=${SERVICE}`;
const input = { serviceId: SERVICE, menuVersion: 1, entries: [{ itemId: 'item_eggs', count: 1000 }, { itemId: 'item_toast', count: 100 }] };

test('manual/CSV portion snapshots survive reads; repeats replace, invalid batches leave counts intact', async t => {
  const s = await startTestServer(); t.after(() => s.close()); await s.seedMenuAndBaselines();
  assert.equal((await s.api('PUT', path, input)).status, 200);
  await s.api('PUT', path, input);
  let saved = await s.api('GET', path);
  assert.equal(saved.json.portions.length, 2);
  assert.equal(saved.json.portions[0].count, 1000);
  assert.equal(saved.json.portions[0].source, 'manual');
  assert.equal((await s.api('PUT', path, { ...input, entries: [{ itemId: 'item_eggs', count: 999 }, { itemId: 'invented', count: 9 }] })).status, 400);
  assert.equal((await s.api('GET', path)).json.portions[0].count, 1000);
  assert.equal((await s.api('PUT', path, { ...input, menuVersion: 2 })).status, 400);
  assert.equal((await s.api('GET', path.replace(`hallId=${HALL}`, 'hallId=another'))).status, 404);
  const csv = `service_id,menu_version,item_id,portions_served\n${SERVICE},1,item_eggs,800\n${SERVICE},1,item_toast,0\n`;
  const imported = await fetch(`${s.baseUrl}/api/portions-served/csv?hallId=${HALL}&serviceId=${SERVICE}`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv });
  assert.equal(imported.status, 200);
  saved = await s.api('GET', path);
  assert.equal(saved.json.portions.find((p: PortionsServed) => p.itemId === 'item_eggs').count, 800);
  assert.equal(saved.json.portions.find((p: PortionsServed) => p.itemId === 'item_toast').count, 0);
  assert.equal(saved.json.portions[0].source, 'csv');
  await s.api('PUT', path, { ...input, entries: [{ itemId: 'item_eggs', count: null }] });
  assert.equal((await s.api('GET', path)).json.portions.length, 0);
});

test('dashboard uses mask pixels/portions, preserves counts without baselines, and invalidates tips after correction', async t => {
  const s = await startTestServer(); t.after(() => s.close()); await s.seedMenuAndBaselines();
  await s.api('PUT', path, input);
  await s.repo.upsertCaptureEvent({ eventId: 'pixel-fixture', hallId: HALL, serviceId: SERVICE, capturedAt: '2026-10-03T16:00:00Z', imageObjectId: 'fixture-image', geometry: GEOMETRY, source: 'replay', qualityFlags: [], state: 'succeeded' });
  const measurements: FoodMeasurement[] = [['item_eggs', 200000], ['item_toast', 100000]].map(([id, pixels]) => ({
    measurementId: `mask-${id}`, eventId: 'pixel-fixture', attemptId: 'attempt-mask', itemId: String(id), remainingAreaPx: Number(pixels),
    method: 'mask_pixel_count', qualityFlags: ['missing_baseline'],
    maskCount: { pixelsWasted: Number(pixels), maskObjectId: `fixture-mask-${id}`, geometry: GEOMETRY,
      menuId: MENU.service.menuId, menuVersion: 1, classificationVersion: 'fixture-v1', segmentationVersion: 'fixture-v1', processingVersion: 'binary-count-v1', assignment: 'exclusive', validated: true },
  }));
  await s.repo.recordAnalysis({ eventId: 'pixel-fixture', attemptId: 'attempt-mask', menuId: MENU.service.menuId, menuVersion: 1, baselineVersions: {}, model: 'fixture', promptVersion: 'fixture', status: 'succeeded', qualityFlags: [], createdAt: '2026-10-03T16:00:01Z' }, measurements);
  const response = await s.api('GET', `/api/dashboard/meal?hallId=${HALL}&date=2026-10-03&meal=lunch`);
  assert.equal(response.status, 200);
  assert.equal(response.json.portionBenchmark.items[0].itemId, 'item_toast');
  assert.equal(response.json.portionBenchmark.items[0].pixelsWastedPerPortion, 1000);
  assert.equal(response.json.insight.metrics.topItemId, 'item_toast');
  assert.equal(response.json.insight.source, 'fallback_rules');
  const version = response.json.insight.dataVersion;
  const repeat = await s.api('GET', `/api/dashboard/meal?hallId=${HALL}&date=2026-10-03&meal=lunch`);
  assert.equal(repeat.json.insight.insightId, response.json.insight.insightId);
  await s.api('PUT', path, { ...input, entries: [{ itemId: 'item_eggs', count: 1000 }, { itemId: 'item_toast', count: 1000 }] });
  const corrected = await s.api('GET', `/api/dashboard/meal?hallId=${HALL}&date=2026-10-03&meal=lunch`);
  assert.notEqual(corrected.json.insight.dataVersion, version);
  assert.equal(corrected.json.insight.metrics.topItemId, 'item_eggs');
  assert.equal(corrected.json.portionBenchmark.items.find((i: { itemId: string }) => i.itemId === 'item_toast').pixelsWastedPerPortion, 100);
});

test('JSON persistence retains portions and menu revision prevents stale denominator reuse', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'scrap-portions-')), 'records.json');
  const repo = new JsonFileRepository(file);
  await repo.upsertMenu(MENU);
  const count: PortionsServed = { recordId: JSON.stringify([SERVICE, 1, 'item_eggs']), hallId: HALL, serviceId: SERVICE, serviceDate: MENU.service.serviceDate,
    menuId: MENU.service.menuId, menuVersion: 1, itemId: 'item_eggs', count: 100, source: 'manual', updatedAt: '2026-10-03T20:00:00Z' };
  await repo.replacePortionsServed(SERVICE, 1, [count]);
  const reloaded = new JsonFileRepository(file);
  assert.deepEqual(await reloaded.listPortionsServed(SERVICE, 1), [count]);
  await reloaded.upsertMenu({ ...MENU, service: { ...MENU.service, menuVersion: 2 } });
  assert.deepEqual(await reloaded.listPortionsServed(SERVICE, 2), []);
  assert.deepEqual(await reloaded.listPortionsServed(SERVICE, 1), [count]);
  await assert.rejects(reloaded.replacePortionsServed(SERVICE, 1, [count]));
});

for (const malformed of [false, true]) {
  test(`ingestion ${malformed ? 'rejects misaligned' : 'persists validated'} mask metadata; optional zero baseline does not gate counting`, async t => {
    const analyzer: Analyzer = { analyze: async ({ event, attemptId, menu }) => ({
      attempt: { eventId: event.eventId, attemptId, menuId: menu.service.menuId, menuVersion: menu.service.menuVersion,
        baselineVersions: {}, model: 'synthetic-mask-fixture', promptVersion: 'fixture-v1', status: 'succeeded', qualityFlags: [], createdAt: '2026-10-03T16:00:01Z' },
      measurements: [{ measurementId: `mask-${event.eventId}`, eventId: event.eventId, attemptId, itemId: 'item_eggs', remainingAreaPx: 100,
        method: 'mask_pixel_count', baselineAreaPx: 0, qualityFlags: [],
        maskCount: { pixelsWasted: 100, maskObjectId: 'synthetic-external-mask', geometry: { ...GEOMETRY, widthPx: malformed ? 10 : GEOMETRY.widthPx },
          menuId: menu.service.menuId, menuVersion: menu.service.menuVersion, classificationVersion: 'fixture-v1', segmentationVersion: 'fixture-v1', processingVersion: 'exclusive-count-v1', assignment: 'exclusive', validated: true } }],
    }) };
    const s = await startTestServer(analyzer); t.after(() => s.close()); await s.seedMenuAndBaselines();
    await s.api('PUT', path, input);
    const image = await s.uploadImage('mask-ingestion');
    const captured = await s.submitCapture('mask-ingestion', image);
    assert.equal(captured.json.event.state, malformed ? 'failed' : 'succeeded');
    const benchmark = await s.api('GET', `/api/portions-served/benchmark?hallId=${HALL}&serviceId=${SERVICE}`);
    const item = benchmark.json.items.find((i: { itemId: string }) => i.itemId === 'item_eggs');
    assert.equal(item.pixelsWastedPerPortion, malformed ? null : 0.1);
    if (!malformed) assert.equal(captured.json.measurements[0].baselineAreaPx, undefined);
  });
}
