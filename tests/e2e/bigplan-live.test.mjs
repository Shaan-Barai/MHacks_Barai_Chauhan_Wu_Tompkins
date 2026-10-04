import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * BIG-PLAN live end-to-end (BIG-PLAN.md §5): simulated camera inbox →
 * bridge → R2 + SpacetimeDB → Gemini classify/boxes → SAM 2.1 masks →
 * overlay in R2 → impact dashboard, plate images, AI recommendation.
 *
 * Skipped unless SCRAP_E2E=1, so CI never claims a live path from fixtures.
 * Needs a RUNNING backend (Gemini key, OBJECT_STORAGE_PROVIDER=r2,
 * SpacetimeDB) and the SAM worker. Costs a few Gemini calls per photo, so the
 * photo count is capped at 4.
 *
 *   cd tests && SCRAP_E2E=1 SPACETIMEDB_MODULE=scrap-bigplan npm run test:e2e:bigplan
 *   (the script loads ../.env with --env-file; variables already set in the
 *   shell win over the file. Pass test FILES to node --test, never the
 *   e2e/ directory: `node --test tests/e2e` treats the folder as one script and fails.)
 *
 * Environment (all optional):
 *   API_URL                default http://localhost:8787
 *   SAM_WORKER_URL         default http://127.0.0.1:8790
 *   SCRAP_E2E_SERVICE      default svc_hall-main_2026-10-03_dinner (seeded with
 *                          `cd backend && npm run seed` when missing)
 *   SCRAP_E2E_PHOTOS       photos from test2/ to send, 1-4 (default 3)
 *   SCRAP_E2E_DEDUPE=1     run the bridge with Gemini dish grouping instead of
 *                          --no-dedupe (see "Dedupe" below)
 *   SCRAP_E2E_TIMEOUT_S    max wait for analysis (default 900)
 *   SCRAP_E2E_START/END    dashboard window (YYYY-MM-DD; default covers the
 *                          service date and today)
 *   SPACETIMEDB_URI / SPACETIMEDB_MODULE / SPACETIMEDB_TOKEN
 *                          when set, image_object rows are checked by SQL
 *                          (module = the database the backend uses, e.g. scrap-bigplan)
 *
 * Dedupe: the default is --no-dedupe. Every simulated photo is a distinct
 * manual capture (a different plate), so "one capture per photo" is the
 * expected result by construction, and the run spends no Gemini calls on
 * same-dish checks. With dedupe on, an 'unsure' verdict would merge two
 * different plates on purpose (BRIDGE.md §3: missing a dish beats counting
 * one twice), which would make the count assertion flaky. Grouping itself is
 * covered by capture/test/bridge.test.ts and the BRIDGE.md live check.
 *
 * Signed URLs are fetched but never printed.
 */
const LIVE_E2E = process.env.SCRAP_E2E === '1';
const API = (process.env.API_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const SAM = (process.env.SAM_WORKER_URL ?? 'http://127.0.0.1:8790').replace(/\/$/, '');
const SERVICE = process.env.SCRAP_E2E_SERVICE ?? 'svc_hall-main_2026-10-03_dinner';
const PHOTO_COUNT = Number(process.env.SCRAP_E2E_PHOTOS ?? 3);
const DEDUPE = process.env.SCRAP_E2E_DEDUPE === '1';
const TIMEOUT_MS = Number(process.env.SCRAP_E2E_TIMEOUT_S ?? 900) * 1000;
const STDB = process.env.SPACETIMEDB_URI
  ? {
      uri: process.env.SPACETIMEDB_URI.replace(/\/$/, ''),
      module: process.env.SPACETIMEDB_MODULE ?? 'scrap',
      token: process.env.SPACETIMEDB_TOKEN || undefined,
    }
  : null;

const repo = fileURLToPath(new URL('../../', import.meta.url));
const capture = path.join(repo, 'capture');
const TERMINAL = new Set(['succeeded', 'needs_review', 'failed']);

async function api(method, route, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(new URL(route, `${API}/`), init);
  const text = await res.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed };
}

/** Accept either a bare array or `{ <key>: [...] }`. */
function list(body, key) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.[key])) return body[key];
  return null;
}

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, API_URL: API }, ...options });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** SpacetimeDB HTTP SQL → array of { column: rawValue }. */
async function sql(query) {
  const headers = STDB.token ? { Authorization: `Bearer ${STDB.token}` } : {};
  const res = await fetch(`${STDB.uri}/v1/database/${encodeURIComponent(STDB.module)}/sql`, {
    method: 'POST',
    headers,
    body: query,
  });
  assert.equal(res.ok, true, `SpacetimeDB SQL failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const [result] = await res.json();
  if (!result) return [];
  const names = result.schema.elements.map((e) => (typeof e.name === 'string' ? e.name : e.name?.some));
  return result.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
}

/** SATS JSON option: { some: x } / { none: [] } or [0, x] / [1, []]. */
function isSome(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value) && value.length === 2 && (value[0] === 0 || value[0] === 1)) return value[0] === 0;
  if (typeof value === 'object' && 'none' in value) return false;
  return value !== '';
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function windowDates(serviceDate) {
  const today = new Date().toISOString().slice(0, 10);
  const shift = (d, days) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const lo = [serviceDate, today].sort()[0];
  const hi = [serviceDate, today].sort()[1];
  return {
    start: process.env.SCRAP_E2E_START ?? shift(lo, -1),
    end: process.env.SCRAP_E2E_END ?? shift(hi, 1),
  };
}

describe('BIG-PLAN live e2e: simulated camera → R2/SpacetimeDB → Gemini+SAM → dashboard', { skip: !LIVE_E2E }, () => {
  let tmp;
  let service;
  let window;
  /** eventIds minted by the bridge for this run, one per photo. */
  let eventIds = [];
  /** eventId → CaptureImages */
  const images = new Map();

  before(async () => {
    assert.ok(Number.isInteger(PHOTO_COUNT) && PHOTO_COUNT >= 1 && PHOTO_COUNT <= 4, 'SCRAP_E2E_PHOTOS must be 1-4 (Gemini cost cap)');
    tmp = await mkdtemp(path.join(tmpdir(), 'scrap-bigplan-e2e-'));
  });

  after(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('backend and SAM worker are healthy', async () => {
    const health = await api('GET', '/api/health');
    assert.equal(health.status, 200, `backend not reachable at ${API}`);
    assert.equal(health.body.provider, 'r2', 'the backend must use OBJECT_STORAGE_PROVIDER=r2 for this run');
    let sam;
    try {
      sam = await fetch(`${SAM}/health`);
    } catch {
      assert.fail(`SAM worker not reachable at ${SAM} (vision/sam/README.md)`);
    }
    assert.equal(sam.status, 200, 'SAM worker /health');
  });

  it('the demo dinner service exists (seeded when missing)', async () => {
    const find = async () => (list((await api('GET', '/api/services')).body, 'services') ?? []).find((s) => s.serviceId === SERVICE);
    service = await find();
    if (!service) {
      const seed = run(process.execPath, [path.join(repo, 'backend', 'scripts', 'seed.mjs')]);
      assert.equal(seed.status, 0, `seed failed:\n${seed.out.slice(-1500)}`);
      service = await find();
    }
    assert.ok(service, `service ${SERVICE} is missing even after seeding`);
    const menu = await api('GET', `/api/menus/by-service/${SERVICE}`);
    assert.equal(menu.status, 200);
    assert.ok(menu.body.menu.items.length > 0, 'the service has menu items');
    window = windowDates(service.serviceDate);
  });

  it('simulate-camera → bridge (one pass) → exactly one capture per photo', { timeout: TIMEOUT_MS }, async () => {
    const build = run('npm', ['run', 'build'], { cwd: capture });
    assert.equal(build.status, 0, `capture build failed:\n${build.out.slice(-1500)}`);
    const inbox = path.join(tmp, 'inbox');
    const state = path.join(tmp, 'state');

    const sim = run(process.execPath, [
      path.join(capture, 'scripts', 'simulate-camera.mjs'),
      '--inbox', inbox,
      '--count', String(PHOTO_COUNT),
    ]);
    assert.equal(sim.status, 0, sim.out);

    const bridgeArgs = [
      path.join(capture, 'scripts', 'ingest-inbox.mjs'),
      '--service', SERVICE,
      '--inbox', inbox,
      '--state-dir', state,
    ];
    if (!DEDUPE) bridgeArgs.push('--no-dedupe');
    const bridge = run(process.execPath, bridgeArgs, { timeout: TIMEOUT_MS });
    assert.equal(bridge.status, 0, `bridge failed:\n${bridge.out.slice(-3000)}`);

    const groups = JSON.parse(readFileSync(path.join(state, '.inbox-groups.json'), 'utf8')).groups;
    eventIds = Object.values(groups).map((g) => g.eventId);
    assert.equal(eventIds.length, PHOTO_COUNT, 'one dish per simulated photo');
    assert.ok(eventIds.every(Boolean), 'every dish was ingested');
    assert.equal(new Set(eventIds).size, PHOTO_COUNT, 'distinct capture events');

    // Rerunning the bridge adds nothing (state + backend dedupe by eventId).
    const again = run(process.execPath, bridgeArgs, { timeout: TIMEOUT_MS });
    assert.equal(again.status, 0, again.out);
    assert.doesNotMatch(again.out, /✓ dish/, 'a rerun must not ingest any dish again');
  });

  it('analysis finishes for every capture; each is a simulated (replay) capture with a calibration', { timeout: TIMEOUT_MS }, async () => {
    assert.equal(eventIds.length, PHOTO_COUNT, 'previous step produced the captures');
    const deadline = Date.now() + TIMEOUT_MS;
    const details = new Map();
    while (details.size < eventIds.length) {
      for (const id of eventIds) {
        if (details.has(id)) continue;
        const res = await api('GET', `/api/captures/${id}`);
        assert.equal(res.status, 200, `GET /api/captures/${id}: ${JSON.stringify(res.body).slice(0, 300)}`);
        if (TERMINAL.has(res.body.event.state)) details.set(id, res.body);
      }
      if (details.size < eventIds.length) {
        assert.ok(Date.now() < deadline, 'analysis did not finish before SCRAP_E2E_TIMEOUT_S');
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    for (const [id, d] of details) {
      assert.equal(d.event.source, 'replay', 'simulate-camera dishes are labeled replay, not camera');
      assert.equal(d.event.serviceId, SERVICE);
      assert.deepEqual(
        [d.event.geometry.widthPx, d.event.geometry.heightPx, d.event.geometry.coordinateSpace],
        [1024, 1024, 'topdown-normalized-v1'],
      );
      const attempt = d.attempts.find((a) => a.attemptId === d.countedAttemptId) ?? d.attempts.at(-1);
      assert.ok(attempt, `${id}: an analysis attempt exists`);
      assert.notEqual(d.event.state, 'failed', `${id} failed: ${JSON.stringify(attempt.error ?? {}).slice(0, 400)}`);
      assert.ok(attempt.segmentation, `${id}: Gemini → SAM segmentation result present`);
      const cal = attempt.calibration;
      assert.ok(cal, `${id}: plate calibration persisted (BIG-PLAN D2)`);
      assert.ok(['plate-fit-v1', 'configured-default'].includes(cal.method));
      assert.ok(cal.cm2PerPx > 0 && cal.plateDiameterPx > 0);
      assert.equal(cal.method === 'configured-default', cal.flags.includes('calibration_default'));
      console.log(
        `# ${id}: ${d.event.state}, ${attempt.segmentation.countStatus}, ` +
          `${attempt.segmentation.capturePixelsWasted ?? '–'} px, calibration ${cal.method} ` +
          `(${cal.plateDiameterPx} px plate), ${d.measurements.length} measurements`,
      );
    }

    // GET /api/captures lists each of them exactly once (CaptureListItem).
    const listed = await api('GET', `/api/captures?start=${window.start}&end=${window.end}`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body).slice(0, 300));
    const rows = list(listed.body, 'captures');
    assert.ok(rows, 'GET /api/captures returns a capture list');
    for (const id of eventIds) {
      const mine = rows.filter((r) => r.eventId === id);
      assert.equal(mine.length, 1, `${id} listed exactly once`);
      assert.ok(TERMINAL.has(mine[0].state));
      assert.equal(typeof mine[0].hasOverlay, 'boolean');
    }
  });

  it('GET /api/captures/:id/images returns working original, overlay and mask URLs', async () => {
    for (const id of eventIds) {
      const res = await api('GET', `/api/captures/${id}/images`);
      assert.equal(res.status, 200, `images for ${id}: ${JSON.stringify(res.body.error ?? {}).slice(0, 300)}`);
      const imgs = res.body;
      assert.equal(imgs.eventId, id);
      assert.ok(imgs.original, `${id}: original photo`);
      assert.ok(imgs.overlay, `${id}: segmented overlay (BIG-PLAN D7)`);
      assert.ok(Array.isArray(imgs.masks));
      images.set(id, imgs);
      for (const img of [imgs.original, imgs.overlay, ...imgs.masks]) {
        assert.ok(Date.parse(img.expiresAt) > Date.now(), `${img.objectId}: read URL not yet expired`);
        const got = await fetch(img.url);
        // Never print img.url: it is a signed URL.
        assert.equal(got.status, 200, `${img.objectId}: read URL returned ${got.status}`);
        assert.match(got.headers.get('content-type') ?? '', /^image\//, `${img.objectId}: image content type`);
        await got.arrayBuffer();
      }
      console.log(`# ${id}: original + overlay + ${imgs.masks.length} mask URLs fetched (HTTP 200)`);
    }
  });

  it('SpacetimeDB holds image_object references (provider r2) for photo, overlay and masks — no bytes', { skip: !STDB && 'SPACETIMEDB_URI not set' }, async () => {
    assert.equal(images.size, eventIds.length, 'previous step loaded the image sets');
    for (const [id, imgs] of images) {
      const events = await sql(`SELECT * FROM capture_event WHERE event_id = ${quote(id)}`);
      assert.equal(events.length, 1, `${id}: one capture_event row`);
      const expected = [
        [imgs.original, 'capture'],
        [imgs.overlay, 'overlay'],
        ...imgs.masks.map((m) => [m, 'mask']),
      ];
      for (const [img, kind] of expected) {
        const [row, ...extra] = await sql(`SELECT * FROM image_object WHERE object_id = ${quote(img.objectId)}`);
        assert.ok(row && extra.length === 0, `${img.objectId}: one image_object row`);
        assert.equal(row.provider, 'r2', `${img.objectId}: stored in R2`);
        assert.equal(row.state, 'finalized');
        assert.equal(row.association_kind, kind, `${img.objectId}: association kind`);
        if (kind !== 'mask') assert.equal(row.association_id, id);
        assert.ok(row.object_key && !/^https?:/.test(row.object_key), 'a stable key, not a URL');
        for (const [col, value] of Object.entries(row)) {
          assert.ok(!(typeof value === 'string' && value.length > 4096), `${col}: no blobs in SpacetimeDB`);
        }
      }
      const attempts = await sql(`SELECT * FROM analysis_attempt WHERE event_id = ${quote(id)}`);
      assert.ok(attempts.length >= 1, `${id}: analysis_attempt row`);
      const calCols = Object.keys(attempts[0]).filter((c) => c.includes('calibration'));
      assert.ok(calCols.length > 0, 'analysis_attempt has a calibration column');
      assert.ok(attempts.some((a) => calCols.some((c) => isSome(a[c]))), `${id}: calibration stored`);
      const measurements = await sql(`SELECT * FROM food_measurement WHERE event_id = ${quote(id)}`);
      console.log(`# ${id}: capture_event + ${expected.length} image_object (r2) + ${attempts.length} attempt + ${measurements.length} food_measurement rows`);
    }
  });

  it('GET /api/dashboard/impact has totals, foods to target and most wasted', async () => {
    const res = await api('GET', `/api/dashboard/impact?start=${window.start}&end=${window.end}&hallId=${service.hallId}`);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const d = res.body;
    assert.ok(d.totals.captures >= eventIds.length, 'totals count this run');
    assert.ok(d.totals.analyzedCaptures >= 1);
    assert.ok(Number.isInteger(d.totals.pixels) && d.totals.pixels > 0, 'Pixels wasted total');
    assert.ok(d.totals.grams === null || d.totals.grams > 0);
    assert.ok(d.totals.wasteFactorsVersion);
    assert.ok(Array.isArray(d.targets) && d.targets.length > 0, 'foods to target');
    assert.ok(Array.isArray(d.mostWasted) && d.mostWasted.length > 0, 'most wasted');
    assert.ok(d.mostWasted.some((r) => r.impact.grams !== null), 'at least one item has an estimated weight');
    assert.ok(d.targets.some((r) => r.perPortion !== null), 'at least one per-portion rate');
    assert.equal(d.labels.estimate, true);
    // Nutrition is reported separately and never inside impactUsd (D1): only shape here.
    assert.ok('nutrientDaysLost' in d.totals);
    const top = d.mostWasted[0];
    console.log(
      `# impact: ${d.totals.captures} captures, ${d.totals.pixels} px, ` +
        `${d.totals.grams === null ? '–' : d.totals.grams.toFixed(0)} g est.; most wasted ${top.displayName}`,
    );
  });

  it('GET /api/recommendation returns grounded text', async () => {
    const res = await api('GET', `/api/recommendation?start=${window.start}&end=${window.end}&hallId=${service.hallId}`);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const r = res.body;
    assert.equal(typeof r.text, 'string');
    assert.ok(r.text.trim().length > 0, 'recommendation text');
    assert.ok(['gemini', 'fallback'].includes(r.source));
    assert.ok(Array.isArray(r.bullets));
    assert.ok(r.generatedAt && r.inputVersion);
    console.log(`# recommendation source: ${r.source}, ${r.bullets.length} bullets`);
  });
});
