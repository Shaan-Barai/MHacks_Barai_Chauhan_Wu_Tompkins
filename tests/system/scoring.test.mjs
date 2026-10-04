/**
 * The detection scorer used by the live image test reproduces the last
 * experiment (experiment_summary.csv) from its recorded runs.
 */

import { it } from 'node:test';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO } from '../support/stack.mjs';
import { BASELINE, loadGroundTruth, scoreRuns } from '../support/scoring.mjs';

const TRUTH = path.join(REPO, 'ground_truth.csv');
const skip = existsSync(TRUTH) ? false : 'ground_truth.csv is not in the repo (deleted 2026-10-04); detection scoring runs only when it is present';

it('reproduces experiment_summary.csv (gemini: 36 correct, 0 missed, 3 wrong; claude: 35/0/2)', { skip }, () => {
  const truth = loadGroundTruth(TRUTH);
  assert.deepEqual([...truth.get('IMG_2697')].sort(), ['Baked Boneless Ham', 'Baked Sweet Potatoes', 'Roasted Cauliflower']);
  const runs = JSON.parse(readFileSync(path.join(REPO, 'experiment_overlays/results.json'), 'utf8'));
  for (const [source, expected] of [['gemini', [36, 0, 3, 24]], ['claude', [35, 0, 2, 23]]]) {
    const score = scoreRuns(
      runs
        .filter((r) => r.menuSource === source)
        .map((r) => ({
          photo: r.file.replace(/\.[^.]+$/, ''),
          counted: r.countStatus === 'complete' || r.countStatus === 'empty',
          capturePixels: r.capturePixels,
          items: r.items.map((i) => ({ food: i.food.startsWith('unknown') ? null : i.food, pixels: i.pixels })),
        })),
      truth,
    );
    assert.deepEqual([score.correct, score.missed, score.wrong, score.scored], expected, source);
  }
  assert.equal(BASELINE.recall, 1);
  assert.equal(Math.round(BASELINE.precision * 1000) / 10, 92.3);
});
