/** Public "Try an Image" endpoints with a fake runner (no Gemini, no SAM, nothing stored). */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './helpers.js';
import type { GeminiGateway } from '@scrap/vision';
import type { TryImageRunner } from '../src/services/tryImageService.js';

const live = { mode: 'live' } as unknown as GeminiGateway;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
// Auth is on only when security is configured; tests run open, but these calls send no token anyway.

function fakeRunner(opts: { delay?: number; fail?: string } = {}) {
  const calls: { start: number; end: number }[] = [];
  const runner: TryImageRunner = async () => {
    const c = { start: Date.now(), end: 0 };
    calls.push(c);
    await new Promise((r) => setTimeout(r, opts.delay ?? 5));
    c.end = Date.now();
    if (opts.fail) throw new Error(opts.fail);
    return {
      summary: { capturePixelsWasted: 1234, foods: [] } as any,
      images: { original: JPEG, boxes: JPEG, masks: null, final: JPEG },
    };
  };
  return { runner, calls };
}

const post = (s: TestServer, body: Buffer | undefined, type = 'image/jpeg') =>
  fetch(`${s.baseUrl}/api/try-image`, { method: 'POST', headers: { 'content-type': type }, body });

async function poll(s: TestServer, id: string, until = ['done', 'failed']) {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${s.baseUrl}/api/try-image/${id}`);
    const json: any = await res.json();
    if (until.includes(json.status)) return json;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout');
}

test('public POST returns 202, then polling reaches done with data-URL images', async () => {
  const { runner } = fakeRunner();
  const s = await startTestServer(undefined, { gateway: live, tryImageRunner: runner });
  try {
    const res = await post(s, JPEG);
    assert.equal(res.status, 202);
    const acc: any = await res.json();
    assert.equal(acc.status, 'queued');
    assert.equal(typeof acc.id, 'string');
    assert.equal(typeof acc.position, 'number');
    const job = await poll(s, acc.id);
    assert.equal(job.status, 'done');
    assert.equal(job.summary.capturePixelsWasted, 1234);
    assert.match(job.images.original, /^data:image\/jpeg;base64,/);
    assert.equal(job.images.masks, null);
    const status: any = await (await fetch(`${s.baseUrl}/api/try-image/status`)).json();
    assert.equal(status.available, true);
    assert.equal(status.running, false);
    assert.equal(status.maxWaiting, 4);
    assert.equal(status.hourlyRemaining, 59);
    const missing = await fetch(`${s.baseUrl}/api/try-image/nope`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as any).error.code, 'RESULT_NOT_FOUND');
  } finally {
    await s.close();
  }
});

test('analyses run one at a time; the 6th while 1 runs + 4 wait is BUSY', async () => {
  const { runner, calls } = fakeRunner({ delay: 40 });
  const s = await startTestServer(undefined, { gateway: live, tryImageRunner: runner });
  try {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await post(s, JPEG);
      assert.equal(res.status, 202, `upload ${i}`);
      ids.push(((await res.json()) as any).id);
    }
    const busy = await post(s, JPEG);
    assert.equal(busy.status, 429);
    const err = ((await busy.json()) as any).error;
    assert.equal(err.code, 'BUSY');
    assert.equal(err.retryable, true);
    for (const id of ids) assert.equal((await poll(s, id)).status, 'done');
    assert.equal(calls.length, 5);
    for (let i = 1; i < calls.length; i++) assert.ok((calls[i] as any).start >= (calls[i - 1] as any).end, 'serial');
  } finally {
    await s.close();
  }
});

test('hourly cap returns RATE_LIMITED and status goes unavailable', async () => {
  const { runner } = fakeRunner();
  const prev = process.env.TRY_IMAGE_MAX_PER_HOUR;
  process.env.TRY_IMAGE_MAX_PER_HOUR = '2';
  const s = await startTestServer(undefined, { gateway: live, tryImageRunner: runner });
  try {
    assert.equal((await post(s, JPEG)).status, 202);
    assert.equal((await post(s, JPEG)).status, 202);
    const res = await post(s, JPEG);
    assert.equal(res.status, 429);
    assert.equal(((await res.json()) as any).error.code, 'RATE_LIMITED');
    const status: any = await (await fetch(`${s.baseUrl}/api/try-image/status`)).json();
    assert.equal(status.available, false);
    assert.equal(status.hourlyRemaining, 0);
    assert.ok(status.reason);
  } finally {
    if (prev === undefined) delete process.env.TRY_IMAGE_MAX_PER_HOUR;
    else process.env.TRY_IMAGE_MAX_PER_HOUR = prev;
    await s.close();
  }
});

test('415 for non-images, 400 for empty uploads', async () => {
  const { runner } = fakeRunner();
  const s = await startTestServer(undefined, { gateway: live, tryImageRunner: runner });
  try {
    const bad = await post(s, Buffer.from('hello'), 'text/plain');
    assert.equal(bad.status, 415);
    assert.equal(((await bad.json()) as any).error.code, 'NOT_AN_IMAGE');
    const empty = await post(s, undefined);
    assert.equal(empty.status, 400);
    assert.equal(((await empty.json()) as any).error.code, 'EMPTY_UPLOAD');
  } finally {
    await s.close();
  }
});

test('mock mode (no live Gemini): status unavailable and POST is 503 UNAVAILABLE', async () => {
  const { runner, calls } = fakeRunner();
  const s = await startTestServer(undefined, { tryImageRunner: runner });
  try {
    const status: any = await (await fetch(`${s.baseUrl}/api/try-image/status`)).json();
    assert.equal(status.available, false);
    assert.match(status.reason, /Gemini/);
    const res = await post(s, JPEG);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as any).error.code, 'UNAVAILABLE');
    assert.equal(calls.length, 0);
  } finally {
    await s.close();
  }
});

test('runner failures become status failed with a friendly message', async () => {
  const { runner } = fakeRunner({ fail: 'fetch failed' });
  const s = await startTestServer(undefined, { gateway: live, tryImageRunner: runner });
  try {
    const acc: any = await (await post(s, JPEG)).json();
    const job = await poll(s, acc.id);
    assert.equal(job.status, 'failed');
    assert.match(job.error.message, /SAM/);
    assert.equal(job.summary, undefined);
  } finally {
    await s.close();
  }
});

test('sample.jpg is served as image/jpeg', async () => {
  const s = await startTestServer(undefined, { gateway: live, tryImageRunner: fakeRunner().runner });
  try {
    const res = await fetch(`${s.baseUrl}/api/try-image/sample.jpg`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /image\/jpeg/);
    assert.ok((await res.arrayBuffer()).byteLength > 1000);
  } finally {
    await s.close();
  }
});

test('public POST works with auth required and no token; other POSTs still 401', async () => {
  const { runner } = fakeRunner();
  const s = await startTestServer(undefined, {
    gateway: live,
    tryImageRunner: runner,
    config: {
      security: {
        production: false,
        ingestToken: 'ingest-token-for-tests-0123456789',
        adminPasscode: 'correct horse battery staple',
        sessionSecret: 'session-secret-for-tests-0123456789',
        sessionTtlMs: 3600_000,
        cookieSecure: false,
        trustProxy: false,
        loginRateLimit: 5,
        geminiRateLimit: 30,
        jsonBodyLimit: '1mb',
      },
    },
  });
  try {
    assert.equal((await post(s, JPEG)).status, 202);
    const other = await fetch(`${s.baseUrl}/api/try-image/x`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: JPEG });
    assert.equal(other.status, 401);
    assert.equal((await fetch(`${s.baseUrl}/api/captures`, { method: 'POST' })).status, 401);
  } finally {
    await s.close();
  }
});
