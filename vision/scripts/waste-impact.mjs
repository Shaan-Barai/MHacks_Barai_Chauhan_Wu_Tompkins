/**
 * Relative waste impact for real plate photos (BIG-PLAN v2, V1/V2;
 * factors/README.md). Research script only: the product computes
 * impact in analytics, never in the vision library.
 *
 *   cd vision && npm run build
 *   node --env-file=../.env scripts/waste-impact.mjs <imagesDir> <menu_waste_factors_EastQuad.csv> [outDir]
 *
 * Needs the SAM worker (vision/sam/worker.py) and a Gemini key.
 *
 * Per photo:
 *  1. Normalize: apply EXIF rotation, drop metadata, resize to 1600 px on the
 *     long side (pixel counts refer to this image; they are comparable only
 *     between photos normalized the same way).
 *  2. The library pipeline (analyzeCaptureWithMasks, counting rule
 *     target-dish-v1): Gemini classifies leftovers against the CSV's foods,
 *     boxes them and names the target dish; food on other dishes is dropped;
 *     SAM 2.1 masks are clipped to the target dish and counted (pixels).
 *  3. Relative impact points (unitless, comparable only with each other):
 *       points = pixels / 1000 x weight_g_per_cm2 x factor
 *     co2Points uses C, waterPoints uses W, impactPoints uses 0.19C + 1.50W.
 *     nutritionPoints uses O (menu_nutrition_factors_EastQuad.csv next to the factor
 *     CSV, or env NUTRITION_CSV) and is separate: never part of impactPoints.
 *     There is no plate-size calibration, so these are NOT grams, kg CO2e,
 *     litres or dollars.
 * Unknown food keeps its pixels but has no factors, so no points.
 *
 * Experiment settings (env):
 *   MENU_SOURCE=claude|gemini   the numbered menu is "food — {MENU_SOURCE}_visible_components"
 *                               (comma list runs both, e.g. claude,gemini).
 *   RUNS=n                      repeat every photo n times per source
 *   EXPERIMENT_CSV=path         write photo,menu_source,run,dish,pixels,impact_points,unknown_pct
 *   MAX_GEMINI_CALLS=n          abort if Gemini calls exceed n (runaway guard)
 *   GEMINI_PASSES=1|2           localization passes per plate (default 2; read by the pipeline)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { analyzeCaptureWithMasks, createGeminiGateway, createSamWorkerClient } from '../dist/src/index.js';

const [imagesDir, csvPath, outArg] = process.argv.slice(2);
if (!imagesDir || !csvPath) throw new Error('usage: waste-impact.mjs <imagesDir> <menu_waste_factors_EastQuad.csv> [outDir]');
const outDir = outArg ?? path.join(process.env.TMPDIR ?? '/tmp', 'scrap-waste-impact');
mkdirSync(outDir, { recursive: true });
const LONG_SIDE = 1600;

// --- CSV (RFC-4180 quotes) ----------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const nutritionPath = process.env.NUTRITION_CSV ?? path.join(path.dirname(csvPath), 'menu_nutrition_factors_EastQuad.csv');
const nutritionBySlug = new Map(
  existsSync(nutritionPath)
    ? parseCsv(readFileSync(nutritionPath, 'utf8')).map((r) => [slug(r.food), Number(r.O_nutrient_days_per_kg)]).filter(([, o]) => Number.isFinite(o))
    : [],
);
if (nutritionBySlug.size === 0) console.warn(`no nutrition factors at ${nutritionPath}; nutritionPoints are n/a`);
const factors = parseCsv(readFileSync(csvPath, 'utf8')).map((r) => ({
  itemId: `item_${slug(r.food)}`,
  food: r.food,
  gPerCm2: Number(r.weight_g_per_cm2),
  C: Number(r.C_kg_co2e_per_kg),
  W: Number(r.W_water_m3_per_kg),
  O: nutritionBySlug.get(slug(r.food)) ?? null,
  visible: { claude: (r.claude_visible_components ?? '').trim(), gemini: (r.gemini_visible_components ?? '').trim() },
}));
const byId = new Map(factors.map((f) => [f.itemId, f]));
const MENU_SOURCES = (process.env.MENU_SOURCE ?? 'claude').split(',').map((v) => v.trim());
for (const src of MENU_SOURCES) if (src !== 'claude' && src !== 'gemini') throw new Error(`MENU_SOURCE must be "claude" or "gemini", got "${src}"`);
const RUNS = Math.max(1, Number(process.env.RUNS ?? 1));
const EXPERIMENT = process.env.MENU_SOURCE !== undefined || RUNS > 1;
function menuFor(source) {
  return {
    menuId: 'menu_test_dinner',
    menuVersion: 1,
    items: factors.map((f) => ({
      itemId: f.itemId,
      menuId: 'menu_test_dinner',
      displayName: f.food,
      ...(f.visible[source] ? { description: f.visible[source] } : {}),
    })),
  };
}

/** BIG-PLAN v2 V2: relative points from pixels (unitless; never kg, litres or dollars). */
export function pointsFor(pixels, f) {
  const base = (pixels / 1000) * f.gPerCm2;
  const co2Points = base * f.C;
  const waterPoints = base * f.W;
  return { co2Points, waterPoints, impactPoints: 0.19 * co2Points + 1.5 * waterPoints, nutritionPoints: f.O === null ? null : base * f.O };
}

const gateway = createGeminiGateway();
if (gateway.mode !== 'live') throw new Error('Set GEMINI_API_KEY: this script makes live calls.');
const sam = createSamWorkerClient();

const files = readdirSync(imagesDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
const results = [];
const passes = Number(process.env.GEMINI_PASSES ?? 2) === 1 ? 1 : 2;
const MAX_CALLS = Number(process.env.MAX_GEMINI_CALLS ?? MENU_SOURCES.length * RUNS * files.length * passes + 1);
const plan = MENU_SOURCES.flatMap((source) => Array.from({ length: RUNS }, (_, k) => files.map((file) => ({ source, run: k + 1, file })))).flat();
const fmt = (v) => (v === null ? 'n/a' : v.toFixed(2));
for (const [step, { source, run, file }] of plan.entries()) {
  const menu = menuFor(source);
  const jpeg = await sharp(readFileSync(path.join(imagesDir, file))).rotate().resize(LONG_SIDE, LONG_SIDE, { fit: 'inside' }).jpeg({ quality: 92 }).toBuffer();
  const { width: W, height: H } = await sharp(jpeg).metadata();
  const t0 = performance.now();
  const analysis = await analyzeCaptureWithMasks(gateway, sam, {
    eventId: `test2_${file}`,
    attemptId: `${path.parse(file).name}_${source}_run${run}`,
    image: { bytes: new Uint8Array(jpeg), mimeType: 'image/jpeg' },
    geometry: { widthPx: W, heightPx: H, coordinateSpace: 'topdown-normalized-v1' },
    menu,
  });
  const seg = analysis.attempt.segmentation;
  const regionLabel = new Map(seg.regions.map((r) => [r.regionId, r.visualLabel]));
  const items = [...analysis.measurements]
    .sort((a, b) => b.remainingAreaPx - a.remainingAreaPx)
    .map((m) => {
      const f = m.itemId ? byId.get(m.itemId) : undefined;
      const labels = (m.regionIds ?? []).map((id) => regionLabel.get(id)).filter(Boolean);
      return { food: f?.food ?? `unknown (${labels.join('; ') || 'unclassified'})`, known: !!f, pixels: m.remainingAreaPx, points: f ? pointsFor(m.remainingAreaPx, f) : null };
    });
  const unknownPixels = items.filter((i) => !i.known).reduce((s, i) => s + i.pixels, 0);
  const capturePixels = seg.capturePixelsWasted ?? 0;
  const row = {
    file, menuSource: source, run, width: W, height: H, localization: analysis.localization,
    status: analysis.attempt.status, countStatus: seg.countStatus, flags: analysis.attempt.qualityFlags,
    capturePixels, unknownPixels, unknownPct: capturePixels > 0 ? (100 * unknownPixels) / capturePixels : 0,
    targetDish: analysis.targetDish, items,
    totalImpactPoints: items.reduce((s, i) => s + (i.points?.impactPoints ?? 0), 0),
    seconds: (performance.now() - t0) / 1000,
  };
  results.push(row);
  const overlayName = EXPERIMENT ? `${path.parse(file).name}_${source}_run${run}_segmentation.jpg` : `${path.parse(file).name}_segmentation.jpg`;
  if (analysis.overlay) writeFileSync(path.join(outDir, overlayName), analysis.overlay.jpeg);

  const td = analysis.targetDish;
  const loc = analysis.localization;
  console.log(`\n[${step + 1}/${plan.length}] ${file}  menu=${source} run=${run}  ${analysis.attempt.status}/${seg.countStatus}  ${row.seconds.toFixed(1)}s` +
    (analysis.attempt.error ? `  ${analysis.attempt.error.code}` : '') + `  | Gemini API calls so far: ${gateway.callCount}`);
  console.log(`  boxes: ${loc.passBoxes.map((n, k) => `pass ${k + 1}=${n ?? 'failed'}`).join(', ')}, after merge=${loc.mergedBoxes}` +
    (loc.failedPasses.length ? ` (failed: ${loc.failedPasses.join(', ')})` : ''));
  console.log(`  target dish: ${td.found ? td.dishType : 'not found'}, clip ${td.clipApplied ? 'applied' : `not applied (${td.clipUnavailableReason})`}; ` +
    `other dish (not counted): ${td.excludedBoxes} boxes, ${td.otherDishPx.toLocaleString()} px`);
  if (gateway.callCount > MAX_CALLS) throw new Error(`Gemini call guard: ${gateway.callCount} calls > MAX_GEMINI_CALLS=${MAX_CALLS}; stopping.`);
  for (const i of items) {
    console.log(`  ${i.food.padEnd(34)} ${String(i.pixels.toLocaleString()).padStart(9)} px` +
      (i.points ? `  impact ${fmt(i.points.impactPoints)} pts (CO2 ${fmt(i.points.co2Points)}, water ${fmt(i.points.waterPoints)}; nutrition, separate: ${fmt(i.points.nutritionPoints)})` : '  (no factors: not on menu)'));
  }
  console.log(`  TOTAL: ${capturePixels.toLocaleString()} px, relative impact ${row.totalImpactPoints.toFixed(2)} pts`);
}

writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
if (process.env.EXPERIMENT_CSV) {
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = ['photo,menu_source,run,dish,pixels,impact_points,unknown_pct'];
  for (const r of results) {
    const photo = path.parse(r.file).name;
    const pct = r.unknownPct.toFixed(2);
    const dishes = r.items.filter((i) => i.known);
    if (dishes.length === 0) lines.push([photo, r.menuSource, r.run, '', 0, '', pct].map(q).join(','));
    for (const i of dishes) lines.push([photo, r.menuSource, r.run, i.food, i.pixels, i.points.impactPoints.toFixed(3), pct].map(q).join(','));
  }
  writeFileSync(process.env.EXPERIMENT_CSV, lines.join('\n') + '\n');
  console.log(`experiment rows -> ${process.env.EXPERIMENT_CSV} (${lines.length - 1} rows)`);
}
console.log(`Gemini API calls total: ${gateway.callCount}`);
const byFood = new Map();
for (const r of results) for (const i of r.items) if (i.known) {
  const v = byFood.get(i.food) ?? { px: 0, pts: 0, plates: 0 };
  v.px += i.pixels; v.pts += i.points.impactPoints; v.plates++; byFood.set(i.food, v);
}
const totalPx = results.reduce((s, r) => s + r.capturePixels, 0);
console.log(`\n=== ${results.length} photos: ${totalPx.toLocaleString()} px wasted, relative impact ${results.reduce((s, r) => s + r.totalImpactPoints, 0).toFixed(2)} pts ===`);
for (const [food, v] of [...byFood].sort((a, b) => b[1].pts - a[1].pts)) {
  console.log(`  ${food.padEnd(34)} ${v.px.toLocaleString().padStart(9)} px  ${v.pts.toFixed(2)} pts  (${v.plates} plate${v.plates > 1 ? 's' : ''})`);
}
console.log(`overlays + results.json -> ${outDir}`);
