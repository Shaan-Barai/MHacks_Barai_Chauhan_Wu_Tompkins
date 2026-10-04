/**
 * Live smoke test of IT_4 calibration + Depth Anything V2 volume (vision/).
 *
 *   cd vision && npm run build
 *   node --env-file=../.env scripts/volume-smoke.mjs <outDir> [image ...]
 *
 * Needs GEMINI_API_KEY, the SAM worker (:8790) and the depth worker (:8791).
 * Each image is normalized like capture (EXIF orientation, centered square
 * crop, 1024² Lanczos3, JPEG q90), then:
 *   1. runCalibration on the SAME image with the reference REF_LABEL of
 *      REF_AREA_CM2 (default: "the round dinner plate in the centre",
 *      assumed 26.7 cm diameter = 559.9 cm²) and intrinsics FX_PX
 *      (default: the C920s nominal value for 1024²; pass FX_PX for phone photos);
 *   2. analyzeCaptureWithMasks with the physical stage (depth on), using that
 *      calibration.
 * Prints k, both camera heights, depth scale, table plane and per-food
 * pixels / area / volume / heights; writes the calibration overlay, the
 * capture overlay (suffix: area and volume) and a depth preview PNG.
 *
 * WITHOUT a measured reference object this is a PLAUSIBILITY check only
 * (camera height, food heights); it is not a volume-accuracy validation.
 * Gemini calls per image: 1 (calibration) + GEMINI_PASSES (default 2).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  analyzeCaptureWithMasks,
  createDepthWorkerClient,
  createGeminiGateway,
  createSamWorkerClient,
  decodeDepthPng16,
  runCalibration,
} from '../dist/src/index.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const [outDir, ...args] = process.argv.slice(2);
if (!outDir) throw new Error('usage: volume-smoke.mjs <outDir> [image ...]');
const images = args.length ? args : ['IMG_2697', 'IMG_2701'].map((n) => path.join(repo, 'test2', `${n}.jpeg`));
mkdirSync(outDir, { recursive: true });

const refLabel = process.env.REF_LABEL ?? 'the round dinner plate in the centre of the photo';
const refArea = Number(process.env.REF_AREA_CM2 ?? Math.PI * 13.35 ** 2);
const fx = process.env.FX_PX ? Number(process.env.FX_PX) : undefined;
const overrides = fx ? { fxPx: fx, fyPx: fx, source: 'configured', cameraModel: 'other' } : {};

const seed = JSON.parse(readFileSync(path.join(repo, 'data/seed/demo-seed.json'), 'utf8'));
const dinner = seed.menus.find((m) => m.service.serviceId === 'svc_hall-main_2026-10-03_dinner');
const menu = { menuId: dinner.service.menuId, menuVersion: dinner.service.menuVersion, items: dinner.items };
const names = new Map(menu.items.map((i) => [i.itemId, i.displayName]));

const gateway = createGeminiGateway();
if (gateway.mode !== 'live') throw new Error('Set GEMINI_API_KEY: this script makes live calls.');
const sam = createSamWorkerClient();
const depth = createDepthWorkerClient();
const maxCalls = Number(process.env.MAX_GEMINI_CALLS ?? images.length * 3 + 1);

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

async function depthPreview(png16) {
  const d = decodeDepthPng16(png16);
  const valid = [...d.depthM].filter(Number.isFinite).sort((a, b) => a - b);
  const lo = valid[Math.floor(valid.length * 0.01)];
  const hi = valid[Math.floor(valid.length * 0.99)];
  const out = Buffer.alloc(d.widthPx * d.heightPx);
  for (let i = 0; i < out.length; i++) out[i] = Number.isFinite(d.depthM[i]) ? Math.round(255 * (1 - Math.min(1, Math.max(0, (d.depthM[i] - lo) / (hi - lo))))) : 0;
  return sharp(out, { raw: { width: d.widthPx, height: d.heightPx, channels: 1 } }).png().toBuffer();
}

const results = [];
for (const file of images) {
  if (gateway.callCount >= maxCalls) throw new Error(`MAX_GEMINI_CALLS ${maxCalls} reached`);
  const name = path.parse(file).name;
  const bytes = await normalize(file);
  const t0 = performance.now();
  const cal = await runCalibration({ imageBytes: bytes, knownAreaCm2: refArea, referenceLabel: refLabel, gateway, sam, depth, intrinsicsOverrides: overrides });
  const tCal = performance.now() - t0;
  if (!cal.ok) {
    console.log(`${name}: calibration FAILED ${cal.error.code} ${cal.error.message} flags=${cal.flags.join(',')}`);
    results.push({ name, calibration: { ok: false, error: cal.error, flags: cal.flags } });
    continue;
  }
  const c = cal.calibration;
  if (cal.overlay) writeFileSync(path.join(outDir, `${name}_calibration.jpg`), cal.overlay.jpeg);
  if (cal.depthPng) writeFileSync(path.join(outDir, `${name}_depth.png`), await depthPreview(cal.depthPng));
  console.log(
    `${name}: reference ${c.referencePixels} px, k=${c.cm2PerPx.toPrecision(4)} cm²/px, f=${c.intrinsics.fxPx} px (${c.intrinsics.source}), ` +
      `height geometric ${c.cameraHeightCmGeometric.toFixed(1)} cm, DAv2 ${c.depth?.cameraHeightCmDepth.toFixed(1) ?? '-'} cm, ` +
      `scale ${c.depth?.scale.toFixed(3) ?? '-'}, table plane ${c.depth ? JSON.stringify(c.depth.tablePlane) : '-'}, flags [${c.flags.join(', ')}] (${Math.round(tCal)} ms)`,
  );

  const t1 = performance.now();
  const r = await analyzeCaptureWithMasks(gateway, sam, {
    eventId: `cap_${name}`,
    attemptId: `att_${name}`,
    image: { bytes, mimeType: 'image/jpeg' },
    geometry: { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' },
    menu,
    physical: {
      calibration: { calibrationId: `live_${name}`, widthPx: c.widthPx, heightPx: c.heightPx, cm2PerPx: c.cm2PerPx, intrinsics: c.intrinsics, depth: c.depth },
      depthEnabled: true,
      depthClient: depth,
    },
    labelSuffix: (b) =>
      b.physical
        ? `${b.physical.areaCm2.toFixed(0)} cm²${b.physical.volumeCm3 !== null ? ` · ${b.physical.volumeCm3.toFixed(0)} cm³` : ''} (est.)`
        : null,
  });
  const tCap = performance.now() - t1;
  if (r.overlay) writeFileSync(path.join(outDir, `${name}_overlay.jpg`), r.overlay.jpeg);
  console.log(
    `  capture: ${r.attempt.status}, ${r.attempt.segmentation?.capturePixelsWasted ?? '-'} px, physical ${r.physical.status} ${r.physical.method ?? r.physical.reason ?? ''}, ` +
      `plate ${r.physical.plate?.reference ?? '-'} ${r.physical.plate ? JSON.stringify(r.physical.plate.plane) : ''} ring ${r.physical.plate?.ringPx ?? '-'} px (${Math.round(tCap)} ms)`,
  );
  for (const m of r.measurements) {
    const p = m.physical;
    console.log(
      `    ${(m.itemId ? names.get(m.itemId) : 'Unclassified') ?? m.itemId}: ${m.remainingAreaPx} px` +
        (p ? ` · area ${p.areaCm2.toFixed(1)} cm² · volume ${p.volumeCm3?.toFixed(1) ?? '-'} cm³ · mean ${p.meanHeightMm?.toFixed(1) ?? '-'} mm · max ${p.maxHeightMm?.toFixed(1) ?? '-'} mm [${p.flags.join(', ')}]` : ''),
    );
  }
  results.push({
    name,
    calibration: { ...c, diagnostics: cal.diagnostics },
    capture: {
      status: r.attempt.status,
      pixels: r.attempt.segmentation?.capturePixelsWasted,
      physical: { ...r.physical, depth: r.physical.depth ? { ...r.physical.depth, png: undefined } : null },
      measurements: r.measurements.map((m) => ({ item: m.itemId ? names.get(m.itemId) : null, pixels: m.remainingAreaPx, physical: m.physical })),
    },
  });
}
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ refLabel, refArea, fx: fx ?? 'c920s-nominal', geminiCalls: gateway.callCount, results }, null, 2));
console.log(`Gemini calls: ${gateway.callCount}`);
