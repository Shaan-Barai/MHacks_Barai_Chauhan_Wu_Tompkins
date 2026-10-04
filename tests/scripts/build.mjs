/**
 * Build the packages the system/live/camera tests import (dist/ output).
 * Installs a package's dependencies first when its node_modules is missing.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const pkg of ['data', 'vision', 'analytics', 'capture', 'backend']) {
  const dir = fileURLToPath(new URL(`../../${pkg}/`, import.meta.url));
  const run = (cmd) => execSync(cmd, { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
  if (!existsSync(`${dir}node_modules`)) run('npm ci --no-audit --no-fund');
  // backend's build also builds its dependencies; tsc alone is enough here.
  run(pkg === 'backend' ? 'npx tsc -p tsconfig.json' : 'npm run build');
}
console.log('built: data, vision, analytics, capture, backend');
