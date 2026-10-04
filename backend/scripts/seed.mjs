/**
 * Load data/seed/demo-seed.json (labeled DEMO DATA) into a running backend
 * through its validated API — the same path a manager's upload takes, so the
 * seed lands in whichever repository the backend uses (SpacetimeDB `scrap`
 * or the JSON file).
 *
 * Loads, idempotently (re-running changes nothing):
 *   - every menu. A service that already has a menu with DIFFERENT items
 *     (e.g. the old 5-item dinners in `scrap`, now the 26-food dinner) gets a
 *     new menu revision: same serviceId/menuId, menuVersion + 1 (data/
 *     planMenuRevision). Old items are archived by the module
 *     (menu_item_revision) and old analyses keep the version they froze.
 *     A menu whose items already match is left alone.
 *   - reference portions (optional auxiliary baselines; upsert by baselineId),
 *   - demo portions served, saved as replacement snapshots with source `demo`
 *     for the service's CURRENT menu version.
 *
 * Optional live-camera dinner (BIG-PLAN v2): `--live-dinner[=YYYY-MM-DD]`
 * also seeds the 26-food dinner (plus demo portions) for that hall-local date
 * (default: today in America/Detroit), so camera captures tonight resolve to
 * svc_hall-main_<date>_dinner.
 *
 *   npm run seed                              # backend at http://localhost:8787
 *   npm run seed -- --live-dinner             # + today's dinner
 *   npm run seed -- --live-dinner=2026-10-04
 *   API_URL=http://host:port npm run seed
 *
 * Needs the data package built (npm run build:deps, or npm start/test).
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Mutations need the ingest token when the backend enforces auth (IT_4 I11);
// read it from the environment or the repo-root .env.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (!process.env.SCRAP_INGEST_TOKEN && existsSync(envFile)) process.loadEnvFile(envFile);
const auth = process.env.SCRAP_INGEST_TOKEN ? { Authorization: `Bearer ${process.env.SCRAP_INGEST_TOKEN}` } : {};

const api = (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, '');
const seedPath = process.env.SEED_FILE ?? fileURLToPath(new URL('../../data/seed/demo-seed.json', import.meta.url));
const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

const liveArg = process.argv.slice(2).find((a) => a === '--live-dinner' || a.startsWith('--live-dinner='));

let data;
let demo;
try {
  data = await import(new URL('../../data/dist/data/src/index.js', import.meta.url).href);
  demo = await import(new URL('../../data/dist/data/src/seed/generate.js', import.meta.url).href);
} catch {
  console.error('The data package is not built. Run `npm run build:deps` in backend/ first.');
  process.exit(1);
}

async function send(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function storedMenu(serviceId) {
  const res = await fetch(`${api}/api/menus/by-service/${encodeURIComponent(serviceId)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GET menu ${serviceId} failed (${res.status}): ${await res.text()}`);
  return (await res.json()).menu;
}

/** Create, keep, or revise (version + 1) one menu; returns the stored bundle and the action. */
async function saveMenu(bundle) {
  const plan = data.planMenuRevision(await storedMenu(bundle.service.serviceId), bundle);
  if (plan.action !== 'unchanged') await send('POST', '/api/menus', plan.bundle);
  return plan;
}

try {
  await fetch(`${api}/api/health`);
} catch {
  console.error(`No backend at ${api}. Start it first (npm start).`);
  process.exit(1);
}

const menus = [...(seed.menus ?? [])];
const refs = seed.referencePortions ?? [];
const portions = seed.portionsServed ?? [];

// Entries per service from the seed file (counts do not depend on the version).
const entriesByService = new Map();
for (const p of portions) {
  const list = entriesByService.get(p.serviceId) ?? [];
  list.push({ itemId: p.itemId, count: p.count });
  entriesByService.set(p.serviceId, list);
}

if (liveArg) {
  const tz = seed.hallTimezone ?? 'America/Detroit';
  const date = liveArg.includes('=') ? data.validateServiceDate(liveArg.split('=')[1]) : data.localServiceDate(new Date().toISOString(), tz);
  const items = demo.factorDinnerItems().map(({ name, category, description }) => ({ name, category, ...(description ? { description } : {}) }));
  const [bundle] = data.parseMenuUpload({ hallId: seed.hallId ?? 'hall-main', hallTimezone: tz, days: [{ date, dinner: items }] });
  menus.push(bundle);
  entriesByService.set(bundle.service.serviceId, demo.buildDemoPortions(bundle).map((p) => ({ itemId: p.itemId, count: p.count })));
}

const actions = { create: 0, unchanged: 0, revise: 0 };
const stored = new Map();
for (const menu of menus) {
  const plan = await saveMenu(menu);
  actions[plan.action] += 1;
  stored.set(plan.bundle.service.serviceId, plan.bundle);
  if (plan.action === 'revise') {
    console.log(`  revised ${plan.bundle.service.serviceId}: v${plan.previousVersion} -> v${plan.bundle.service.menuVersion}`);
  }
}
for (const ref of refs) await send('POST', '/api/reference-portions', ref);

// One replacement snapshot per service, for its current menu version (never additive).
let portionRows = 0;
for (const [serviceId, entries] of entriesByService) {
  const menu = stored.get(serviceId);
  if (!menu) throw new Error(`Seed portions for ${serviceId} have no seeded menu.`);
  const query = `serviceId=${encodeURIComponent(serviceId)}&hallId=${encodeURIComponent(menu.service.hallId)}`;
  await send('PUT', `/api/portions-served?${query}`, {
    serviceId,
    menuVersion: menu.service.menuVersion,
    entries,
    source: 'demo',
  });
  portionRows += entries.length;
}

// IT_4: default measurement settings per seeded hall (depth off, no calibration).
// GET returns unsaved defaults with updatedAt = 1970-01-01; only then is a row created,
// so a hall's chosen calibration/depth setting is never overwritten.
const halls = [...new Set(menus.map((m) => m.service.hallId))];
let settingsCreated = 0;
for (const hallId of halls) {
  const res = await fetch(`${api}/api/settings/measurement?hallId=${encodeURIComponent(hallId)}`);
  if (!res.ok) throw new Error(`GET measurement settings for ${hallId} failed (${res.status})`);
  const current = await res.json();
  if (current.updatedAt === new Date(0).toISOString()) {
    await send('PUT', '/api/settings/measurement', { hallId, depthEnabled: false, activeCalibrationId: null, plateThicknessCm: 1.5 });
    settingsCreated += 1;
  }
}

console.log(
  `Measurement settings: ${settingsCreated} created, ${halls.length - settingsCreated} kept (${halls.join(', ')}).`,
);
console.log(
  `Seeded ${menus.length} demo menus (${actions.create} created, ${actions.revise} revised, ${actions.unchanged} unchanged), ` +
    `${refs.length} reference portions, and ${portionRows} demo portions-served counts (${entriesByService.size} services) into ${api}. ` +
    `${seed.label ?? ''}`,
);
