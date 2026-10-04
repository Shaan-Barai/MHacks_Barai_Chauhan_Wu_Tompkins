import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * IT_4 live E2E (area method; Depth Anything V2 was removed 2026-10-04):
 * calibrate → capture → per-food area / grams / CO2e / water → dashboard totals.
 *
 *   menu copy                    the source service's menu (SCRAP_E2E_SERVICE) is uploaded for a
 *                                TEST hall (SCRAP_E2E_CAL_HALL, default hall-e2e-cal), so hall-main's
 *                                calibration and numbers are never touched
 *   simulate-camera --calibrate  synthetic card fixture → upload (kind 'calibration') →
 *                                POST /api/calibrations (real Gemini box + SAM mask on the card) →
 *                                PUT /api/settings/measurement {hallId, activeCalibrationId}
 *   simulate-camera --service    one test2/ photo → real analysis
 *   GET /api/captures            per-food areaCm2 = pixels × k, grams / kg CO2e / L water numbers
 *                                or null; a food with grams has the overlay legend suffix (backend
 *                                physicalLabelSuffix draws exactly when grams is finite; the JPEG
 *                                text itself is not OCR'd)
 *   GET /api/dashboard/impact    estimated totals + physicalCoverage
 *
 * Skipped unless SCRAP_E2E=1. Skips itself cleanly when the backend has no
 * calibration endpoints. Restores the test hall's measurement settings afterwards.
 * Mutations send SCRAP_INGEST_TOKEN (npm run test:e2e:calibration loads ../.env;
 * the capture scripts also read .env / deploy/.run/local-secrets.env). The
 * token and signed URLs are never printed.
 *
 * The fixture is SYNTHETIC (a drawn card) and test2/ photos come from an
 * iPhone, not the C920s: this proves the pipeline and the arithmetic, not the
 * physical accuracy (docs/known-limitations.md).
 *
 * Environment: SCRAP_API_URL / API_URL (default http://localhost:8787),
 * SCRAP_E2E_SERVICE (menu source, default svc_hall-main_2026-10-03_dinner),
 * SCRAP_E2E_CAL_HALL (default hall-e2e-cal; "source" = use the source service's own hall),
 * SCRAP_E2E_PHOTO_DIR (default <repo>/test2), SCRAP_E2E_TIMEOUT_S (default 900).
 */

const LIVE = process.env.SCRAP_E2E === '1';
const API = (process.env.SCRAP_API_URL || process.env.API_URL || 'http://localhost:8787').replace(/\/$/, '');
const TOKEN = process.env.SCRAP_INGEST_TOKEN || undefined;
const SOURCE_SERVICE = process.env.SCRAP_E2E_SERVICE ?? 'svc_hall-main_2026-10-03_dinner';
const CAL_HALL = process.env.SCRAP_E2E_CAL_HALL ?? 'hall-e2e-cal';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const capture = path.join(repo, 'capture');
const PHOTO_DIR = process.env.SCRAP_E2E_PHOTO_DIR ?? path.join(repo, 'test2');
const TIMEOUT_MS = Number(process.env.SCRAP_E2E_TIMEOUT_S ?? 900) * 1000;
const SIDECAR = JSON.parse(readFileSync(path.join(capture, 'fixtures', 'calibration', 'credit-card-synthetic.json'), 'utf8'));
const TERMINAL = new Set(['succeeded', 'needs_review', 'failed']);

async function api(method, route, body) {
  const headers = {};
  if (TOKEN && method !== 'GET') headers.Authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed };
}

function run(args) {
  const res = spawnSync(process.execPath, args, {
    cwd: capture,
    encoding: 'utf8',
    env: { ...process.env, SCRAP_API_URL: API, API_URL: API },
    timeout: TIMEOUT_MS,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (TOKEN) assert.ok(!out.includes(TOKEN), 'the token is never printed');
  return { status: res.status, out };
}

async function waitTerminal(eventId) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const r = await api('GET', `/api/captures/${eventId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    if (TERMINAL.has(r.body.event.state)) return r.body;
    assert.ok(Date.now() < deadline, `${eventId} still ${r.body.event.state} after ${TIMEOUT_MS / 1000} s`);
    await new Promise((res) => setTimeout(res, 3000));
  }
}

const near = (actual, expected, rel) => Math.abs(actual - expected) <= Math.abs(expected) * rel;

describe('IT_4 live: calibration → calibrated area → estimated grams, CO2e + water', { skip: !LIVE }, () => {
  let tmp;
  let service;
  let original;
  let calibration;
  let skipReason;
  let photos;
  let window;

  async function captureOne(photo, label) {
    const r = run(['scripts/simulate-camera.mjs', '--inbox', path.join(tmp, 'inbox'), '--state-dir', path.join(tmp, 'state'),
      '--photos', photo, '--service', service.serviceId]);
    assert.equal(r.status, 0, r.out.slice(-1500));
    const ids = [...r.out.matchAll(/→ (cap_[0-9A-Z]+) /g)].map((m) => m[1]);
    assert.equal(ids.length, 1, `${label}: one capture:\n${r.out.slice(-800)}`);
    const detail = await waitTerminal(ids[0]);
    assert.notEqual(detail.event.state, 'failed', `${label}: ${JSON.stringify(detail.attempts?.at(-1)?.error ?? {})}`);
    const list = await api('GET', `/api/captures?hallId=${service.hallId}&start=${window.start}&end=${window.end}&limit=200`);
    assert.equal(list.status, 200);
    const rows = Array.isArray(list.body) ? list.body : list.body.captures;
    const row = rows.find((c) => c.eventId === ids[0]);
    assert.ok(row, `${label}: ${ids[0]} in GET /api/captures`);
    return { eventId: ids[0], detail, row };
  }

  before(async () => {
    const health = await api('GET', '/api/health').catch(() => null);
    assert.ok(health?.status === 200, `backend not reachable at ${API}`);
    const probe = await api('GET', '/api/settings/measurement?hallId=hall-main');
    if (probe.status === 404) {
      skipReason = 'backend has no /api/settings/measurement (IT_4 B not deployed)';
      return;
    }
    const services = await api('GET', '/api/services');
    const source = services.body.services?.find((s) => s.serviceId === SOURCE_SERVICE);
    assert.ok(source, `service ${SOURCE_SERVICE} exists (seed it: deploy/local.sh seed --live-dinner)`);
    service = source;
    if (CAL_HALL !== 'source' && CAL_HALL !== source.hallId) {
      // Copy the source menu to the test hall (same date and meal; idempotent: an identical
      // re-upload is 'unchanged'). Display names are kept, so waste factors still match.
      const menu = await api('GET', `/api/menus/by-service/${encodeURIComponent(SOURCE_SERVICE)}`);
      assert.equal(menu.status, 200, JSON.stringify(menu.body).slice(0, 300));
      const { service: src, items } = menu.body.menu;
      const up = await api('POST', '/api/menus/upload', {
        hallId: CAL_HALL,
        hallTimezone: src.hallTimezone ?? 'America/Detroit',
        days: [{ date: src.serviceDate, [src.mealLabel ?? 'dinner']: items.map((i) => ({
          name: i.displayName, ...(i.category ? { category: i.category } : {}), ...(i.description ? { description: i.description } : {}) })) }],
      });
      assert.ok(up.status === 200 || up.status === 201, `menu copy for ${CAL_HALL}: HTTP ${up.status} ${JSON.stringify(up.body).slice(0, 300)}`);
      service = up.body.results[0].menu.service;
      assert.equal(service.hallId, CAL_HALL);
    }
    original = (await api('GET', `/api/settings/measurement?hallId=${service.hallId}`)).body;
    const date = service.serviceDate ?? SOURCE_SERVICE.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? new Date().toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    window = { start: shift([date, today].sort()[0], -1), end: shift([date, today].sort()[1], 1) };
    tmp = await mkdtemp(path.join(tmpdir(), 'scrap-e2e-cal-'));
    const build = spawnSync('npx', ['tsc', '-p', '.'], { cwd: capture, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stdout);
    photos = spawnSync('ls', [PHOTO_DIR], { encoding: 'utf8' }).stdout.split('\n').filter((f) => /\.jpe?g$/i.test(f)).sort()
      .map((f) => path.join(PHOTO_DIR, f));
    assert.ok(photos.length >= 2, `need 2 photos in ${PHOTO_DIR}`);
  });

  after(async () => {
    if (service && original?.hallId) {
      // Restore the previous active calibration (null is allowed).
      const body = { hallId: original.hallId, activeCalibrationId: original.activeCalibrationId ?? null };
      const r = await api('PUT', '/api/settings/measurement', body);
      if (r.status !== 200) console.log(`# could not restore measurement settings: HTTP ${r.status}`);
    }
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('calibrates from the synthetic credit-card fixture', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const r = run(['scripts/simulate-camera.mjs', '--calibrate', '--inbox', path.join(tmp, 'cal-inbox'), '--state-dir', path.join(tmp, 'state'),
      '--hall', service.hallId]);
    assert.equal(r.status, 0, r.out.slice(-1500));
    const id = r.out.match(/calibrationId: (cal_[0-9A-Z]+)/)?.[1];
    assert.ok(id, r.out.slice(-800));
    const res = await api('GET', `/api/calibrations/${id}`);
    assert.equal(res.status, 200);
    calibration = res.body;
    assert.equal(calibration.status, 'succeeded', JSON.stringify(calibration.error ?? {}));
    assert.equal(calibration.method, 'reference-area-v1');
    assert.deepEqual([calibration.widthPx, calibration.heightPx], [1024, 1024], 'same geometry as normalized captures');
    assert.ok(Number.isInteger(calibration.referencePixels) && calibration.referencePixels > 0);
    assert.ok(Math.abs(calibration.cm2PerPx - calibration.knownAreaCm2 / calibration.referencePixels) < 1e-12, 'k = area / N_ref');
    const expectedN = SIDECAR.normalized.expectedReferencePixels;
    assert.ok(near(calibration.referencePixels, expectedN, 0.15), `N_ref ${calibration.referencePixels} within 15% of the drawn ${expectedN}`);
    assert.ok(near(calibration.intrinsics.fxPx, SIDECAR.normalized.fxPx, 0.01), `crop-aware fx ${calibration.intrinsics.fxPx}`);
    assert.ok(near(calibration.cameraHeightCmGeometric, SIDECAR.design.cameraHeightCm, 0.1), `geometric height ${calibration.cameraHeightCmGeometric} cm ≈ 45`);
    const settings = (await api('GET', `/api/settings/measurement?hallId=${service.hallId}`)).body;
    assert.equal(settings.activeCalibrationId, id);
    const images = await api('GET', `/api/calibrations/${id}/images`);
    assert.equal(images.status, 200);
    assert.ok(images.body.photo?.url, 'calibration photo in object storage');
    console.log(`# calibration ${id}: N_ref ${calibration.referencePixels} (drawn ≈ ${expectedN}), k ${calibration.cm2PerPx.toExponential(4)} cm²/px, ` +
      `camera height ${calibration.cameraHeightCmGeometric.toFixed(1)} cm (f·√k), flags [${calibration.flags.join(', ')}]`);
  });

  it('a capture gets areaCm2 = pixels × k and estimated grams / CO2e / water', async (t) => {
    if (skipReason || !calibration) return t.skip(skipReason ?? 'no calibration');
    const { eventId, row } = await captureOne(photos[0], 'area');
    assert.equal(row.calibrationId, calibration.calibrationId);
    assert.equal(row.physicalMethod, 'area-calibrated-v1');
    const named = row.items.filter((i) => i.itemId !== null && i.pixels > 0);
    assert.ok(named.length > 0, 'at least one named food');
    for (const item of row.items) {
      if (item.itemId === null) {
        assert.equal(item.grams, null, 'unknown food has no grams (unknown_item)');
        continue;
      }
      if (item.areaCm2 !== null && item.pixels > 0) {
        assert.ok(near(item.areaCm2, item.pixels * calibration.cm2PerPx, 0.01), `${item.displayName}: area ${item.areaCm2} = ${item.pixels} px × k`);
      }
      for (const k of ['grams', 'kgCo2e', 'waterLitres']) {
        assert.ok(item[k] === null || (Number.isFinite(item[k]) && item[k] >= 0), `${item.displayName}: ${k}`);
      }
    }
    const withGrams = named.filter((i) => i.grams !== null);
    assert.ok(withGrams.length > 0, 'some food has estimated grams ⇒ the overlay legend carries the "g · kg CO2e · L water (est.)" suffix');
    assert.ok(row.hasOverlay, 'overlay rendered');
    const imgs = await api('GET', `/api/captures/${eventId}/images`);
    const overlay = await fetch(imgs.body.overlay.url);
    assert.equal(overlay.status, 200);
    console.log(`# area capture ${eventId}: ` + withGrams.map((i) => `${i.displayName} ${i.pixels} px → ${i.areaCm2?.toFixed(1)} cm² · ${i.grams?.toFixed(0)} g · ${i.kgCo2e?.toFixed(3)} kg CO2e · ${i.waterLitres?.toFixed(1)} L`).join('; '));
  });

  it('dashboard impact shows estimated CO2e / water totals with calibrated-plate coverage', async (t) => {
    if (skipReason || !calibration) return t.skip(skipReason ?? 'no calibration');
    const r = await api('GET', `/api/dashboard/impact?hallId=${service.hallId}&start=${window.start}&end=${window.end}`);
    assert.equal(r.status, 200);
    const { totals } = r.body;
    const cov = totals.physicalCoverage;
    assert.ok(cov && cov.calibratedCaptures >= 1 && cov.calibratedCaptures <= cov.analyzedCaptures, JSON.stringify(cov));
    assert.ok(Number.isFinite(totals.kgCo2e) && totals.kgCo2e >= 0, 'estimated kg CO2e total');
    assert.ok(Number.isFinite(totals.waterLitres) && totals.waterLitres >= 0, 'estimated water total');
    assert.ok(Number.isInteger(totals.pixels), 'pixels stay the headline measurement');
    console.log(`# impact: ${totals.pixels} px; est. ${totals.grams?.toFixed(0)} g, ${totals.kgCo2e.toFixed(3)} kg CO2e, ${totals.waterLitres.toFixed(1)} L ` +
      `from ${cov.calibratedCaptures}/${cov.analyzedCaptures} calibrated plates`);
  });
});
