/**
 * Load data/seed/demo-seed.json (labeled DEMO DATA) into a running backend
 * through its validated API — the same path a manager's upload takes, so the
 * seed lands in whichever repository the backend uses (SpacetimeDB or JSON).
 *
 * Loads, idempotently (re-running replaces rather than duplicates):
 *   - every menu (incl. the 23-food demo dinner menu, BIG-PLAN D6),
 *   - reference portions (optional auxiliary baselines),
 *   - demo portions served, saved as replacement snapshots with source `demo`.
 *
 *   npm run seed            # backend at http://localhost:8787
 *   API_URL=http://host:port npm run seed
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const api = (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, '');
const seedPath = process.env.SEED_FILE ?? fileURLToPath(new URL('../../data/seed/demo-seed.json', import.meta.url));
const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

async function send(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

try {
  await fetch(`${api}/api/health`);
} catch {
  console.error(`No backend at ${api}. Start it first (npm start).`);
  process.exit(1);
}

const menus = seed.menus ?? [];
const refs = seed.referencePortions ?? [];
const portions = seed.portionsServed ?? [];

for (const menu of menus) await send('POST', '/api/menus', menu);
for (const ref of refs) await send('POST', '/api/reference-portions', ref);

// One replacement snapshot per service + menu version (never additive).
const snapshots = new Map();
for (const p of portions) {
  const key = `${p.serviceId}\u0000${p.menuVersion}`;
  const snap = snapshots.get(key) ?? { serviceId: p.serviceId, hallId: p.hallId, menuVersion: p.menuVersion, entries: [] };
  snap.entries.push({ itemId: p.itemId, count: p.count });
  snapshots.set(key, snap);
}
for (const snap of snapshots.values()) {
  const query = `serviceId=${encodeURIComponent(snap.serviceId)}&hallId=${encodeURIComponent(snap.hallId)}`;
  await send('PUT', `/api/portions-served?${query}`, {
    serviceId: snap.serviceId,
    menuVersion: snap.menuVersion,
    entries: snap.entries,
    source: 'demo',
  });
}

console.log(
  `Seeded ${menus.length} demo menus, ${refs.length} reference portions, and ${portions.length} demo portions-served counts ` +
    `(${snapshots.size} services) into ${api}. ${seed.label ?? ''}`,
);
