/**
 * IT_4 I11 production hardening: public reads, auth-gated mutations (bearer
 * token or admin session cookie), login rate limit, Gemini-cost caps,
 * security headers, readiness, SPA serving, and startup refusal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, HALL, MENU } from './helpers.js';
import { buildBackend } from '../src/wiring.js';
import { loadConfig, type SecurityConfig } from '../src/config.js';
import { assertSecurity, issueSession, verifySession } from '../src/http/security.js';

const TOKEN = 'ingest-token-for-tests-0123456789';
const PASSCODE = 'correct horse battery staple';
const SECRET = 'session-secret-for-tests-0123456789';

function security(over: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    production: false,
    ingestToken: TOKEN,
    adminPasscode: PASSCODE,
    sessionSecret: SECRET,
    sessionTtlMs: 12 * 3600 * 1000,
    cookieSecure: false,
    trustProxy: false,
    loginRateLimit: 3,
    geminiRateLimit: 2,
    jsonBodyLimit: '1mb',
    ...over,
  };
}

async function raw(base: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

test('reads are public; every mutation needs the bearer token or an admin session', async (t) => {
  const s = await startTestServer(undefined, { config: { security: security() } });
  t.after(() => s.close());

  // Public reads.
  assert.equal((await raw(s.baseUrl, 'GET', '/api/health')).status, 200);
  assert.equal((await raw(s.baseUrl, 'GET', `/api/services?hallId=${HALL}`)).status, 200);
  assert.deepEqual((await raw(s.baseUrl, 'GET', '/api/auth/me')).json, { admin: false, authRequired: true });

  // Mutations without credentials: 401 envelope, nothing stored.
  for (const [method, path] of [
    ['POST', '/api/menus'],
    ['PUT', '/api/portions-served'],
    ['POST', '/api/images/uploads'],
    ['POST', '/api/captures'],
    ['POST', '/api/dish-match'],
    ['DELETE', '/api/reference-portions/x'],
    ['PUT', '/api/settings/measurement'],
    ['POST', '/api/calibrations'],
  ] as const) {
    const r = await raw(s.baseUrl, method, path, {}, {});
    assert.equal(r.status, 401, `${method} ${path}`);
    assert.equal(r.json.error.code, 'AUTH_REQUIRED');
  }
  const wrongToken = await raw(s.baseUrl, 'POST', '/api/menus', { authorization: 'Bearer nope' }, MENU);
  assert.equal(wrongToken.status, 401);
  assert.equal((await raw(s.baseUrl, 'GET', `/api/services?hallId=${HALL}`)).json.services.length, 0);

  // Bearer token works.
  const ok = await raw(s.baseUrl, 'POST', '/api/menus', { authorization: `Bearer ${TOKEN}` }, MENU);
  assert.equal(ok.status, 201);

  // Wrong passcode, then the right one -> httpOnly SameSite=Strict cookie.
  const bad = await raw(s.baseUrl, 'POST', '/api/auth/login', {}, { passcode: 'guess' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'INVALID_PASSCODE');
  const login = await raw(s.baseUrl, 'POST', '/api/auth/login', {}, { passcode: PASSCODE });
  assert.equal(login.status, 200);
  assert.equal(login.json.admin, true);
  const setCookie = login.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /^scrap_session=v1\./);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=43200/);
  assert.doesNotMatch(setCookie, /Secure/); // dev (cookieSecure false)
  const cookie = setCookie.split(';')[0]!;

  assert.deepEqual((await raw(s.baseUrl, 'GET', '/api/auth/me', { cookie })).json, { admin: true, authRequired: true });
  const asAdmin = await raw(s.baseUrl, 'PUT', '/api/attendance', { cookie }, {
    hallId: HALL, serviceId: MENU.service.serviceId, serviceDate: '2026-10-03', count: 500,
    source: 'simulated', configuredMin: 300, configuredMax: 1200, generatorVersion: 'g1',
  });
  assert.equal(asAdmin.status, 201);

  // Cross-site Origin with a cookie is refused.
  const csrf = await raw(s.baseUrl, 'POST', '/api/menus', { cookie, origin: 'https://evil.example' }, MENU);
  assert.equal(csrf.status, 403);

  // A tampered cookie is not a session.
  const tampered = cookie.slice(0, -2) + (cookie.endsWith('A') ? 'BB' : 'AA');
  assert.equal((await raw(s.baseUrl, 'POST', '/api/menus', { cookie: tampered }, MENU)).status, 401);

  // Logout clears and revokes.
  const out = await raw(s.baseUrl, 'POST', '/api/auth/logout', { cookie });
  assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.equal((await raw(s.baseUrl, 'POST', '/api/menus', { cookie }, MENU)).status, 401);
});

test('login is rate limited per IP; Gemini-cost endpoints are capped', async (t) => {
  const s = await startTestServer(undefined, { config: { security: security() } });
  t.after(() => s.close());
  for (let i = 0; i < 3; i++) assert.equal((await raw(s.baseUrl, 'POST', '/api/auth/login', {}, { passcode: 'x' })).status, 401);
  const limited = await raw(s.baseUrl, 'POST', '/api/auth/login', {}, { passcode: PASSCODE });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);

  // geminiRateLimit = 2 per minute for anonymous recommendation reads.
  const q = '/api/recommendation?start=2026-10-01&end=2026-10-03';
  assert.equal((await raw(s.baseUrl, 'GET', q)).status, 200);
  assert.equal((await raw(s.baseUrl, 'GET', q)).status, 200);
  assert.equal((await raw(s.baseUrl, 'GET', q)).status, 429);
});

test('security headers and readiness report', async (t) => {
  const s = await startTestServer(undefined, { config: { security: security() } });
  t.after(() => s.close());
  const r = await raw(s.baseUrl, 'GET', '/api/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(r.headers.get('x-powered-by'), null);

  const ready = await raw(s.baseUrl, 'GET', '/api/ready');
  // In-memory repo + local-dev storage are up; workers are not, but the
  // mock analyzer does not need SAM and depth is optional.
  assert.equal(ready.status, 200);
  assert.equal(ready.json.ready, true);
  assert.equal(ready.json.checks.database.ok, true);
  assert.equal(ready.json.checks.objectStorage.ok, true);
  assert.equal(ready.json.checks.samWorker.ok, false);
  assert.equal(ready.json.checks.samWorker.required, false);
  assert.equal(ready.json.checks.depthWorker.required, false);
  assert.doesNotMatch(JSON.stringify(ready.json), /127\.0\.0\.1/);
});

test('dev with no secrets is open; production without secrets refuses to start', () => {
  const open = assertSecurity(undefined);
  assert.equal(open.open, true);
  assert.throws(
    () => buildBackend({ config: loadConfig({ NODE_ENV: 'production' }) }),
    /SCRAP_INGEST_TOKEN.*SCRAP_ADMIN_PASSCODE.*SESSION_SECRET/,
  );
  const prod = loadConfig({
    NODE_ENV: 'production',
    SCRAP_INGEST_TOKEN: TOKEN,
    SCRAP_ADMIN_PASSCODE: PASSCODE,
    SESSION_SECRET: SECRET,
  });
  assert.equal(prod.security?.cookieSecure, true);
  assert.equal(loadConfig({ NODE_ENV: 'production', SESSION_COOKIE_SECURE: '0' }).security?.cookieSecure, false);
  const resolved = assertSecurity(prod.security);
  assert.equal(resolved.open, false);
  const sess = issueSession(resolved, 1_000);
  assert.equal(verifySession(resolved, sess.value, 2_000, new Set()), true);
  assert.equal(verifySession(resolved, sess.value, 1_000 + 12 * 3600 * 1000 + 1, new Set()), false, 'expires after 12 h');
});

test('SERVE_FRONTEND serves the built dashboard with SPA fallback and asset caching', async (t) => {
  const dist = mkdtempSync(join(tmpdir(), 'scrap-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>ScrapSaver</title>');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  const s = await startTestServer(undefined, { config: { security: security(), frontendDist: dist } });
  t.after(() => s.close());

  const root = await raw(s.baseUrl, 'GET', '/');
  assert.equal(root.status, 200);
  assert.match(String(root.json), /ScrapSaver/);
  assert.equal(root.headers.get('cache-control'), 'no-cache');
  const deep = await raw(s.baseUrl, 'GET', '/settings/calibration');
  assert.match(String(deep.json), /ScrapSaver/);
  const asset = await raw(s.baseUrl, 'GET', '/assets/app-abc123.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
  // Unknown API routes stay JSON 404s, never the SPA.
  const api = await raw(s.baseUrl, 'GET', '/api/nope');
  assert.equal(api.status, 404);
  assert.equal(api.json.error.code, 'ROUTE_NOT_FOUND');
});
