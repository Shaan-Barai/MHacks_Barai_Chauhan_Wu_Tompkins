/** Shared test harness: in-memory backend on an ephemeral port + fixtures. */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildBackend } from '../src/wiring.js';
import { MockAnalyzer, type MockFixture } from '../src/analysis/mockAnalyzer.js';
import type { BackendConfig } from '../src/config.js';
import type { MenuBundle, ReferencePortion } from '../src/types.js';
import type { Repository } from '../src/repo/repository.js';

export const HALL = 'hall-main';
export const SERVICE = 'svc_hall-main_2026-10-03_lunch';
export const MENU_ID = 'menu_hall-main_2026-10-03';

export const MENU: MenuBundle = {
  service: {
    serviceId: SERVICE,
    hallId: HALL,
    hallTimezone: 'America/Detroit',
    serviceDate: '2026-10-03',
    mealLabel: 'lunch',
    menuId: MENU_ID,
    menuVersion: 1,
  },
  items: [
    { itemId: 'item_eggs', menuId: MENU_ID, displayName: 'Scrambled Eggs' },
    { itemId: 'item_toast', menuId: MENU_ID, displayName: 'Toast' },
    { itemId: 'item_mystery', menuId: MENU_ID, displayName: 'Mystery Stew' }, // no baseline on purpose
  ],
};

export const BASELINES: ReferencePortion[] = [
  {
    baselineId: 'base_eggs_v1',
    baselineVersion: 1,
    itemId: 'item_eggs',
    expectedAreaPx: 48000,
    geometry: { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' },
    source: 'manual_area',
  },
  {
    baselineId: 'base_toast_v1',
    baselineVersion: 1,
    itemId: 'item_toast',
    expectedAreaPx: 30000,
    geometry: { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' },
    source: 'manual_area',
  },
];

export const GEOMETRY = {
  widthPx: 1024,
  heightPx: 1024,
  coordinateSpace: 'topdown-normalized-v1' as const,
};

export interface TestServer {
  repo: Repository;
  baseUrl: string;
  fixtures: Record<string, MockFixture>;
  close(): Promise<void>;
  api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>;
  seedMenuAndBaselines(): Promise<void>;
  /** Full two-step upload for a capture event; returns the finalized objectId. */
  uploadImage(eventId: string): Promise<string>;
  submitCapture(eventId: string, imageObjectId: string): Promise<{ status: number; json: any }>;
}

export async function startTestServer(): Promise<TestServer> {
  const fixtures: Record<string, MockFixture> = {};
  const config: BackendConfig = {
    port: 0,
    objectStorage: {
      provider: 'local-dev',
      container: 'scrap-images-test',
      localDir: mkdtempSync(join(tmpdir(), 'scrap-storage-')),
      allowedMimeTypes: ['image/jpeg', 'image/png'],
      maxUploadBytes: 1024 * 1024,
      uploadUrlTtlMs: 60_000,
      readUrlTtlMs: 60_000,
      orphanMaxAgeMs: 60_000,
    },
    attendance: { min: 300, max: 1200 },
  };
  const backend = buildBackend({ config, analyzer: new MockAnalyzer(fixtures) });
  const server = backend.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };

  return {
    repo: backend.repo,
    baseUrl,
    fixtures,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    api,
    async seedMenuAndBaselines() {
      await api('POST', '/api/menus', MENU);
      for (const b of BASELINES) await api('POST', '/api/reference-portions', b);
    },
    async uploadImage(eventId: string) {
      const req = await api('POST', '/api/images/uploads', {
        associationKind: 'capture',
        associationId: eventId,
        mimeType: 'image/png',
        sizeBytes: 64,
        widthPx: 1024,
        heightPx: 1024,
      });
      if (req.status !== 201) throw new Error(`upload request failed: ${JSON.stringify(req.json)}`);
      const put = await fetch(`${baseUrl}${req.json.uploadUrl}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body: Buffer.from('fake-png-bytes-for-testing-only-0123456789abcdef'),
      });
      if (put.status !== 204) throw new Error(`upload PUT failed: ${put.status}`);
      const fin = await api('POST', `/api/images/${req.json.objectId}/finalize`);
      if (fin.status !== 200) throw new Error(`finalize failed: ${JSON.stringify(fin.json)}`);
      return req.json.objectId as string;
    },
    submitCapture(eventId: string, imageObjectId: string) {
      return api('POST', '/api/captures', {
        eventId,
        hallId: HALL,
        serviceId: SERVICE,
        capturedAt: '2026-10-03T16:42:09Z',
        imageObjectId,
        geometry: GEOMETRY,
        source: 'replay',
      });
    },
  };
}
