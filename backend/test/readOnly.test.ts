/**
 * READ_ONLY=1, the public offsite site (docs/deploy-server.md): reads are
 * served, every mutation is refused with 403 READ_ONLY (even with the ingest
 * token), Try an Image and the camera are refused even for GET, Gemini is
 * never live, and production starts without auth secrets.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, HALL, MENU } from './helpers.js';
import { buildBackend } from '../src/wiring.js';
import { loadConfig } from '../src/config.js';

const TOKEN = 'ingest-token-for-tests-0123456789';

async function raw(base: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

test('read-only: reads work, every mutation and AI/camera route is 403 READ_ONLY, even with the token', async (t) => {
  const s = await startTestServer(undefined, {
    config: {
      readOnly: true,
      security: {
        production: false,
        ingestToken: TOKEN,
        sessionTtlMs: 3600_000,
        cookieSecure: false,
        trustProxy: false,
        loginRateLimit: 10,
        geminiRateLimit: 30,
        jsonBodyLimit: '1mb',
      },
    },
  });
  t.after(() => s.close());
  // Stored data arrives with the database copy, not through the API: seed the repo directly.
  await s.repo.upsertMenu(MENU);

  const health = await raw(s.baseUrl, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.readOnly, true);
  assert.deepEqual((await raw(s.baseUrl, 'GET', '/api/auth/me')).json, { admin: false, authRequired: true, readOnly: true });
  const services = await raw(s.baseUrl, 'GET', `/api/services?hallId=${HALL}`);
  assert.equal(services.status, 200);
  assert.ok(services.json.services.length > 0, 'stored data is readable');

  const auth = { authorization: `Bearer ${TOKEN}` };
  for (const [method, path] of [
    ['POST', '/api/menus'],
    ['PUT', '/api/portions-served'],
    ['POST', '/api/portions-served/csv'],
    ['POST', '/api/images/uploads'],
    ['POST', '/api/captures'],
    ['POST', '/api/dish-match'],
    ['POST', '/api/recommendation/regenerate'],
    ['POST', '/api/calibrations'],
    ['PUT', '/api/settings/measurement'],
    ['POST', '/api/demo/load'],
    ['POST', '/api/auth/login'],
    ['DELETE', '/api/reference-portions/x'],
    ['GET', '/api/try-image/status'],
    ['GET', '/api/try-image/sample.jpg'],
    ['POST', '/api/try-image'],
    ['GET', '/api/camera/status'],
  ] as const) {
    const r = await raw(s.baseUrl, method, path, auth, method === 'GET' ? undefined : {});
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.json.error.code, 'READ_ONLY', `${method} ${path}`);
  }
  assert.equal((await raw(s.baseUrl, 'GET', `/api/services?hallId=${HALL}`)).json.services.length, services.json.services.length);
});

test('read-only production starts without auth secrets and never goes live on Gemini', () => {
  const backend = buildBackend({
    config: loadConfig({ NODE_ENV: 'production', READ_ONLY: '1', GEMINI_API_KEY: 'would-be-live' }),
  });
  assert.equal(backend.config.readOnly, true);
  assert.equal(backend.security.open, false, 'read-only is never "open"');
  // The key is ignored: the gateway is the mock, so nothing can call Gemini.
  assert.match(backend.tryImage!.status().reason ?? '', /not configured/);
  assert.throws(() => buildBackend({ config: loadConfig({ NODE_ENV: 'production' }) }), /SCRAP_INGEST_TOKEN/);
});

test('read-only: GET answers are cached in memory (any query order); health/ready/auth are always fresh', async (t) => {
  const s = await startTestServer(undefined, { config: { readOnly: true } });
  t.after(() => s.close());
  await s.repo.upsertMenu(MENU);

  const first = await fetch(`${s.baseUrl}/api/services?hallId=${HALL}`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-cache'), null);
  const firstBody = await first.json();
  const second = await fetch(`${s.baseUrl}/api/services?hallId=${HALL}`);
  assert.equal(second.headers.get('x-cache'), 'hit');
  assert.match(second.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await second.json(), firstBody);

  // Errors are never cached.
  assert.equal((await fetch(`${s.baseUrl}/api/menus?hallId=${HALL}`)).status, 400);
  assert.equal((await fetch(`${s.baseUrl}/api/menus?hallId=${HALL}`)).headers.get('x-cache'), null);

  for (const path of ['/api/health', '/api/auth/me']) {
    await fetch(`${s.baseUrl}${path}`);
    assert.equal((await fetch(`${s.baseUrl}${path}`)).headers.get('x-cache'), null, path);
  }
});

test('read-only cache: query parameter order does not matter', async (t) => {
  const s = await startTestServer(undefined, { config: { readOnly: true } });
  t.after(() => s.close());
  await fetch(`${s.baseUrl}/api/dashboard/impact?hallId=${HALL}&start=2026-10-01&end=2026-10-03`);
  const r = await fetch(`${s.baseUrl}/api/dashboard/impact?end=2026-10-03&start=2026-10-01&hallId=${HALL}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-cache'), 'hit');
});
