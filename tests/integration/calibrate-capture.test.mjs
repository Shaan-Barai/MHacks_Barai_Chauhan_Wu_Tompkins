import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * IT_4 K: calibrate → capture through the real capture CLIs against a FAKE
 * backend (fixture-only: no Gemini, SAM, depth worker, R2 or SpacetimeDB).
 *
 *   simulate-camera --calibrate  → synthetic card fixture into an inbox as a
 *     calibration frame → upload (association kind 'calibration', id = the
 *     client-picked cal_ id) → POST /api/calibrations → PUT settings (active,
 *     depth toggle)
 *   simulate-camera --service    → one dish → upload (kind 'capture') →
 *     POST /api/captures. The calibration frame is never submitted as a dish.
 *
 * The fake backend mirrors backend/src/services/calibrationService.ts: every
 * mutation needs `Authorization: Bearer <token>` (401 otherwise), the calibration
 * id is the upload's association id, POST is idempotent per upload. It answers
 * a fixed calibration (k from the fixture's expected N_ref) so the CLI output can
 * be checked; it does NOT measure the card.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CAPTURE = path.join(ROOT, 'capture');
const SIDECAR = path.join(CAPTURE, 'fixtures', 'calibration', 'credit-card-synthetic.json');
const TOKEN = 'it4-fixture-token-6f1c';
const HALL = 'hall-it4';
const SERVICE = 'svc_hall-it4_2026-10-04_dinner';
const READY = existsSync(path.join(CAPTURE, 'node_modules', 'sharp'));

function jpegSize(buf) {
  for (let i = 2; i < buf.length - 9; ) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function fakeBackend() {
  const state = {
    images: new Map(), // objectId -> { kind, id, bytes, finalized }
    calibrations: new Map(),
    settings: new Map(),
    captures: [],
    requests: [],
    calibrationPosts: 0,
  };
  let n = 0;
  const sidecar = JSON.parse(spawnSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(SIDECAR)}, 'utf8'))`]).stdout);
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      const error = (status, code, message) => send(status, { error: { code, message, retryable: false } });
      state.requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization });
      const mutation = req.method !== 'GET';
      if (mutation && req.headers.authorization !== `Bearer ${TOKEN}`) {
        return error(401, 'UNAUTHORIZED', 'This action needs the ingest token or an admin session.');
      }
      const body = raw.length && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : undefined;
      let m;
      if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true, provider: 'fake' });
      if (req.method === 'GET' && url.pathname === '/api/services') {
        return send(200, { services: [{ serviceId: SERVICE, hallId: HALL }] });
      }
      if (req.method === 'POST' && url.pathname === '/api/images/uploads') {
        const objectId = `img_${++n}`;
        state.images.set(objectId, { kind: body.associationKind, id: body.associationId, widthPx: body.widthPx, heightPx: body.heightPx });
        return send(201, { objectId, uploadUrl: `/api/storage/upload/${objectId}`, uploadHeaders: { 'Content-Type': body.mimeType } });
      }
      if (req.method === 'PUT' && (m = url.pathname.match(/^\/api\/storage\/upload\/(.+)$/))) {
        state.images.get(m[1]).bytes = raw;
        return send(200, {});
      }
      if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/images\/(.+)\/finalize$/))) {
        const image = state.images.get(m[1]);
        if (!image?.bytes) return error(409, 'UPLOAD_INCOMPLETE', 'No bytes uploaded.');
        image.finalized = true;
        return send(200, { objectId: m[1] });
      }
      if (req.method === 'POST' && url.pathname === '/api/calibrations') {
        state.calibrationPosts++;
        const image = state.images.get(body.imageObjectId);
        if (!image?.finalized) return error(400, 'IMAGE_NOT_FINALIZED', 'Finalize first.');
        if (image.kind !== 'calibration') return error(400, 'IMAGE_ASSOCIATION_MISMATCH', 'Wrong association.');
        const existing = state.calibrations.get(image.id);
        if (existing) return send(200, existing);
        const N = sidecar.normalized.expectedReferencePixels;
        const k = body.knownAreaCm2 / N;
        const fx = sidecar.normalized.fxPx;
        const calibration = {
          calibrationId: image.id, hallId: body.hallId, cameraId: body.cameraId, createdAt: new Date().toISOString(),
          status: 'succeeded', method: 'reference-area-v1', imageObjectId: body.imageObjectId,
          widthPx: image.widthPx, heightPx: image.heightPx, knownAreaCm2: body.knownAreaCm2,
          referenceLabel: body.referenceLabel, referencePixels: N, cm2PerPx: k,
          intrinsics: { cameraModel: 'logitech-c920s', widthPx: 1024, heightPx: 1024, fxPx: fx, fyPx: fx, cxPx: 512, cyPx: 512, source: 'nominal-fov' },
          cameraHeightCmGeometric: fx * Math.sqrt(k), depth: null, flags: ['depth_unavailable'],
        };
        state.calibrations.set(image.id, calibration);
        return send(201, calibration);
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/calibrations\/([^/]+)$/))) {
        const c = state.calibrations.get(m[1]);
        return c ? send(200, c) : error(404, 'CALIBRATION_NOT_FOUND', 'No calibration has this id.');
      }
      if (url.pathname === '/api/settings/measurement') {
        if (req.method === 'GET') {
          const hallId = url.searchParams.get('hallId');
          return send(200, state.settings.get(hallId) ?? { hallId, depthEnabled: false, activeCalibrationId: null, plateThicknessCm: 1.5, updatedAt: new Date(0).toISOString() });
        }
        const current = state.settings.get(body.hallId) ?? { hallId: body.hallId, depthEnabled: false, activeCalibrationId: null, plateThicknessCm: 1.5 };
        const cal = body.activeCalibrationId && state.calibrations.get(body.activeCalibrationId);
        if (body.activeCalibrationId && (!cal || cal.status !== 'succeeded' || cal.hallId !== body.hallId)) {
          return error(400, 'INVALID_CALIBRATION', 'Only a successful calibration of this hall can be activated.');
        }
        const next = { ...current, ...body, updatedAt: new Date().toISOString() };
        state.settings.set(body.hallId, next);
        return send(200, next);
      }
      if (req.method === 'POST' && url.pathname === '/api/captures') {
        state.captures.push(body);
        return send(201, { event: { ...body, state: 'succeeded' }, deduplicated: false });
      }
      return error(404, 'ROUTE_NOT_FOUND', 'This API route does not exist.');
    });
  });
  return { server, state };
}

function run(args, env, cwd = CAPTURE) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('calibrate → capture through the capture CLIs (fake backend, fixtures only)', { skip: !READY && 'run npm ci in capture/ first' }, () => {
  let backend;
  let api;
  let dir;
  const baseEnv = () => ({ SCRAP_API_URL: api, API_URL: '', SCRAP_INGEST_TOKEN: TOKEN });

  before(async () => {
    const build = spawnSync('npx', ['tsc', '-p', '.'], { cwd: CAPTURE, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    backend = fakeBackend();
    await new Promise((r) => backend.server.listen(0, '127.0.0.1', r));
    api = `http://127.0.0.1:${backend.server.address().port}`;
    dir = await mkdtemp(path.join(tmpdir(), 'scrap-it4-cal-'));
  });

  after(async () => {
    await new Promise((r) => backend.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses without the token, with a message that names SCRAP_INGEST_TOKEN', async () => {
    const r = await run(['scripts/simulate-camera.mjs', '--calibrate', '--inbox', path.join(dir, 'noauth'), '--state-dir', path.join(dir, 'noauth-state'), '--hall', HALL,
      // A variable that is set nowhere, so no .env / local-secrets token is picked up either.
      '--token-env', 'SCRAP_IT4_NO_TOKEN'], { ...baseEnv(), SCRAP_INGEST_TOKEN: '' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /401/);
    assert.match(r.out, /SCRAP_INGEST_TOKEN/);
    assert.equal(backend.state.calibrations.size, 0);
  });

  it('calibrates from the synthetic fixture: upload as calibration, POST, activate, print k and height', async () => {
    const from = backend.state.requests.length;
    const r = await run(['scripts/simulate-camera.mjs', '--calibrate', '--inbox', path.join(dir, 'inbox'), '--state-dir', path.join(dir, 'state'),
      '--hall', HALL, '--depth', 'off'], baseEnv());
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, new RegExp(TOKEN), 'the token is never printed');
    assert.match(r.out, /SYNTHETIC fixture/);
    assert.match(r.out, /k = 0\.0012\d+ cm² per pixel/);
    assert.match(r.out, /geometric \(f·√k\): 45\.0 cm/);
    assert.match(r.out, /Depth Anything V2: not measured/);
    assert.match(r.out, /flags: depth_unavailable/);
    assert.match(r.out, /active calibration for hall-it4; Depth Anything V2 OFF/);

    const [cal] = [...backend.state.calibrations.values()];
    assert.match(cal.calibrationId, /^cal_[0-9A-Z]{26}$/);
    assert.equal(cal.knownAreaCm2, 46.21);
    assert.equal(cal.referenceLabel, 'credit card');
    assert.equal(cal.cameraId, 'uno-q-c920s-1');
    const image = backend.state.images.get(cal.imageObjectId);
    assert.equal(image.kind, 'calibration');
    assert.equal(image.id, cal.calibrationId, 'association id = calibration id');
    assert.deepEqual(jpegSize(image.bytes), { width: 1024, height: 1024 }, 'normalized exactly like a dish');
    assert.equal(backend.state.settings.get(HALL).activeCalibrationId, cal.calibrationId);
    assert.equal(backend.state.settings.get(HALL).depthEnabled, false);
    const mutations = backend.state.requests.slice(from).filter((q) => q.method !== 'GET');
    assert.ok(mutations.length >= 4 && mutations.every((q) => q.auth === `Bearer ${TOKEN}`));
  });

  it('rerunning the calibration reuses it (no new calibration)', async () => {
    const posts = backend.state.calibrationPosts;
    const r = await run(['scripts/ingest-inbox.mjs', '--calibrate', '--inbox', path.join(dir, 'inbox'), '--state-dir', path.join(dir, 'state'),
      '--hall', HALL, '--depth', 'on'], baseEnv());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /already calibrated with this photo/);
    assert.equal(backend.state.calibrationPosts, posts);
    assert.equal(backend.state.calibrations.size, 1);
    assert.equal(backend.state.settings.get(HALL).depthEnabled, true, '--depth on flips the toggle');
  });

  it('a dish captured afterwards is one capture event; the calibration frame is never a dish', async () => {
    const r = await run(['scripts/simulate-camera.mjs', '--inbox', path.join(dir, 'inbox'), '--state-dir', path.join(dir, 'state'),
      '--photos', path.join(CAPTURE, 'fixtures', 'replay', 'images'), '--count', '1', '--service', SERVICE], baseEnv());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /is a calibration frame, not a dish/);
    assert.equal(backend.state.captures.length, 1);
    const capture = backend.state.captures[0];
    assert.equal(capture.source, 'replay');
    assert.equal(capture.hallId, HALL);
    assert.deepEqual([capture.geometry.widthPx, capture.geometry.heightPx], [1024, 1024], 'same geometry as the calibration');
    const kinds = [...backend.state.images.values()].map((i) => i.kind).sort();
    assert.deepEqual(kinds.filter((k) => k === 'calibration').length, 1);
    assert.deepEqual(kinds.filter((k) => k === 'capture').length, 1);
  });
});
