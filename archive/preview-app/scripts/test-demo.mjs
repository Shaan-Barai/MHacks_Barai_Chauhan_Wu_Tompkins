import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist/demo.test.cjs');
await build({ absWorkingDir: root, entryPoints: ['tests/integration/demo.test.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' });
const result = spawnSync(process.execPath, ['--test', out], { cwd: root, stdio: 'inherit' });
process.exit(result.status || 0);
