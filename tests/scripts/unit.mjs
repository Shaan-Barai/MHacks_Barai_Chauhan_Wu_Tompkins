/**
 * Unit level: every package's own tests, offline (no board, no network,
 * no Gemini). One summary line per package; exit 1 if any fails.
 *
 *   cd tests && npm run test:unit
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const env = { ...process.env, GEMINI_API_KEY: '' };
const suites = [
  ['data', 'npm', ['test']],
  ['vision', 'npm', ['test']],
  ['analytics', 'npm', ['test']],
  ['capture', 'npm', ['test']],
  ['backend', 'npm', ['test']],
  ['frontend', 'npm', ['test']],
  ['db/spacetimedb', 'npm', ['run', 'typecheck']],
  ['capture/uno-q (python)', 'python3', ['-B', '-m', 'unittest', 'discover', '-s', 'capture/uno-q']],
];

let failed = 0;
for (const [name, cmd, args] of suites) {
  const cwd = name.includes('python') ? repo : `${repo}${name}`;
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout}\n${r.stderr}`;
  const pass = out.match(/ℹ pass (\d+)/)?.[1] ?? out.match(/Tests\s+(\d+) passed/)?.[1] ?? out.match(/Ran (\d+) tests?/)?.[1];
  const fail = out.match(/ℹ fail (\d+)/)?.[1] ?? out.match(/(\d+) failed/)?.[1] ?? '0';
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(24)} ${pass ? `${pass} passed` : ok ? 'ok' : ''}${ok ? '' : `, ${fail} failed`}`);
  if (!ok) console.log(out.split('\n').filter((l) => /✖|×|FAIL|Error|error TS|AssertionError/.test(l)).slice(0, 15).join('\n'));
}
process.exit(failed === 0 ? 0 : 1);
