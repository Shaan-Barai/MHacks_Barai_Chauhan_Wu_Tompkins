/**
 * DASHBOARD SMOKE TEST (Playwright, system Chrome). The page loads and shows
 * total waste, waste per portion, most wasted foods, at least one original
 * and one segmented image, and a recommendation.
 *
 *   cd tests && npm run test:smoke
 *
 * By default it builds its own stack, offline: the real backend in-process
 * (fake Gemini + fake SAM, local-dev storage) with three test2/ photos
 * ingested for today, and the real frontend (Vite dev server) proxied to it.
 * Set SMOKE_URL=http://localhost:5173 to check an already running dashboard
 * instead (it must have scanned plates in the last 30 days).
 * A full-page screenshot is saved to images/smoke/dashboard.png.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { REPO, backend, boxFillerSam, data, fakeGemini, httpAdapter, startBackend, test2Photos } from '../support/stack.mjs';

const HALL = 'hall-main';
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit' }).format(new Date());

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up`);
}

describe('dashboard smoke test', () => {
  let stack;
  let vite;
  let browser;
  let url = process.env.SMOKE_URL;

  before(async () => {
    if (!url) {
      const gemini = fakeGemini();
      stack = await startBackend({ analyzer: new backend.maskAnalyzer.MaskAnalyzer(gemini.gateway, boxFillerSam()) });
      const serviceId = `svc_${HALL}_${TODAY}_dinner`;
      const menuId = `menu_${HALL}_${TODAY}_dinner`;
      const foods = ['Pepperoni Pizza', 'Farro', 'Ancho Flank Steak'];
      const menu = {
        service: { serviceId, hallId: HALL, hallTimezone: 'America/Detroit', serviceDate: TODAY, mealLabel: 'dinner', menuId, menuVersion: 1 },
        items: foods.map((f) => ({ itemId: `item_${HALL}_${TODAY}_${data.factorKeyFor(f)}`, menuId, displayName: f, category: 'Dinner' })),
      };
      await stack.repo.upsertMenu(menu);
      await stack.repo.replacePortionsServed(serviceId, 1, menu.items.map((it, i) => ({
        recordId: JSON.stringify([serviceId, 1, it.itemId]), hallId: HALL, serviceId, serviceDate: TODAY, menuId, menuVersion: 1, itemId: it.itemId, count: 120 + 40 * i, source: 'demo', updatedAt: new Date().toISOString(),
      })));
      const { adapter } = httpAdapter(stack.baseUrl);
      for (const photo of await test2Photos(3)) {
        const r = await adapter.ingestPhoto({ photoPath: photo, captureKey: `smoke:${path.basename(photo)}`, capturedAt: new Date().toISOString(), timestampBasis: 'laptop_ingest', hallId: HALL, serviceId, source: 'replay', deviceId: 'simulated:test2', sourceName: path.basename(photo) });
        assert.ok(r.ok, r.error?.message);
      }
      const port = await freePort();
      vite = spawn(process.execPath, [path.join(REPO, 'frontend/node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
        cwd: path.join(REPO, 'frontend'),
        env: { ...process.env, VITE_PROXY_TARGET: stack.baseUrl, VITE_USE_MOCK: '' },
        stdio: 'ignore',
      });
      url = `http://127.0.0.1:${port}`;
      await waitFor(url);
    }
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  });

  after(async () => {
    await browser?.close();
    vite?.kill();
    await stack?.close();
  });

  it('shows total waste, per-portion waste, most wasted foods, original + segmented images, and a recommendation', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((hallId) => {
      localStorage.setItem('scrap.hallSettings.v1', JSON.stringify({ hallId, name: 'Smoke Test Hall', events: [] }));
    }, HALL);
    await page.goto(url);

    await page.getByRole('heading', { name: 'Total waste' }).waitFor({ timeout: 30_000 });
    const today = page.getByLabel(/^Today: [\d,]+ pixels wasted$/);
    await today.waitFor();
    assert.match(await today.getAttribute('aria-label'), /^Today: [1-9][\d,]* pixels wasted$/, 'today has counted pixels');
    await page.getByLabel(/^Total waste: [\d,]+ pixels$/).waitFor();

    await page.getByText('Foods to target').waitFor();
    await page.getByRole('columnheader', { name: 'Pixels wasted per portion' }).waitFor();
    await page.getByText('Most wasted foods').waitFor();
    for (const name of ['Per portion', 'Total pixels', 'Impact points']) await page.getByRole('button', { name }).waitFor();

    await page.getByRole('heading', { name: 'Plates' }).waitFor();
    await page.getByRole('button', { name: /^Plate at / }).first().click();
    const original = page.getByAltText(/^Photo of the plate/);
    const overlay = page.getByAltText(/leftover food the AI outlined/);
    await original.waitFor();
    await overlay.waitFor();
    const loaded = async (loc) => loc.evaluate((img) => img.complete && img.naturalWidth > 0);
    await page.waitForFunction(() => [...document.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth > 0).length >= 2, null, { timeout: 30_000 });
    assert.ok(await loaded(original), 'the original photo loaded');
    assert.ok(await loaded(overlay), 'the segmented overlay loaded');

    await page.getByRole('heading', { name: 'What to try next' }).waitFor({ timeout: 30_000 });
    mkdirSync(path.join(REPO, 'images', 'smoke'), { recursive: true });
    await page.screenshot({ path: path.join(REPO, 'images', 'smoke', 'dashboard.png'), fullPage: true });
    assert.deepEqual(errors, [], 'no uncaught page errors');
  });
});
