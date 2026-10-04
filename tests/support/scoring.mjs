/**
 * Detection scoring against ground_truth.csv: a JavaScript port of
 * vision/scripts/score-experiment.py with the same agreed rules (2026-10-03):
 * - ground-truth names are mapped to menu names (misspellings fixed;
 *   "Baked Potato" = Baked Sweet Potatoes)
 * - IMG_2696 / IMG_2704: any pizza counts; IMG_2705 (pasta, not on the menu)
 *   is not scored; IMG_2706: the pie is scored and extra detections are not wrong
 * - detections under 1% of the plate's food pixels are ignored; unknown food
 *   is never a detection
 * - correct = detected and on the plate, missed = on the plate and not
 *   detected, wrong = detected and not on the plate
 * - runs whose count failed are excluded and reported
 */

import { readFileSync } from 'node:fs';

const NAME_MAP = {
  'vegstable stiry fry': 'Vegetable Stir Fry Blend',
  'vegstable stir fry': 'Vegetable Stir Fry Blend',
  'roasted caulliflower': 'Roasted Cauliflower',
  'pepperonni pizza': 'Pepperoni Pizza',
  'chochalate cream pie': 'Chocolate Coconut Cream Pie',
  'baked potato': 'Baked Sweet Potatoes',
};
export const PIZZA = new Set(['Cheese Pizza', 'Pepperoni Pizza', 'Chicken Broccoli Alfredo Pizza']);
const ANY_PIZZA = new Set(['IMG_2696', 'IMG_2704']);
const NOT_SCORED = new Set(['IMG_2705']);
const NO_WRONG = new Set(['IMG_2706']);

/** The last experiment (experiment_summary.csv, Gemini descriptions): 36 correct, 0 missed, 3 wrong. */
export const BASELINE = { recall: 1, precision: 36 / 39 };

function canon(raw) {
  const name = raw.split('(')[0].trim();
  return NAME_MAP[name.toLowerCase()] ?? name;
}

/** Minimal CSV row splitter (quoted fields allowed). */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function loadGroundTruth(file) {
  const truth = new Map();
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = splitCsv(line);
    if (row[0] === 'Image_name') continue;
    const dishes = new Set();
    for (const cell of row.slice(1)) {
      for (let part of cell.split('&')) {
        part = part.trim();
        if (part && !/^un(k)?own/i.test(part) && !/^unkown/i.test(part)) dishes.add(canon(part));
      }
    }
    truth.set(row[0].trim(), dishes);
  }
  return truth;
}

/**
 * runs: [{ photo: 'IMG_2695', counted: boolean, capturePixels, items: [{ food, pixels }] }]
 * food names are menu display names; unknown food has food === null.
 */
export function scoreRuns(runs, truth) {
  const totals = { correct: 0, missed: 0, wrong: 0, scored: 0, failed: [] };
  const perPhoto = [];
  for (const r of runs) {
    if (!r.counted) {
      totals.failed.push(r.photo);
      perPhoto.push({ photo: r.photo, scored: false, reason: 'count failed' });
      continue;
    }
    const dets = new Set(
      r.items.filter((i) => i.food !== null && r.capturePixels > 0 && i.pixels >= 0.01 * r.capturePixels).map((i) => i.food),
    );
    if (NOT_SCORED.has(r.photo)) {
      perPhoto.push({ photo: r.photo, scored: false, reason: 'not scored (not on the menu)', detected: [...dets] });
      continue;
    }
    totals.scored++;
    const t = truth.get(r.photo) ?? new Set();
    let correct;
    let missed;
    let wrong;
    if (ANY_PIZZA.has(r.photo)) {
      const hit = [...dets].some((d) => PIZZA.has(d));
      correct = hit ? 1 : 0;
      missed = hit ? 0 : 1;
      wrong = [...dets].filter((d) => !PIZZA.has(d)).length;
    } else {
      correct = [...dets].filter((d) => t.has(d)).length;
      missed = [...t].filter((d) => !dets.has(d)).length;
      wrong = NO_WRONG.has(r.photo) ? 0 : [...dets].filter((d) => !t.has(d)).length;
    }
    totals.correct += correct;
    totals.missed += missed;
    totals.wrong += wrong;
    perPhoto.push({ photo: r.photo, scored: true, correct, missed, wrong, detected: [...dets].sort(), truth: [...t].sort() });
  }
  const recall = totals.correct + totals.missed > 0 ? totals.correct / (totals.correct + totals.missed) : null;
  const precision = totals.correct + totals.wrong > 0 ? totals.correct / (totals.correct + totals.wrong) : null;
  return { ...totals, recall, precision, perPhoto };
}
