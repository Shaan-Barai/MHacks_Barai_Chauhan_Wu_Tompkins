#!/usr/bin/env node
/**
 * Post-deploy smoke test for a running ScrapSaver backend (IT_4 §6, workstream P).
 *
 *   node deploy/smoke.mjs [baseUrl] [--strict] [--no-roundtrip] [--image path]
 *   node deploy/smoke.mjs http://127.0.0.1:8787
 *
 * Checks (read-only unless SCRAP_INGEST_TOKEN is set):
 *   1. GET /api/health → 200 {ok:true}
 *   2. GET /api/ready  → 200 (404 = route not implemented yet: WARN, FAIL with --strict)
 *   3. GET /  and a deep SPA route → dashboard HTML (SERVE_FRONTEND)
 *   4. GET /api/dashboard/impact (hall-main, last 7 days) → JSON with totals
 *   5. Mutations without credentials → 401 (POST /api/captures, POST /api/menus/upload,
 *      POST /api/auth/login with a wrong passcode)
 *   6. With SCRAP_INGEST_TOKEN: menu → upload → finalize → capture → analysis round trip on
 *      the dedicated smoke hall `hall-smoke` (the dashboard shows hall-main by default).
 *      This makes ONE live Gemini + SAM analysis call.
 *
 * Reads SCRAP_INGEST_TOKEN from the environment, else from deploy/.run/local-secrets.env
 * (the local stack's generated secrets) when the base URL is local. Never prints it.
 * Exit code 0 when nothing FAILed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--image'));
const base = (positional[0] ?? process.env.SCRAP_API_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const strict = flag('--strict');
const repo = fileURLToPath(new URL('..', import.meta.url));

const SMOKE_HALL = 'hall-smoke';
const TZ = 'America/Detroit';

function ingestToken() {
  if (process.env.SCRAP_INGEST_TOKEN) return process.env.SCRAP_INGEST_TOKEN;
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(base);
  const file = `${repo}deploy/.run/local-secrets.env`;
  if (!isLocal || !existsSync(file)) return undefined;
  const m = readFileSync(file, 'utf8').match(/^SCRAP_INGEST_TOKEN=(.+)$/m);
  return m?.[1]?.trim();
}
const token = ingestToken();

const results = [];
function record(status, name, detail = '') {
  results.push({ status, name });
  console.log(`${status.padEnd(4)} ${name}${detail ? ` - ${detail}` : ''}`);
}
const pass = (n, d) => record('PASS', n, d);
const fail = (n, d) => record('FAIL', n, d);
const warn = (n, d) => record(strict ? 'FAIL' : 'WARN', n, d);
const skip = (n, d) => record('SKIP', n, d);

async function http(method, path, { body, headers = {}, auth = false, raw = false } = {}) {
  const h = { ...headers };
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  if (auth && token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(path.startsWith('http') ? path : `${base}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

const errCode = (r) => r.json?.error?.code ?? r.text.slice(0, 120).replace(/\s+/g, ' ');

function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

console.log(`Smoke test against ${base}${strict ? ' (strict)' : ''}\n`);

await step('GET /api/health', async () => {
  const r = await http('GET', '/api/health');
  if (r.status === 200 && r.json?.ok === true) pass('GET /api/health', `storage ${r.json.provider ?? '?'}`);
  else fail('GET /api/health', `HTTP ${r.status}`);
});

await step('GET /api/ready', async () => {
  const r = await http('GET', '/api/ready');
  if (r.status === 200) pass('GET /api/ready');
  else if (r.status === 404 && r.json?.error?.code === 'ROUTE_NOT_FOUND') warn('GET /api/ready', 'route not implemented in this backend yet');
  else fail('GET /api/ready', `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
});

await step('dashboard HTML', async () => {
  for (const path of ['/', '/plates/deep-link']) {
    const r = await http('GET', path);
    const html = (r.headers.get('content-type') ?? '').startsWith('text/html') && /<div id="root"/.test(r.text);
    if (r.status === 200 && html) pass(`GET ${path} serves the dashboard`);
    else fail(`GET ${path} serves the dashboard`, `HTTP ${r.status} ${r.headers.get('content-type') ?? ''} (SERVE_FRONTEND=1 and a built frontend/dist needed)`);
  }
});

await step('security headers', async () => {
  const r = await http('GET', '/api/health');
  const missing = ['x-content-type-options', 'x-frame-options'].filter((h) => !r.headers.get(h));
  if (missing.length === 0) pass('security headers');
  else warn('security headers', `missing ${missing.join(', ')}`);
});

await step('GET /api/dashboard/impact', async () => {
  const r = await http('GET', `/api/dashboard/impact?hallId=hall-main&start=${localDate(-6)}&end=${localDate()}`);
  if (r.status === 200 && r.json && typeof r.json === 'object' && 'totals' in r.json) {
    const t = r.json.totals ?? {};
    pass('GET /api/dashboard/impact', `${t.pixels ?? "?"} pixels wasted, ${t.analyzedCaptures ?? "?"} analyzed plates`);
  } else fail('GET /api/dashboard/impact', `HTTP ${r.status}: ${errCode(r)}`);
});

// Mutations without credentials must be refused before any validation or cost.
await step('unauthenticated mutations', async () => {
  const probes = [
    ['POST', '/api/captures', {}],
    ['POST', '/api/menus/upload', {}],
    ['POST', '/api/images/uploads', {}],
    ['PUT', '/api/settings/measurement', {}],
  ];
  for (const [method, path, body] of probes) {
    const r = await http(method, path, { body });
    if (r.status === 401) pass(`${method} ${path} without auth → 401`);
    else fail(`${method} ${path} without auth → 401`, `got HTTP ${r.status} (${errCode(r)})`);
  }
  const login = await http('POST', '/api/auth/login', { body: { passcode: 'definitely-not-the-passcode' } });
  if (login.status === 401) pass('POST /api/auth/login wrong passcode → 401');
  else if (login.status === 429) pass('POST /api/auth/login wrong passcode → 429 (rate limited)');
  else fail('POST /api/auth/login wrong passcode → 401', `got HTTP ${login.status} (${errCode(login)})`);
});

async function smokeImage() {
  const path = opt('--image') ?? `${repo}test2/IMG_2695.jpeg`;
  const input = readFileSync(path);
  // Same normalization as capture/src/normalize.ts: EXIF orient, centre square, 1024², JPEG q90.
  let sharp;
  for (const pkg of ['capture', 'vision']) {
    try {
      sharp = createRequire(`${repo}${pkg}/package.json`)('sharp');
      break;
    } catch {
      /* try the next package */
    }
  }
  if (!sharp) throw new Error('sharp not installed (run npm ci in vision/ or capture/)');
  const img = sharp(input, { failOn: 'error' }).rotate();
  const meta = await img.metadata();
  const swap = (meta.orientation ?? 1) >= 5;
  const w = swap ? meta.height : meta.width;
  const h = swap ? meta.width : meta.height;
  const side = Math.min(w, h);
  const bytes = await img
    .extract({ left: Math.floor((w - side) / 2), top: Math.floor((h - side) / 2), width: side, height: side })
    .resize(1024, 1024, { kernel: sharp.kernel.lanczos3 })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { bytes, widthPx: 1024, heightPx: 1024 };
}

const TERMINAL = new Set(['succeeded', 'needs_review', 'failed']);

async function roundTrip() {
  const name = `round trip on ${SMOKE_HALL}`;
  if (flag('--no-roundtrip')) return skip(name, '--no-roundtrip');
  if (!token) return skip(name, 'set SCRAP_INGEST_TOKEN to run upload → capture → analysis');

  const date = localDate();
  const menu = await http('POST', '/api/menus/upload', {
    auth: true,
    body: {
      hallId: SMOKE_HALL,
      hallTimezone: TZ,
      days: [{ date, lunch: ['Halal Rice', 'Chicken', 'Lettuce', 'Tomatoes', 'Pita Bread'] }],
    },
  });
  if (menu.status !== 200 && menu.status !== 201) throw new Error(`menu upload HTTP ${menu.status}: ${errCode(menu)}`);
  const service = menu.json?.results?.[0]?.menu?.service;
  if (!service?.serviceId) throw new Error('menu upload returned no service');
  pass('smoke menu stored', `${service.serviceId} v${service.menuVersion}`);

  const { bytes, widthPx, heightPx } = await smokeImage();
  const eventId = `cap_smoke_${Date.now().toString(36)}`;
  const auth = await http('POST', '/api/images/uploads', {
    auth: true,
    body: { associationKind: 'capture', associationId: eventId, mimeType: 'image/jpeg', sizeBytes: bytes.length, widthPx, heightPx },
  });
  if (auth.status !== 200 && auth.status !== 201) throw new Error(`upload authorization HTTP ${auth.status}: ${errCode(auth)}`);
  const { objectId, uploadUrl, uploadHeaders } = auth.json;
  const absolute = new URL(uploadUrl, `${base}/`).toString();
  const sameOrigin = absolute.startsWith(`${base}/`);
  const put = await http('PUT', absolute, {
    raw: true,
    body: bytes,
    headers: uploadHeaders ?? { 'Content-Type': 'image/jpeg' },
    auth: sameOrigin, // never send our token to the object store
  });
  if (put.status < 200 || put.status >= 300) throw new Error(`image PUT HTTP ${put.status}`);
  const fin = await http('POST', `/api/images/${encodeURIComponent(objectId)}/finalize`, { auth: true });
  if (fin.status !== 200) throw new Error(`finalize HTTP ${fin.status}: ${errCode(fin)}`);
  pass('image uploaded + finalized', `${objectId} (${bytes.length} bytes)`);

  const started = Date.now();
  const cap = await http('POST', '/api/captures', {
    auth: true,
    body: {
      eventId,
      hallId: SMOKE_HALL,
      serviceId: service.serviceId,
      capturedAt: new Date().toISOString(),
      imageObjectId: objectId,
      geometry: { widthPx, heightPx, coordinateSpace: 'topdown-normalized-v1' },
      source: 'replay',
    },
  });
  if (cap.status !== 200 && cap.status !== 201 && cap.status !== 202) throw new Error(`capture HTTP ${cap.status}: ${errCode(cap)}`);

  let detail;
  while (Date.now() - started < 180_000) {
    detail = await http('GET', `/api/captures/${encodeURIComponent(eventId)}`);
    if (TERMINAL.has(detail.json?.event?.state)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const state = detail?.json?.event?.state;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const last = detail?.json?.attempts?.at?.(-1);
  if (state === 'succeeded') {
    const px = last?.segmentation?.capturePixelsWasted ?? '?';
    pass('capture analyzed', `${eventId} succeeded in ${secs}s, ${detail.json.measurements?.length ?? 0} foods, ${px} pixels wasted`);
  } else if (state === 'needs_review' || state === 'failed') {
    warn('capture analyzed', `${eventId} ended ${state} in ${secs}s: ${last?.error?.code ?? ''} ${last?.error?.message ?? ''}`.trim());
  } else {
    fail('capture analyzed', `${eventId} still ${state ?? 'unknown'} after ${secs}s`);
  }

  const images = await http('GET', `/api/captures/${encodeURIComponent(eventId)}/images`);
  if (images.status === 200) pass('capture image read URLs');
  else warn('capture image read URLs', `HTTP ${images.status}: ${errCode(images)}`);

  const hidden = await http('GET', `/api/captures?hallId=hall-main&start=${date}&end=${date}&limit=100`);
  const list = Array.isArray(hidden.json) ? hidden.json : hidden.json?.captures ?? [];
  if (hidden.status === 200 && !list.some((c) => c.eventId === eventId)) pass('smoke capture hidden from hall-main');
  else if (hidden.status === 200) fail('smoke capture hidden from hall-main', 'it appears in the hall-main gallery');
  else warn('smoke capture hidden from hall-main', `HTTP ${hidden.status}`);
}

await step('round trip', roundTrip);

const failed = results.filter((r) => r.status === 'FAIL').length;
const warned = results.filter((r) => r.status === 'WARN').length;
console.log(`\n${results.length - failed - warned} passed/skipped, ${warned} warnings, ${failed} failed`);
process.exit(failed ? 1 : 0);
