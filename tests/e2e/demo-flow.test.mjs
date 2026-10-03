import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Live end-to-end demo flow against a RUNNING stack (backend + SpacetimeDB,
 * live Gemini when GEMINI_API_KEY is set on the backend). Skipped unless
 * SCRAP_E2E=1 so CI never claims a live path from fixtures alone.
 *
 *   SCRAP_E2E=1 [API_URL=http://localhost:8787] npm run test:e2e
 *
 * Uses its own hall id per run (hall-e2e-<timestamp>) so it never touches the
 * demo hall's numbers. Restart persistence is a manual check (docs/runbook.md).
 */
const LIVE_E2E = process.env.SCRAP_E2E === '1';
const API = (process.env.API_URL ?? 'http://localhost:8787').replace(/\/$/, '');

const RUN = Date.now().toString(36);
const HALL = `hall-e2e-${RUN}`;
const DATE = '2026-10-03';
const SERVICE = `svc_${HALL}_${DATE}_dinner`;
const EVENT = `cap_e2e_${RUN}`;
const IMAGE = fileURLToPath(
  new URL('../../capture/fixtures/replay/images/dinner-1003-salmon-rice.jpg', import.meta.url),
);
const GEOMETRY = { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1', plateShape: 'round' };

async function api(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof Uint8Array) init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(new URL(path, `${API}/`), init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

describe('demo flow e2e (live stack)', { skip: !LIVE_E2E }, () => {
  let menu;

  before(async () => {
    const health = await api('GET', '/api/health');
    assert.equal(health.status, 200, `backend not reachable at ${API}`);
  });

  it('uploads a menu through the validated upload path and retrieves it by hall/date/service', async () => {
    const up = await api('POST', '/api/menus/upload', {
      hallId: HALL,
      hallTimezone: 'America/Detroit',
      days: [{ date: DATE, dinner: ['Teriyaki Salmon', 'Jasmine Rice', 'Roasted Zucchini'] }],
    });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const got = await api('GET', `/api/menus/by-service/${SERVICE}`);
    assert.equal(got.status, 200);
    menu = got.body.menu;
    assert.equal(menu.items.length, 3);

    // Re-uploading identical items is not a new revision.
    const again = await api('POST', '/api/menus/upload', {
      hallId: HALL,
      hallTimezone: 'America/Detroit',
      days: [{ date: DATE, dinner: ['Teriyaki Salmon', 'Jasmine Rice', 'Roasted Zucchini'] }],
    });
    assert.equal(again.body.results[0].action, 'unchanged');
  });

  it('stores reference portions for the menu items', async () => {
    for (const item of menu.items) {
      const res = await api('POST', '/api/reference-portions', {
        baselineId: `base_${item.itemId}_v1`,
        baselineVersion: 1,
        itemId: item.itemId,
        expectedAreaPx: 60000,
        geometry: GEOMETRY,
        source: 'manual_area',
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
  });

  it('uploads an image to object storage, registers it, and analyzes the capture once', async () => {
    const bytes = new Uint8Array(readFileSync(IMAGE));
    const auth = await api('POST', '/api/images/uploads', {
      associationKind: 'capture',
      associationId: EVENT,
      mimeType: 'image/jpeg',
      sizeBytes: bytes.byteLength,
      widthPx: 1024,
      heightPx: 1024,
    });
    assert.equal(auth.status, 201, JSON.stringify(auth.body));
    const early = await api('POST', `/api/images/${auth.body.objectId}/finalize`);
    assert.equal(early.status, 409, 'finalize before upload must be refused (retryable)');
    // R2: absolute presigned URL (200); local-dev: backend route (204).
    const put = await fetch(new URL(auth.body.uploadUrl, `${API}/`), {
      method: 'PUT',
      headers: auth.body.uploadHeaders ?? { 'Content-Type': 'image/jpeg' },
      body: bytes,
    });
    assert.ok([200, 204].includes(put.status), `upload PUT failed: ${put.status}`);
    const fin = await api('POST', `/api/images/${auth.body.objectId}/finalize`);
    assert.equal(fin.status, 200);
    assert.equal(fin.body.imageObject.state, 'finalized');

    const capture = {
      eventId: EVENT,
      hallId: HALL,
      serviceId: SERVICE,
      capturedAt: '2026-10-03T22:02:33.000Z',
      imageObjectId: auth.body.objectId,
      geometry: GEOMETRY,
      source: 'replay',
    };
    const first = await api('POST', '/api/captures', capture);
    assert.ok([200, 201].includes(first.status), JSON.stringify(first.body));
    assert.notEqual(first.body.event.state, 'failed', JSON.stringify(first.body.attempt?.error));
    for (const m of first.body.measurements) {
      assert.ok(m.qualityFlags.includes('ai_estimate'), 'every measurement is labeled an AI estimate');
      assert.ok(m.itemId === null || menu.items.some((i) => i.itemId === m.itemId), 'no invented menu items');
    }

    // Pixels wasted (contracts/measurement.md): classification -> masks -> counted pixels.
    const seg = first.body.attempt.segmentation;
    assert.ok(seg, 'the attempt carries a segmentation result');
    assert.ok(['complete', 'empty', 'partial', 'unavailable'].includes(seg.countStatus));
    if (seg.countStatus === 'complete') {
      const sum = first.body.measurements.reduce((total, m) => total + m.remainingAreaPx, 0);
      assert.equal(seg.capturePixelsWasted, sum, 'capture union = item + unclassified pixels');
      for (const m of first.body.measurements) {
        assert.equal(m.method, 'mask_pixel_count');
        assert.ok(Number.isInteger(m.remainingAreaPx) && m.remainingAreaPx > 0);
      }
      for (const region of seg.regions.filter((r) => r.segmentationStatus === 'succeeded')) {
        const mask = await api('GET', `/api/images/${region.maskObjectId}/access`);
        assert.equal(mask.status, 200, 'each mask is a finalized object in external storage');
        const png = Buffer.from(await (await fetch(new URL(mask.body.url, `${API}/`))).arrayBuffer());
        assert.equal(png.readUInt32BE(16), seg.widthPx, 'mask width matches the analyzed image');
        assert.equal(png.readUInt32BE(20), seg.heightPx, 'mask height matches the analyzed image');
      }
    }

    // Repeated ingestion must not duplicate the dish.
    const second = await api('POST', '/api/captures', capture);
    if (first.body.event.state === 'succeeded') assert.equal(second.body.deduplicated, true);
    const obs = await api('GET', `/api/observations?hallId=${HALL}&serviceId=${SERVICE}`);
    assert.equal(obs.body.observations.length, 1);

    const access = await api('GET', `/api/images/${auth.body.objectId}/access`);
    assert.equal(access.status, 200);
    assert.ok(access.body.expiresAt, 'read access is temporary');
  });

  it('serves dashboard data with stable simulated attendance and a grounded suggestion', async () => {
    const a = await api('GET', `/api/dashboard/meal?hallId=${HALL}&date=${DATE}&meal=dinner`);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.summary.captureCount, 1);
    assert.equal(a.body.attendance.source, 'simulated');
    const b = await api('GET', `/api/dashboard/meal?hallId=${HALL}&date=${DATE}&meal=dinner`);
    assert.equal(b.body.attendance.count, a.body.attendance.count, 'attendance is never re-rolled');

    if (a.body.summary.items.length > 0) {
      assert.ok(a.body.insight, 'a counted item yields a suggestion');
      assert.ok(['gemini', 'fallback_rules'].includes(a.body.insight.source));
      assert.equal(a.body.insight.metrics.topItemId, a.body.summary.items[0].itemId, 'tip is grounded in the top item');
    } else {
      assert.equal(a.body.insight, null, 'no tip without a counted item');
    }

    const daily = await api('GET', `/api/dashboard/daily?hallId=${HALL}&start=${DATE}&end=${DATE}`);
    assert.equal(daily.body.days[0].capturedDishes, 1);
  });
});

describe('demo flow e2e placeholder', () => {
  it('runs the live suite only when SCRAP_E2E=1', () => {
    assert.equal(typeof LIVE_E2E, 'boolean');
  });
});
