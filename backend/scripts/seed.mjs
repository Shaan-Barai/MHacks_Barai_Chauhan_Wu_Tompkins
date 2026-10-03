/**
 * Load data/seed/demo-seed.json (labeled DEMO DATA) into a running backend
 * through its validated API — the same path a manager's upload takes, so the
 * seed lands in whichever repository the backend uses (SpacetimeDB or JSON).
 *
 *   npm run seed            # backend at http://localhost:8787
 *   API_URL=http://host:port npm run seed
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const api = (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, '');
const seed = JSON.parse(readFileSync(fileURLToPath(new URL('../../data/seed/demo-seed.json', import.meta.url)), 'utf8'));

async function post(path, body) {
  const res = await fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed (${res.status}): ${await res.text()}`);
}

try {
  await fetch(`${api}/api/health`);
} catch {
  console.error(`No backend at ${api}. Start it first (npm start).`);
  process.exit(1);
}

for (const menu of seed.menus) await post('/api/menus', menu);
for (const ref of seed.referencePortions) await post('/api/reference-portions', ref);
console.log(
  `Seeded ${seed.menus.length} demo menus and ${seed.referencePortions.length} reference portions (${seed.label}) into ${api}.`,
);
