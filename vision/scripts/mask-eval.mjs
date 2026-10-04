/**
 * MVP_AI.md evaluation steps 2-3, on whatever local images exist.
 *
 *   cd vision && npm run build
 *   node --env-file=../.env scripts/mask-eval.mjs [imagesDir] [outDir]
 *
 * Needs the SAM worker (vision/sam/worker.py) and a Gemini key.
 *
 * Ground truth here is a PROXY: images on a plain white background, where
 * "food" = any pixel that is not near-white. It is not a hand annotation and
 * only works for white-background photos. File names give the expected label
 * (burger*.jpg -> burger, fries*.jpg -> fries).
 *
 *  A. Segmentation alone: SAM 2.1 with the tight box around the proxy mask.
 *  B. Complete path: Gemini classification + boxes -> SAM -> union mask.
 * Reports IoU, Dice, absolute/relative pixel-count error, missed food pixels,
 * non-food false positives, classification correctness, latency, and writes
 * overlays (green = proxy truth only, red = predicted only, yellow = both).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';
import { analyzeCaptureWithMasks, createGeminiGateway, createSamWorkerClient, decodeBinaryMask } from '../dist/src/index.js';

const sharp = createRequire(fileURLToPath(new URL('../../capture/package.json', import.meta.url)))('sharp');
const imagesDir = process.argv[2] ?? fileURLToPath(new URL('../../images/', import.meta.url));
const outDir = process.argv[3] ?? path.join(process.env.TMPDIR ?? '/tmp', 'scrap-mask-eval');
mkdirSync(outDir, { recursive: true });

const gateway = createGeminiGateway();
if (gateway.mode !== 'live') throw new Error('Set GEMINI_API_KEY (live Gemini needed for path B).');
const sam = createSamWorkerClient();
const MENU = {
  menuId: 'menu_eval',
  menuVersion: 1,
  items: [
    { itemId: 'burger', menuId: 'menu_eval', displayName: 'Burger' },
    { itemId: 'fries', menuId: 'menu_eval', displayName: 'Fries' },
  ],
};

function proxyTruth(rgb, w, h) {
  const truth = new Uint8Array(w * h);
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let i = 0; i < w * h; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    if (Math.min(r, g, b) < 200 || Math.max(r, g, b) - Math.min(r, g, b) > 40) {
      truth[i] = 1;
      const x = i % w, y = (i / w) | 0;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x + 1 > x1) x1 = x + 1; if (y + 1 > y1) y1 = y + 1;
    }
  }
  return { truth, box: [x0, y0, x1, y1] };
}

function metrics(pred, truth) {
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < truth.length; i++) {
    if (pred[i] && truth[i]) tp++;
    else if (pred[i]) fp++;
    else if (truth[i]) fn++;
  }
  const truthPx = tp + fn, predPx = tp + fp;
  return {
    predPx,
    truthPx,
    iou: tp / (tp + fp + fn || 1),
    dice: (2 * tp) / (predPx + truthPx || 1),
    absErr: Math.abs(predPx - truthPx),
    relErr: truthPx > 0 ? Math.abs(predPx - truthPx) / truthPx : null,
    missedPx: fn,
    falsePosPx: fp,
  };
}

async function overlay(rgbJpeg, pred, truth, w, h, file) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (pred[i] && truth[i]) rgba.set([255, 210, 0, 120], i * 4);
    else if (pred[i]) rgba.set([230, 0, 0, 150], i * 4);
    else if (truth[i]) rgba.set([0, 170, 60, 150], i * 4);
  }
  await sharp(rgbJpeg).composite([{ input: rgba, raw: { width: w, height: h, channels: 4 } }]).png().toFile(path.join(outDir, file));
}

const fmt = (m) =>
  `IoU ${(100 * m.iou).toFixed(1)}%  Dice ${(100 * m.dice).toFixed(1)}%  pred ${m.predPx.toLocaleString()} vs truth ${m.truthPx.toLocaleString()} px ` +
  `(abs err ${m.absErr.toLocaleString()}${m.relErr === null ? '' : `, rel ${(100 * m.relErr).toFixed(1)}%`})  missed ${m.missedPx.toLocaleString()}  false+ ${m.falsePosPx.toLocaleString()}`;

const files = readdirSync(imagesDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
const rows = [];
for (const file of files) {
  const expected = file.toLowerCase().startsWith('burger') ? 'burger' : file.toLowerCase().startsWith('fries') ? 'fries' : null;
  const jpeg = await sharp(readFileSync(path.join(imagesDir, file))).jpeg({ quality: 92 }).toBuffer(); // metadata dropped
  const { data: rgb, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const { truth, box } = proxyTruth(rgb, w, h);

  // A. Segmentation alone (box from the proxy truth).
  let t = performance.now();
  const a = await sam.segment(new Uint8Array(jpeg), [box]);
  const segMs = performance.now() - t;
  const aMask = decodeBinaryMask(a.results[0].maskPng, w, h);
  const A = metrics(aMask.bitmap, truth);
  await overlay(jpeg, aMask.bitmap, truth, w, h, `${path.parse(file).name}-A-truthbox.png`);

  // B. Complete path (Gemini boxes).
  t = performance.now();
  const b = await analyzeCaptureWithMasks(gateway, sam, {
    eventId: `eval_${file}`,
    attemptId: `att_${path.parse(file).name}`,
    image: { bytes: new Uint8Array(jpeg), mimeType: 'image/jpeg' },
    geometry: { widthPx: w, heightPx: h, coordinateSpace: 'topdown-normalized-v1' },
    menu: MENU,
  });
  const fullMs = performance.now() - t;
  const union = new Uint8Array(w * h);
  for (const m of b.masks) {
    const d = decodeBinaryMask(m.png, w, h);
    if (d.ok) for (let i = 0; i < union.length; i++) if (d.bitmap[i]) union[i] = 1;
  }
  const B = metrics(union, truth);
  await overlay(jpeg, union, truth, w, h, `${path.parse(file).name}-B-gemini.png`);
  const seg = b.attempt.segmentation;
  const labels = [...new Set(seg.regions.map((r) => r.itemId ?? 'unknown'))];
  const counted = b.measurements.reduce((s, m) => s + m.remainingAreaPx, 0);
  rows.push({ file, expected, labels, A, B, segMs, fullMs, status: b.attempt.status, countStatus: seg.countStatus, regions: seg.regions.length, counted });
  console.log(`\n${file} (${w}x${h}) expected=${expected}`);
  console.log(`  A  SAM + proxy-truth box  ${fmt(A)}  [${segMs.toFixed(0)} ms]`);
  console.log(
    `  B  Gemini -> SAM          ${fmt(B)}  [${fullMs.toFixed(0)} ms]  classified=${labels.join(',') || 'none'} ` +
      `(${labels.length === 1 && labels[0] === expected ? 'correct' : 'CHECK'}), ${seg.regions.length} region(s), ${b.attempt.status}/${seg.countStatus}, Pixels wasted ${counted.toLocaleString()}`,
  );
}

const mean = (k, f) => rows.reduce((s, r) => s + f(r[k]), 0) / rows.length;
console.log(`\nMean over ${rows.length} images:`);
console.log(`  A  IoU ${(100 * mean('A', (m) => m.iou)).toFixed(1)}%  Dice ${(100 * mean('A', (m) => m.dice)).toFixed(1)}%  rel count err ${(100 * mean('A', (m) => m.relErr ?? 0)).toFixed(1)}%  latency ${mean('segMs', (x) => x).toFixed(0)} ms`);
console.log(`  B  IoU ${(100 * mean('B', (m) => m.iou)).toFixed(1)}%  Dice ${(100 * mean('B', (m) => m.dice)).toFixed(1)}%  rel count err ${(100 * mean('B', (m) => m.relErr ?? 0)).toFixed(1)}%  latency ${mean('fullMs', (x) => x).toFixed(0)} ms`);
console.log(`  classification correct: ${rows.filter((r) => r.labels.length === 1 && r.labels[0] === r.expected).length}/${rows.length}`);
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(rows, (k, v) => (v instanceof Uint8Array ? undefined : v), 2));
console.log(`overlays + results.json -> ${outDir}`);
