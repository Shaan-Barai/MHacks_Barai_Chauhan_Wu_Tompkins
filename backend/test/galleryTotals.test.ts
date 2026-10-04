/** D2: the plate gallery must apply the same validity rule as the totals. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, MENU, SERVICE, HALL, GEOMETRY } from './helpers.js';
import type { FoodMeasurement } from '../src/types.js';

const WINDOW = `start=2026-10-03&end=2026-10-03&hallId=${HALL}`;

test('a plate whose pixels the totals exclude is "not counted" in the gallery, never counted pixels', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.seedMenuAndBaselines();
  const eventId = 'plate-nomask';
  await s.repo.upsertCaptureEvent({ eventId, hallId: HALL, serviceId: SERVICE, capturedAt: '2026-10-03T16:00:00Z', imageObjectId: 'img', geometry: GEOMETRY, source: 'camera', qualityFlags: [], state: 'succeeded' });
  // Complete segmentation, but the measurement carries no maskCount provenance.
  const measurements: FoodMeasurement[] = [{ measurementId: `${eventId}-0`, eventId, attemptId: 'att', itemId: 'item_toast', remainingAreaPx: 800, method: 'mask_pixel_count', qualityFlags: [] }];
  await s.repo.recordAnalysis({ eventId, attemptId: 'att', menuId: MENU.service.menuId, menuVersion: 1, baselineVersions: {}, model: 'fixture', promptVersion: 'fixture', status: 'succeeded', qualityFlags: [], createdAt: '2026-10-03T16:01:00Z',
    segmentation: { model: 'fixture', checkpoint: 'fixture', codeRevision: 'fixture', promptSource: 'gemini_box', settingsVersion: 'fixture', countingRuleVersion: 'union-v1', status: 'succeeded', countStatus: 'complete', capturePixelsWasted: 800, widthPx: GEOMETRY.widthPx, heightPx: GEOMETRY.heightPx, regions: [] } }, measurements);

  const impact = await s.api('GET', `/api/dashboard/impact?${WINDOW}`);
  assert.equal(impact.json.totals.pixels, 0);
  const list = (await s.api('GET', `/api/captures?${WINDOW}`)).json;
  assert.equal(list.length, 1);
  assert.equal(list[0].pixelsWasted, null, 'gallery must not show pixels the totals drop');
  assert.match(list[0].notCountedReason, /provenance|validated/i);
});
