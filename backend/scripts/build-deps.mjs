/**
 * Build the sibling packages the backend imports through `file:` dependencies
 * (data, vision, analytics). Installs a package's own dependencies first when
 * its node_modules is missing, so a fresh clone needs only `npm ci` here.
 */

import { execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// capture: built so the dashboard's Take photo button can run capture/scripts/take-photo.mjs.
for (const pkg of ['data', 'vision', 'analytics', 'capture']) {
  const dir = fileURLToPath(new URL(`../../${pkg}/`, import.meta.url));
  const run = (cmd) => execSync(cmd, { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
  // (Re)install when node_modules is missing or older than the lockfile
  // (e.g. vision gained `sharp` for the overlay after the last install).
  const installed = `${dir}node_modules/.package-lock.json`;
  const lock = `${dir}package-lock.json`;
  if (!existsSync(installed) || (existsSync(lock) && statSync(lock).mtimeMs > statSync(installed).mtimeMs)) {
    run('npm ci --no-audit --no-fund');
  }
  run('npm run build');
}
