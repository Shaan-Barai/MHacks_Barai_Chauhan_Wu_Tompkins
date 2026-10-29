/**
 * A GET never writes. Every GET route in src/http/app.ts is called (with real
 * ids from seeded data) while a repository spy records any write-type call and
 * a live-mode gateway counts Gemini calls. Both must stay at zero, in normal mode
 * and with READ_ONLY=1. Writes still happen on the explicit POSTs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GeminiGateway } from '@scrap/vision';
import { BASELINES, HALL, MENU, SERVICE, startTestServer } from './helpers.js';
import { JsonFileRepository } from '../src/repo/jsonFileRepository.js';
import type { Repository } from '../src/repo/repository.js';

const WRITE = /^(upsert|add|record|replace|set|delete|clear)/;
const DATE = '2026-10-03';

/** Wraps a repository; while `armed`, every write-type call is recorded (and still performed). */
function spy(inner: Repository) {
  const writes: string[] = [];
  const state = { armed: false };
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (state.armed && typeof prop === 'string' && WRITE.test(prop)) writes.push(prop);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { proxy, writes, state };
}

function countingGateway(calls: { n: number }): GeminiGateway {
  return {
    model: 'test-model',
    mode: 'live',
    callCount: 0,
    async generateText() {
      calls.n++;
      throw new Error('a GET must not call Gemini');
    },
    async generateStructured() {
      calls.n++;
      throw new Error('a GET must not call Gemini');
    },
  } as unknown as GeminiGateway;
}

/** Every GET route registered in app.ts, so a new GET can't be missed by this test. */
function registeredGetRoutes(): string[] {
  const src = readFileSync(fileURLToPath(new URL('../../../src/http/app.ts', import.meta.url)), 'utf8');
  return [...src.matchAll(/app\.get\(\s*'([^']+)'/g)].map((m) => m[1]!);
}

async function seed(s: Awaited<ReturnType<typeof startTestServer>>) {
  assert.equal((await s.api('POST', '/api/menus', MENU)).status, 201);
  for (const b of BASELINES) await s.api('POST', '/api/reference-portions', b);
  s.fixtures['ev1'] = { measurements: [{ itemId: MENU.items[0]!.itemId, remainingAreaPx: 4000 }] };
  const img = await s.uploadImage('ev1');
  assert.equal((await s.submitCapture('ev1', img)).status < 300, true);
  return { imageObjectId: img };
}

for (const readOnly of [false, true]) {
  test(`every GET route reads only: no repository writes, no Gemini calls${readOnly ? ' (READ_ONLY=1)' : ''}`, async (t) => {
    const calls = { n: 0 };
    const inner = new JsonFileRepository();
    const { proxy, writes, state } = spy(inner);
    // Seed with a writable server, then serve GETs from the mode under test.
    const writer = await startTestServer(undefined, { repo: proxy });
    const { imageObjectId } = await seed(writer);
    const baselineId = BASELINES[0]!.baselineId;
    await writer.close();
    const s = await startTestServer(undefined, { repo: proxy, gateway: countingGateway(calls), config: { readOnly } });
    t.after(() => s.close());

    const window = `hallId=${HALL}&start=2026-09-01&end=2026-10-31`;
    const query: Record<string, string> = {
      '/api/menus': `hallId=${HALL}&date=${DATE}`,
      '/api/menus/days': window,
      '/api/services': `hallId=${HALL}`,
      '/api/portions-served': `hallId=${HALL}&serviceId=${SERVICE}`,
      '/api/portions-served/benchmark': `hallId=${HALL}&serviceId=${SERVICE}`,
      '/api/reference-portions': '',
      '/api/admin/captures': window,
      '/api/captures': window,
      '/api/captures/retryable': window,
      '/api/observations': `serviceId=${SERVICE}`,
      '/api/attendance': `serviceId=${SERVICE}`,
      '/api/dashboard/summary': `hallId=${HALL}&serviceId=${SERVICE}`,
      '/api/dashboard/daily': window,
      '/api/dashboard/cards': `hallId=${HALL}&today=${DATE}`,
      '/api/dashboard/meal': `hallId=${HALL}&date=${DATE}&meal=lunch`,
      '/api/dashboard/plates': `hallId=${HALL}&date=${DATE}&meal=lunch`,
      '/api/dashboard/impact': window,
      '/api/dashboard/impact/daily': window,
      '/api/recommendation': window,
      '/api/calibrations': `hallId=${HALL}`,
      '/api/settings/measurement': `hallId=${HALL}`,
      '/api/dashboard/totals': `hallId=${HALL}&today=${DATE}`,
      '/api/production-log': `hallId=${HALL}`,
      '/api/forecast/summary': window,
      '/api/suggestions': `hallId=${HALL}`,
      '/api/demo/status': `hallId=${HALL}`,
      '/api/images/orphans': '',
    };
    const params: Record<string, string> = {
      ':serviceId': SERVICE,
      ':baselineId': baselineId,
      ':objectId': imageObjectId,
      ':eventId': 'ev1',
      ':calibrationId': 'cal_none',
      ':id': 'try_none',
      ':objectKey(*)': 'none.png',
    };
    const routes = registeredGetRoutes();
    assert.ok(routes.length >= 40, `found ${routes.length} GET routes`);

    state.armed = true;
    const statuses: string[] = [];
    for (const route of routes) {
      let path = route;
      for (const [k, v] of Object.entries(params)) path = path.replace(k, encodeURIComponent(v));
      const q = query[route];
      const raw = await fetch(`${s.baseUrl}${q ? `${path}?${q}` : path}`);
      const json: any = (raw.headers.get('content-type') ?? '').includes('json') ? await raw.json() : undefined;
      statuses.push(`${route} ${raw.status}`);
      assert.ok(raw.status < 500, `${route} -> ${raw.status} ${JSON.stringify(json)?.slice(0, 200)}`);
      // READ_ONLY switches Try an Image and the camera off entirely (before any code runs);
      // anywhere else a READ_ONLY answer would mean a GET tried to write.
      if (!(readOnly && /^\/api\/(try-image|camera)(\/|$)/.test(route))) {
        assert.notEqual(json?.error?.code, 'READ_ONLY', `${route} was refused as a write`);
      }
    }
    state.armed = false;

    assert.deepEqual(writes, [], `GETs wrote: ${writes.join(', ')}`);
    assert.equal(calls.n, 0, 'no GET called Gemini');
    // Sanity: the important routes really answered (not just 404s).
    for (const r of ['/api/dashboard/meal', '/api/recommendation', '/api/dashboard/impact', '/api/captures', '/api/dashboard/summary']) {
      assert.ok(statuses.includes(`${r} 200`), `${r} answered: ${statuses.find((x) => x.startsWith(`${r} `))}`);
    }
  });
}

test('READ_ONLY=1: the repository itself refuses writes (403 READ_ONLY), even if a route tried', async (t) => {
  const s = await startTestServer(undefined, { config: { readOnly: true } });
  t.after(() => s.close());
  const { readOnlyRepository } = await import('../src/wiring.js');
  const guarded = readOnlyRepository(new JsonFileRepository());
  await assert.rejects(guarded.upsertMenu(MENU), (e: unknown) => (e as { apiError?: { code?: string } }).apiError?.code === 'READ_ONLY');
  await assert.rejects(guarded.clearDemoData(), (e: unknown) => (e as { apiError?: { code?: string } }).apiError?.code === 'READ_ONLY');
  assert.deepEqual(await guarded.listServices(), [], 'reads pass through');
});
