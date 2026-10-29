/**
 * The detection scorer used by the live image test reproduces the last
 * experiment (experiments/experiment_summary.csv) from its recorded runs.
 */

import { it } from 'node:test';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO } from '../support/stack.mjs';
import { BASELINE, BASELINE_23_FOOD_EXPERIMENT, loadGroundTruth, scoreRuns } from '../support/scoring.mjs';

// The gitignored copy in images/ (restored 2026-10-25) or the old repo-root location.
const TRUTH = [path.join(REPO, 'images', 'ground_truth.csv'), path.join(REPO, 'ground_truth.csv')].find((f) => existsSync(f)) ?? path.join(REPO, 'ground_truth.csv');
const skip = existsSync(TRUTH) ? false : 'ground_truth.csv is not in the repo (deleted 2026-10-04); detection scoring runs only when it is present';

it('reproduces experiment_summary.csv (gemini: 36 correct, 0 missed, 3 wrong; claude: 35/0/2)', { skip }, () => {
  const truth = loadGroundTruth(TRUTH);
  assert.deepEqual([...truth.get('IMG_2697')].sort(), ['Baked Boneless Ham', 'Baked Sweet Potatoes', 'Roasted Cauliflower']);
  const runs = JSON.parse(readFileSync(path.join(REPO, 'experiments/experiment_overlays/results.json'), 'utf8'));
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
  assert.equal(BASELINE_23_FOOD_EXPERIMENT.recall, 1);
  assert.equal(Math.round(BASELINE_23_FOOD_EXPERIMENT.precision * 1000) / 10, 92.3);
});

it('the live baseline is the 26-food menu measurement (docs/detection-accuracy.md): 94.4% / 81.0%', () => {
  assert.equal(Math.round(BASELINE.recall * 1000) / 10, 94.4);
  assert.equal(Math.round(BASELINE.precision * 1000) / 10, 81.0);
});

it('an optional Station column is never read as a food; blank is allowed; scores break down by station', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'gt-')), 'ground_truth.csv');
  writeFileSync(file, '﻿Image_name,Food on plate,Station,Food on plate 2\nIMG_A,Sticky Rice,Halal,Vegstable Stiry Fry\nIMG_B,Farro,,\nIMG_C,Pepperonni Pizza,Pizziti,\n');
  const truth = loadGroundTruth(file);
  assert.deepEqual([...truth.get('IMG_A')].sort(), ['Sticky Rice', 'Vegetable Stir Fry Blend']);
  assert.deepEqual([...truth.get('IMG_B')], ['Farro']);
  assert.deepEqual([...truth.stations], [['IMG_A', 'Halal'], ['IMG_B', null], ['IMG_C', 'Pizziti']]);
  const run = (photo, foods) => ({ photo, counted: true, capturePixels: 1000, items: foods.map((food) => ({ food, pixels: 500 })) });
  const s = scoreRuns([run('IMG_A', ['Sticky Rice']), run('IMG_B', ['Farro', 'Lettuce']), run('IMG_C', ['Pepperoni Pizza'])], truth);
  assert.deepEqual([s.correct, s.missed, s.wrong], [3, 1, 1]);
  assert.equal(s.perPhoto[0].station, 'Halal');
  assert.deepEqual(Object.keys(s.byStation).sort(), ['(no station)', 'Halal', 'Pizziti']);
  assert.deepEqual([s.byStation.Halal.correct, s.byStation.Halal.missed, s.byStation.Halal.recall], [1, 1, 0.5]);
  assert.equal(s.byStation['(no station)'].precision, 0.5);
});

it('a ground-truth file without a Station column scores exactly as before', { skip }, () => {
  const truth = loadGroundTruth(TRUTH);
  assert.ok([...truth.stations.values()].every((x) => x === null));
  const s = scoreRuns([{ photo: 'IMG_2701', counted: true, capturePixels: 10, items: [{ food: 'Michigan Farmers 4 Bean Stew', pixels: 10 }] }], truth);
  assert.equal(s.byStation, undefined);
  assert.deepEqual([s.correct, s.missed, s.wrong], [1, 0, 0]);
});
