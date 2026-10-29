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
 * - optional `Station` column (Run 5): any header cell named "station" is read as
 *   the photo's station, never as a food. Blank is allowed; files without the
 *   column work as before. Scores are then also broken down by station.
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

/**
 * Detection baseline for the CURRENT 26-food test dinner (data/src/seed factorDinnerItems), measured
 * 2026-10-28 with tests/live/detection-runs.mjs: 3 identical runs (seed 42, temperature 0, 2 passes),
 * each 17 correct, 1 missed, 4 wrong over 12 photos. See docs/detection-accuracy.md.
 */
export const BASELINE = { recall: 17 / 18, precision: 17 / 21, menu: '26-food dinner (2026-10-04)' };
/**
 * The earlier experiment (experiments/experiment_summary.csv, 2026-10-03): 36 correct, 0 missed,
 * 3 wrong over 2 runs × 12 photos, on the OLD 23-food menu (before Halal Rice, Tomatoes and Lettuce
 * were added) and an older pipeline (one localization pass, no target-dish counting). Not comparable
 * with runs on the 26-food menu; kept for reference.
 */
export const BASELINE_23_FOOD_EXPERIMENT = { recall: 1, precision: 36 / 39, menu: '23-food dinner (2026-10-03 experiment)' };

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

/**
 * photo -> Set of canonical food names. The returned Map also carries `stations`:
 * photo -> station name, or null when the column is missing or blank.
 */
export function loadGroundTruth(file) {
  const truth = new Map();
  truth.stations = new Map();
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  let stationCol = -1;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = splitCsv(line);
    if (row[0] === 'Image_name') {
      stationCol = row.findIndex((h) => h.trim().toLowerCase() === 'station');
      continue;
    }
    const station = stationCol > 0 ? (row[stationCol] ?? '').trim() : '';
    truth.stations.set(row[0].trim(), station || null);
    const dishes = new Set();
    for (const cell of row.slice(1).filter((_, i) => i + 1 !== stationCol)) {
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
    const station = truth.stations?.get(r.photo) ?? null;
    perPhoto.push({ photo: r.photo, scored: true, ...(station ? { station } : {}), correct, missed, wrong, detected: [...dets].sort(), truth: [...t].sort() });
  }
  const rates = (x) => ({
    recall: x.correct + x.missed > 0 ? x.correct / (x.correct + x.missed) : null,
    precision: x.correct + x.wrong > 0 ? x.correct / (x.correct + x.wrong) : null,
  });
  // By station, only when the file names at least one station; photos without one go under "(no station)".
  let byStation;
  if ([...(truth.stations?.values() ?? [])].some(Boolean)) {
    byStation = {};
    for (const p of perPhoto.filter((x) => x.scored)) {
      const b = (byStation[p.station ?? '(no station)'] ??= { photos: 0, correct: 0, missed: 0, wrong: 0 });
      b.photos++;
      b.correct += p.correct;
      b.missed += p.missed;
      b.wrong += p.wrong;
    }
    for (const b of Object.values(byStation)) Object.assign(b, rates(b));
  }
  return { ...totals, ...rates(totals), perPhoto, ...(byStation ? { byStation } : {}) };
}
