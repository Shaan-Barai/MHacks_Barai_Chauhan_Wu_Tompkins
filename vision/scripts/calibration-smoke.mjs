/**
 * Live smoke test of the library pipeline: Gemini classify + boxes -> SAM 2.1
 * masks -> Pixels wasted, plus plate-fit-v1 calibration and the overlay JPEG.
 *
 *   cd vision && npm run build
 *   node --env-file=../.env scripts/calibration-smoke.mjs <outDir> [image ...]
 *
 * Needs GEMINI_API_KEY and the SAM worker (vision/sam/worker.py) on
 * SAM_WORKER_URL. Images are normalized exactly like capture/src/normalize.ts
 * (EXIF orientation, centered square crop, 1024x1024 Lanczos3, JPEG q90).
 * The menu is the demo dinner (data/seed/demo-seed.json, 2026-10-03), whose
 * descriptions are Gemini visible-component text. Two Gemini calls per image
 * (classification + plate box); MAX_GEMINI_CALLS (default 2 per image + 2)
 * aborts a runaway run.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { analyzeCaptureWithMasks, createGeminiGateway, createSamWorkerClient } from '../dist/src/index.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const [outDir, ...args] = process.argv.slice(2);
if (!outDir) throw new Error('usage: calibration-smoke.mjs <outDir> [image ...]');
const images = args.length ? args : ['IMG_2695', 'IMG_2697', 'IMG_2701', 'IMG_2706'].map((n) => path.join(repo, 'test2', `${n}.jpeg`));
mkdirSync(outDir, { recursive: true });

const seed = JSON.parse(readFileSync(path.join(repo, 'data/seed/demo-seed.json'), 'utf8'));
const dinner = seed.menus.find((m) => m.service.serviceId === 'svc_hall-main_2026-10-03_dinner');
if (!dinner) throw new Error('demo dinner menu not found in data/seed/demo-seed.json');
const menu = { menuId: dinner.service.menuId, menuVersion: dinner.service.menuVersion, items: dinner.items };

const gateway = createGeminiGateway();
if (gateway.mode !== 'live') throw new Error('Set GEMINI_API_KEY: this script makes live calls.');
const sam = createSamWorkerClient();
const maxCalls = Number(process.env.MAX_GEMINI_CALLS ?? images.length * 2 + 2);

async function normalize(file) {
  const img = sharp(readFileSync(file)).rotate();
  const { width, height } = await sharp(await img.clone().toBuffer()).metadata();
  const side = Math.min(width, height);
  return new Uint8Array(
    await img
      .extract({ left: Math.floor((width - side) / 2), top: Math.floor((height - side) / 2), width: side, height: side })
      .resize(1024, 1024, { kernel: sharp.kernel.lanczos3 })
      .jpeg({ quality: 90 })
      .toBuffer(),
  );
}

const names = new Map(menu.items.map((i) => [i.itemId, i.displayName]));
const results = [];
for (const file of images) {
  const name = path.parse(file).name;
  const bytes = await normalize(file);
  const t0 = performance.now();
  const r = await analyzeCaptureWithMasks(gateway, sam, {
    eventId: `smoke_${name}`,
    attemptId: `smoke_${name}_1`,
    image: { bytes, mimeType: 'image/jpeg' },
    geometry: { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' },
    menu,
  });
  const seconds = (performance.now() - t0) / 1000;
  if (r.overlay) writeFileSync(path.join(outDir, `${name}_overlay.jpg`), r.overlay.jpeg);
  const foods = r.measurements.map((m) => ({ food: m.itemId ? names.get(m.itemId) ?? m.itemId : 'unclassified', pixels: m.remainingAreaPx }));
  const row = {
    image: name,
    status: r.attempt.status,
    countStatus: r.attempt.segmentation?.countStatus,
    capturePixelsWasted: r.attempt.segmentation?.capturePixelsWasted,
    error: r.attempt.error?.code,
    calibration: r.calibration,
    diagnostics: r.diagnostics,
    foods,
    overlay: r.overlay ? { widthPx: r.overlay.widthPx, heightPx: r.overlay.heightPx, bytes: r.overlay.jpeg.length } : null,
    seconds: Number(seconds.toFixed(1)),
  };
  results.push(row);
  const c = r.calibration;
  console.log(`\n${name}: ${row.status}/${row.countStatus} ${row.error ?? ''} ${row.seconds}s  Gemini calls so far ${gateway.callCount}`);
  console.log(`  calibration ${c.method} ${c.dishType ?? ''} d=${c.plateDiameterPx}px cm2/px=${c.cm2PerPx.toFixed(6)} flags=[${c.flags.join(',')}]` +
    (r.diagnostics.calibrationError ? ` (${r.diagnostics.calibrationError.code})` : '') +
    (r.diagnostics.pixelsOutsideDish !== undefined ? ` foodPxOutsideDish=${r.diagnostics.pixelsOutsideDish}` : ''));
  for (const f of foods) console.log(`  ${f.food.padEnd(34)} ${String(f.pixels).padStart(8)} px`);
  if (!r.overlay) console.log(`  overlay: none (${r.diagnostics.overlayError})`);
  if (gateway.callCount > maxCalls) throw new Error(`Gemini call guard: ${gateway.callCount} > ${maxCalls}`);
}
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\nGemini calls: ${gateway.callCount}. Overlays + results.json -> ${outDir}`);
