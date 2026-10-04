/**
 * `npm run seed` loads data/seed/demo-seed.json through the API: menus,
 * reference portions, and demo portions served (source `demo`). Running it
 * twice must not duplicate anything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startTestServer } from './helpers.js';

const run = promisify(execFile);
// dist/backend/test -> backend/scripts
const script = fileURLToPath(new URL('../../../scripts/seed.mjs', import.meta.url));
const seedFile = fileURLToPath(new URL('../../../../data/seed/demo-seed.json', import.meta.url));

test('npm run seed is idempotent and labels portions served as demo', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
  const env = { ...process.env, API_URL: s.baseUrl, SEED_FILE: seedFile };

  await run(process.execPath, [script], { env });
  await run(process.execPath, [script], { env });

  const services = await s.repo.listServices();
  assert.equal(services.length, new Set(seed.menus.map((m: any) => m.service.serviceId)).size);
  for (const menu of seed.menus) {
    const stored = await s.repo.getMenuByService(menu.service.serviceId);
    assert.equal(stored?.items.length, menu.items.length);
  }

  const expected = (seed.portionsServed ?? []) as Array<{ serviceId: string; menuVersion: number; itemId: string; count: number }>;
  let stored = 0;
  for (const service of services) {
    const rows = await s.repo.listPortionsServed(service.serviceId, service.menuVersion);
    stored += rows.length;
    for (const row of rows) {
      assert.equal(row.source, 'demo');
      const want = expected.find((p) => p.serviceId === row.serviceId && p.itemId === row.itemId);
      assert.equal(row.count, want?.count);
    }
  }
  assert.equal(stored, expected.length, 'one row per seeded count, even after two runs');
});
