/**
 * Live: reading the app never changes the database. Counts every table's rows
 * and every Storage object, then starts the real backend (serving the built
 * dashboard), calls every GET route with real ids and loads every dashboard
 * page in Chrome, and counts again: nothing may change. Gemini is off for the
 * run (no key passed), so it costs nothing.
 * Skipped (with a message) without the SUPABASE_* variables or a built dashboard.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO, supabaseAvailable } from '../support/stack.mjs';

const require = createRequire(`${REPO}backend/package.json`);
const DIST = path.join(REPO, 'frontend', 'dist', 'index.html');
const skip = !supabaseAvailable() ? 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set' : !existsSync(DIST) ? 'frontend/dist not built' : false;
const PORT = 8961;
const HALL = 'hall-main';
const PAGES = ['/dashboard', '/statistics', '/menus', '/portions', '/production', '/forecast', '/behind-the-scenes', '/settings', '/admin'];

async function snapshot(db) {
  const names = [
    'hall', 'dish', 'meal_service', 'menu_item', 'menu_item_revision', 'reference_portion', 'image_object', 'capture_event',
    'analysis_attempt', 'food_measurement', 'capture_count', 'segmentation_region', 'attempt_calibration', 'camera_calibration',
    'measurement_settings', 'simulated_attendance', 'portions_served', 'insight', 'capture_visibility', 'dashboard_view', 'scan_info',
    'demo_marker', 'menu_cycle', 'production_log', 'attendance', 'context_day', 'forecast', 'forecast_outcome',
  ];
  const out = {};
  for (const t of names) {
    const { count, error } = await db.from(t).select('*', { count: 'exact', head: true });
    if (error) throw new Error(`count ${t}: ${error.message}`);
    out[t] = count;
  }
  // Storage objects, folder by folder (top level is enough to see any new upload).
  const bucket = db.storage.from(process.env.OBJECT_STORAGE_CONTAINER || 'scrap-images');
  const { data: top } = await bucket.list('', { limit: 1000 });
  for (const entry of top ?? []) {
    if (entry.id !== null) continue;
    let n = 0;
    const walk = async (prefix) => {
      for (let offset = 0; ; offset += 1000) {
        const { data } = await bucket.list(prefix, { limit: 1000, offset });
        for (const e of data ?? []) e.id === null ? await walk(`${prefix}/${e.name}`) : n++;
        if ((data ?? []).length < 1000) break;
      }
    };
    await walk(entry.name);
    out[`storage:${entry.name}/`] = n;
  }
  return out;
}

describe('reading the app never changes Supabase', { skip }, () => {
  let server;
  after(() => server?.kill());

  it('every GET route and every dashboard page leave every row and object count unchanged', { timeout: 300_000 }, async () => {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const before = await snapshot(db);

    server = spawn(process.execPath, [path.join(REPO, 'backend/dist/backend/src/server.js')], {
      cwd: path.join(REPO, 'backend'),
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_FRONTEND: '1', GEMINI_API_KEY: '', DEMO_SEED: '', SCRAP_LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    server.stderr.on('data', (d) => (log += d));
    server.stdout.on('data', (d) => (log += d));
    const base = `http://127.0.0.1:${PORT}`;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* starting */
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // Real ids for the parameterized routes.
    const { data: svc } = await db.from('meal_service').select('service_id, service_date, meal_label').eq('hall_id', HALL).order('service_date').limit(1);
    const { data: ev } = await db.from('capture_event').select('event_id, image_object_id').eq('hall_id', HALL).limit(1);
    const { data: ref } = await db.from('reference_portion').select('baseline_id').limit(1);
    const s = svc?.[0];
    const window = `hallId=${HALL}&start=2026-09-01&end=2026-10-31`;
    const query = {
      '/api/menus': `hallId=${HALL}&date=${s.service_date}`,
      '/api/menus/days': window,
      '/api/services': `hallId=${HALL}`,
      '/api/portions-served': `hallId=${HALL}&serviceId=${s.service_id}`,
      '/api/portions-served/benchmark': `hallId=${HALL}&serviceId=${s.service_id}`,
      '/api/admin/captures': window,
      '/api/captures': window,
      '/api/captures/retryable': window,
      '/api/observations': `serviceId=${s.service_id}`,
      '/api/attendance': `serviceId=${s.service_id}`,
      '/api/dashboard/summary': `hallId=${HALL}&serviceId=${s.service_id}`,
      '/api/dashboard/daily': window,
      '/api/dashboard/cards': `hallId=${HALL}&today=2026-10-25`,
      '/api/dashboard/meal': `hallId=${HALL}&date=${s.service_date}&meal=${s.meal_label}`,
      '/api/dashboard/plates': `hallId=${HALL}&date=${s.service_date}&meal=${s.meal_label}`,
      '/api/dashboard/impact': window,
      '/api/dashboard/impact/daily': window,
      '/api/recommendation': window,
      '/api/calibrations': `hallId=${HALL}`,
      '/api/settings/measurement': `hallId=${HALL}`,
      '/api/dashboard/totals': `hallId=${HALL}&today=2026-10-25`,
      '/api/production-log': `hallId=${HALL}`,
      '/api/forecast/summary': window,
      '/api/suggestions': `hallId=${HALL}`,
      '/api/demo/status': `hallId=${HALL}`,
    };
    const params = {
      ':serviceId': s.service_id, ':baselineId': ref?.[0]?.baseline_id ?? 'none', ':objectId': ev?.[0]?.image_object_id ?? 'none',
      ':eventId': ev?.[0]?.event_id ?? 'none', ':calibrationId': 'none', ':id': 'none', ':objectKey(*)': 'none.png',
    };
    const routes = [...readFileSync(path.join(REPO, 'backend/src/http/app.ts'), 'utf8').matchAll(/app\.get\(\s*'([^']+)'/g)].map((m) => m[1]);
    const failures = [];
    for (const route of routes) {
      let p = route;
      for (const [k, v] of Object.entries(params)) p = p.replace(k, encodeURIComponent(v));
      const res = await fetch(`${base}${p}${query[route] ? `?${query[route]}` : ''}`);
      if (res.status >= 500) failures.push(`${route} ${res.status}`);
    }

    // Every dashboard page in a real browser (each page makes its own GETs).
    let pagesLoaded = 0;
    try {
      const { chromium } = createRequire(`${REPO}tests/package.json`)('playwright-core');
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      const page = await browser.newPage();
      for (const p of PAGES) {
        await page.goto(`${base}${p}`, { waitUntil: 'networkidle' });
        pagesLoaded++;
      }
      await browser.close();
    } catch (err) {
      console.log(`[gets-readonly] pages not loaded in a browser: ${err.message}`);
    }

    const afterCounts = await snapshot(db);
    console.log(`[gets-readonly] ${routes.length} GET routes, ${pagesLoaded}/${PAGES.length} pages; ${Object.keys(before).length} counts compared`);
    assert.deepEqual(failures, [], `server errors: ${failures.join(', ')}\n${log.slice(-800)}`);
    assert.deepEqual(afterCounts, before, 'reading must not create, change or delete anything');
    assert.equal(pagesLoaded, PAGES.length, 'every page loaded');
  });
});
