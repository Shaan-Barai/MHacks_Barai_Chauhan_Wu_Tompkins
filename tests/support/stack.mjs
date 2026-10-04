/**
 * Test harness for the end-to-end pipeline: an in-process backend (the real
 * Express app, ingestion, storage and repository code) on an ephemeral port,
 * plus offline stand-ins for Gemini and SAM when a test must not call them.
 *
 * Imports the built packages (run `node scripts/build.mjs` first; the npm
 * scripts in tests/package.json do).
 */

import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../..', import.meta.url));
const pkg = (p) => path.join(REPO, p);

export const backend = {
  wiring: await import(pkg('backend/dist/backend/src/wiring.js')),
  config: await import(pkg('backend/dist/backend/src/config.js')),
  maskAnalyzer: await import(pkg('backend/dist/backend/src/analysis/maskAnalyzer.js')),
  jsonRepo: await import(pkg('backend/dist/backend/src/repo/jsonFileRepository.js')),
  spacetimeRepo: await import(pkg('backend/dist/backend/src/repo/spacetimeRepository.js')),
  r2: await import(pkg('backend/dist/backend/src/storage/r2Storage.js')),
  demo: await import(pkg('backend/dist/backend/src/services/demoService.js')),
};
export const capture = await import(pkg('capture/dist/src/index.js'));
export const vision = await import(pkg('vision/dist/src/index.js'));
export const data = await import(pkg('data/dist/data/src/index.js'));
export const analytics = await import(pkg('analytics/dist/src/index.js'));

const visionRequire = createRequire(pkg('vision/package.json'));
const { PNG } = visionRequire('pngjs');

export const HALL = 'hall-e2e';
export const DATE = '2026-10-04';
export const SERVICE = `svc_${HALL}_${DATE}_dinner`;
export const MENU_ID = `menu_${HALL}_${DATE}_dinner`;

/** A dinner made of factor foods (so relative impact points exist), with demo portions. */
export function dinnerMenu(foods = ['Pepperoni Pizza', 'Farro', 'Ancho Flank Steak', 'Sticky Rice']) {
  const items = foods.map((name) => ({
    itemId: `item_${HALL}_${DATE}_${data.factorKeyFor(name)}`,
    menuId: MENU_ID,
    displayName: name,
    category: data.WASTE_FACTOR_MENU_TEXT.find((f) => f.food === name)?.station ?? 'Entrees',
    description: data.WASTE_FACTOR_MENU_TEXT.find((f) => f.food === name)?.visibleComponents ?? name,
  }));
  return {
    service: { serviceId: SERVICE, hallId: HALL, hallTimezone: 'America/Detroit', serviceDate: DATE, mealLabel: 'dinner', menuId: MENU_ID, menuVersion: 1 },
    items,
  };
}

export function demoPortions(menu, counts) {
  return menu.items.map((item, i) => ({
    recordId: JSON.stringify([menu.service.serviceId, 1, item.itemId]),
    hallId: menu.service.hallId,
    serviceId: menu.service.serviceId,
    serviceDate: menu.service.serviceDate,
    menuId: menu.service.menuId,
    menuVersion: 1,
    itemId: item.itemId,
    count: counts?.[i] ?? 100 + 10 * i,
    source: 'demo',
    updatedAt: `${menu.service.serviceDate}T23:00:00.000Z`,
  }));
}

/** Offline Gemini: one target plate and two numbered pieces (menu ids 1 and 2), for every pass. */
export function fakeGemini({ pieces } = {}) {
  let calls = 0;
  const gateway = vision.createGeminiGateway({
    env: {},
    sleep: async () => {},
    mockTransport: () => {
      calls++;
      return JSON.stringify({
        target_dish: { dish_type: 'plate', box_2d: [100, 100, 900, 900], fully_visible: true },
        pieces: pieces ?? [
          { ingredient: 'pizza slice', menu_id: 1, box_2d: [200, 200, 400, 500], on_target_dish: true },
          { ingredient: 'grain', menu_id: 2, box_2d: [500, 300, 700, 600], on_target_dish: true },
        ],
      });
    },
  });
  return { gateway, calls: () => calls };
}

function maskPng(width, height, fill) {
  const png = new PNG({ width, height, colorType: 0, inputColorType: 0, inputHasAlpha: false, bitDepth: 8 });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = fill(x, y);
      const i = (y * width + x) * 4;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = v;
      png.data[i + 3] = 255;
    }
  return new Uint8Array(PNG.sync.write(png, { colorType: 0 }));
}

/** Offline SAM: each mask is exactly its box (1024x1024 normalized frame). */
export function boxFillerSam(size = 1024) {
  let calls = 0;
  return {
    calls: () => calls,
    async segment(_image, boxes) {
      calls++;
      return {
        model: 'fake-sam', checkpoint: 'fake', codeRevision: 'test', device: 'cpu', settingsVersion: 'sam2-box-v1',
        widthPx: size,
        heightPx: size,
        results: boxes.map(([x0, y0, x1, y1]) => {
          const png = maskPng(size, size, (x, y) => (x >= x0 && x < x1 && y >= y0 && y < y1 ? 255 : 0));
          return { maskPng: png, score: 0.9, foregroundPx: (Math.ceil(x1) - Math.ceil(x0)) * (Math.ceil(y1) - Math.ceil(y0)) };
        }),
      };
    },
  };
}

/**
 * The real backend on an ephemeral port. Defaults: local-dev storage in a
 * temp dir and the in-memory repository; pass `repo`, `objectStorage`,
 * `analyzer` or `gateway` to use real services.
 */
export async function startBackend(options = {}) {
  const config = {
    port: 0,
    objectStorage: {
      provider: 'local-dev',
      container: 'scrap-test',
      localDir: mkdtempSync(path.join(tmpdir(), 'scrap-e2e-storage-')),
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maxUploadBytes: 20 * 1024 * 1024,
      uploadUrlTtlMs: 15 * 60_000,
      readUrlTtlMs: 10 * 60_000,
      orphanMaxAgeMs: 60 * 60_000,
      keyPrefix: '',
      ...(options.objectStorage ?? {}),
    },
    samWorkerUrl: process.env.SAM_WORKER_URL ?? 'http://127.0.0.1:8790',
    attendance: { min: 300, max: 1200, seed: 'e2e' },
    ...(options.spacetime ? { spacetime: options.spacetime } : {}),
  };
  const built = backend.wiring.buildBackend({
    config,
    ...(options.repo ? { repo: options.repo } : {}),
    ...(options.analyzer ? { analyzer: options.analyzer } : {}),
    ...(options.gateway ? { gateway: options.gateway } : {}),
    ...(options.storage ? { storage: options.storage } : {}),
  });
  const server = built.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body) => {
    const res = await fetch(`${baseUrl}${p}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { ...built, config, baseUrl, api, close: () => new Promise((r) => server.close(() => r())) };
}

/** The single ingest path, over HTTP, like take-photo and the bridge use it. */
export function httpAdapter(baseUrl, stateFile) {
  const sink = new capture.HttpIngestionSink(baseUrl);
  const adapter = new capture.ReplayCaptureAdapter(new capture.HttpUploader(baseUrl), sink, stateFile ? { stateFile } : {});
  return { adapter, sink };
}

/** Sum of counted (mask) pixels in the repository for captures in a hall/date window. */
export async function sumScanRows(repo, { hallId, start, end }) {
  let pixels = 0;
  let plates = 0;
  for (const svc of await repo.listServices(hallId)) {
    if (svc.serviceDate < start || svc.serviceDate > end) continue;
    for (const c of await repo.listCaptureEvents({ serviceId: svc.serviceId })) {
      if (c.state !== 'succeeded') continue;
      plates++;
      const attempts = await repo.listAnalysisAttempts(c.eventId);
      const counted = attempts.filter((a) => a.status === 'succeeded').at(-1);
      if (!counted) continue;
      for (const m of await repo.listMeasurementsByAttempt(counted.attemptId)) pixels += m.remainingAreaPx;
    }
  }
  return { pixels, plates };
}

export function test2Photos(count) {
  return import('node:fs').then(({ readdirSync }) =>
    readdirSync(path.join(REPO, 'test2'))
      .filter((f) => /\.jpe?g$/i.test(f))
      .sort()
      .slice(0, count ?? Infinity)
      .map((f) => path.join(REPO, 'test2', f)),
  );
}
