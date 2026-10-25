/**
 * The built dashboard (frontend/dist) must never contain the Supabase service
 * role (secret) key — only the project URL and the publishable/anon key, which
 * RLS limits to reading dashboard tables. Also checks the Vite config refuses
 * to build with a secret key in the browser slot.
 * Skipped (with a message) when the dashboard has not been built yet.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { REPO } from '../support/stack.mjs';

const DIST = path.join(REPO, 'frontend', 'dist');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('dashboard bundle holds no Supabase secret', () => {
  it('no sb_secret_ key, no service role key value, no SUPABASE_SERVICE_ROLE_KEY name in frontend/dist', { skip: existsSync(DIST) ? false : 'frontend/dist not built (npm run build in frontend/)' }, () => {
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    const offenders = [];
    for (const file of files(DIST)) {
      const text = readFileSync(file, 'latin1');
      if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(text)) offenders.push(`${path.relative(REPO, file)}: sb_secret_ key`);
      if (secret.length >= 16 && text.includes(secret)) offenders.push(`${path.relative(REPO, file)}: the service role key value`);
      if (text.includes('SUPABASE_SERVICE_ROLE_KEY')) offenders.push(`${path.relative(REPO, file)}: the service role key name`);
    }
    assert.deepEqual(offenders, []);
  });

  it('the Vite build refuses a secret key in the browser slot', () => {
    const res = spawnSync('npx', ['vite', 'build', '--outDir', path.join(REPO, 'frontend', 'node_modules', '.tmp-refuse-build'), '--emptyOutDir'], {
      cwd: path.join(REPO, 'frontend'),
      env: { ...process.env, VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_ANON_KEY: 'sb_secret_THIS_MUST_NOT_SHIP_0000' },
      encoding: 'utf8',
    });
    assert.notEqual(res.status, 0, 'the build must fail');
    assert.match(`${res.stdout}${res.stderr}`, /Refusing to build: the Supabase key meant for the browser is a secret/);
  });
});
