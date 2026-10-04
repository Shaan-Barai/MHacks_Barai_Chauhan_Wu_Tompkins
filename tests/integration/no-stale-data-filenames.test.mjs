// Guard (DEBUG-PLAN D4): the factor/menu data files were renamed to *_EastQuad.*.
// Fails if the old names reappear in tracked text files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLD = /menu_waste_factors\.csv|menu_nutrition_factors\.csv|dining_hall_menu_labels\.(csv|pdf)/;
// DEBUG-PLAN.md describes the bug itself; demo.py and pipeline.mjs keep deliberate legacy-name fallbacks.
const ALLOWED = new Set(['DEBUG-PLAN.md', 'demo.py', 'upload_demo/pipeline.mjs', 'tests/integration/no-stale-data-filenames.test.mjs']);

test('no stale pre-rename data filenames in tracked files', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const hits = [];
  for (const f of files) {
    if (ALLOWED.has(f) || /\.(png|jpe?g|pdf|lock)$|package-lock\.json$/.test(f)) continue;
    let text;
    try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => { if (OLD.test(line)) hits.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(hits, [], `stale data filenames (use the _EastQuad names): ${hits.join(', ')}`);
});
