/**
 * Step-by-step Scrap pipeline for one food photo, with a picture of every stage:
 *
 *   1. original      the photo as analysed (EXIF-rotated, long side 1024 px, no crop)
 *   2. gemini boxes  Gemini classification + per-piece boxes against the food database
 *   3. sam masks     SAM 2.1 mask for each box (one colour per region)
 *   4. final         validated, exclusive masks clipped to the target dish, with
 *                    Pixels wasted and relative CO2 / water points per food
 *
 * The measurement itself is vision's analyzeCaptureWithMasks (AGENTS.md §7);
 * this file only adds the food database and the step pictures. Shared by
 * make-demo-pictures.mjs (demo_pictures/) and server.mjs (upload website).
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../', import.meta.url));
const vision = await import(path.join(REPO, 'vision/dist/src/index.js'));
const sharp = createRequire(path.join(REPO, 'vision/package.json'))('sharp');

export const { createGeminiGateway, createSamWorkerClient } = vision;
export const MAX_SIDE = 1024;
/** Same unit as analytics/src/wasteImpact.ts: base = pixels / 1000 × g/cm². */
const PIXELS_PER_POINT_UNIT = 1000;

// ---------------------------------------------------------------- food database

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.replace(/^﻿/, ''), r[i] ?? ''])));
}

const readCsv = (name) => parseCsv(readFileSync(path.join(REPO, name), 'utf8'));
/** The dinner tables were renamed with an _EastQuad suffix (2026-10-04); accept either name. */
const firstExisting = (...names) => names.find((n) => existsSync(path.join(REPO, n))) ?? names[0];
const DINNER_FACTORS = firstExisting('menu_waste_factors_EastQuad.csv', 'menu_waste_factors.csv');
const DINNER_NUTRITION = firstExisting('menu_nutrition_factors_EastQuad.csv', 'menu_nutrition_factors.csv');
const num = (v) => (v === undefined || v === '' ? null : Number(v));
export const slug = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Descriptions for rows whose CSV has no Gemini visible-components text (same text as data/src/seed/generate.ts). */
const FALLBACK_DESCRIPTIONS = {
  'baked-sweet-potatoes': 'orange baked sweet potato flesh and skins',
  'halal-rice': 'loose, fluffy yellow-orange long-grain rice tinted with turmeric, separate grains, sometimes with flecks of spice or onion',
  tomatoes: 'diced or sliced raw red tomato pieces with glossy red flesh, pale seeds and juice',
  lettuce: 'shredded or chopped raw lettuce, crisp pale-green to green leaf ribbons and torn pieces',
  'halal-chicken': 'bite-size chunks of seasoned halal chicken thigh, orange-red to reddish-brown spiced exterior, often with sauce streaks',
};

/**
 * Every food with carbon/water factors: the 26-food dinner table
 * (menu_waste_factors.csv + menu_nutrition_factors.csv) plus the Halal Bros
 * rows that are not already in it (Yellow Rice, Diced Tomatoes and Shredded
 * Lettuce duplicate Halal Rice, Tomatoes and Lettuce, so only Halal Chicken is added).
 */
export function loadFoodDatabase() {
  const nutrition = new Map(readCsv(DINNER_NUTRITION).map((r) => [r.food, r]));
  const DUPLICATES = new Set(['Yellow Rice', 'Diced Tomatoes', 'Shredded Lettuce']);
  const rows = [
    ...readCsv(DINNER_FACTORS).map((r) => ({ ...r, ...(nutrition.get(r.food) ?? {}), table: DINNER_FACTORS })),
    ...readCsv('menu_waste_factors_halal_bros.csv')
      .filter((r) => !DUPLICATES.has(r.food))
      .map((r) => ({ ...r, table: 'menu_waste_factors_halal_bros.csv' })),
  ];
  return rows.map((r) => {
    const key = slug(r.food);
    return {
      key,
      food: r.food,
      station: r.station,
      table: r.table,
      description: r.gemini_visible_components || FALLBACK_DESCRIPTIONS[key] || '',
      weightGPerCm2: num(r.weight_g_per_cm2),
      co2KgPerKg: num(r.C_kg_co2e_per_kg),
      waterM3PerKg: num(r.W_water_m3_per_kg),
      impactScorePerKg: num(r.impact_score_usd_per_kg),
      nutrientDaysPerKg: num(r.O_nutrient_days_per_kg),
      kcalPerKg: num(r.kcal_per_kg),
      largestFactor: r.largest_factor || null,
      co2Label: r.menu_co2_label || null,
      allergens: r.allergens_listed || null,
      recipe: r.recipe_kg_per_kg || null,
    };
  });
}

/** A one-off menu for the analysis: optionally restricted to some food keys. */
export function menuFromFoods(foods, keys = null) {
  const chosen = keys ? keys.map((k) => foods.find((f) => f.key === k) ?? fail(`unknown food key ${k}`)) : foods;
  const menuId = keys ? `menu_upload_${keys.join('+')}` : 'menu_upload_all-foods';
  return {
    menuId,
    menuVersion: 1,
    items: chosen.map((f) => ({
      itemId: `item_${f.key}`,
      menuId,
      displayName: f.food,
      category: f.station,
      ...(f.description ? { description: f.description } : {}),
    })),
  };
}

function fail(msg) { throw new Error(msg); }

/** Relative points (unitless; menu_waste_factors_README.md "Turning pixels into relative impact points"). */
export function impactFor(food, pixels) {
  if (!food || food.weightGPerCm2 == null) return null;
  const base = (pixels / PIXELS_PER_POINT_UNIT) * food.weightGPerCm2;
  const pts = (f) => (f == null ? null : Math.round(base * f * 10) / 10);
  return {
    co2Points: pts(food.co2KgPerKg),
    waterPoints: pts(food.waterM3PerKg),
    impactPoints: pts(food.impactScorePerKg),
    nutritionPoints: pts(food.nutrientDaysPerKg),
  };
}

// ---------------------------------------------------------------- images

/** EXIF-rotate and scale the long side to MAX_SIDE (never crops, never upscales). */
export async function normalizeImage(bytes) {
  const rotated = await sharp(bytes).rotate().toBuffer();
  const meta = await sharp(rotated).metadata();
  const scale = Math.min(1, MAX_SIDE / Math.max(meta.width, meta.height));
  const W = Math.round(meta.width * scale), H = Math.round(meta.height * scale);
  const jpeg = await sharp(rotated).resize(W, H, { kernel: sharp.kernel.lanczos3 }).jpeg({ quality: 90 }).toBuffer();
  return { bytes: new Uint8Array(jpeg), widthPx: W, heightPx: H, source: { widthPx: meta.width, heightPx: meta.height } };
}

const PALETTE = [
  [230, 74, 25], [30, 136, 229], [67, 160, 71], [142, 36, 170], [253, 216, 53],
  [0, 172, 193], [216, 27, 96], [124, 179, 66], [94, 53, 177], [255, 143, 0],
];
const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function banner(W, title) {
  return `<rect x="0" y="0" width="${W}" height="40" fill="rgba(0,0,0,0.72)"/>
    <text x="16" y="28" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="700" fill="#fff">${esc(title)}</text>`;
}

async function compositeSvg(baseJpeg, W, H, svgBody) {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svgBody}</svg>`);
  return sharp(baseJpeg).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 90 }).toBuffer();
}

/** Adds a title bar to a step picture (demo_pictures/); the website shows titles in the page instead. */
async function titled(jpeg, title) {
  if (!jpeg) return null;
  const { width, height } = await sharp(jpeg).metadata();
  return compositeSvg(jpeg, width, height, banner(width, title));
}

/** Gemini boxes: counted food in its item colour, other-dish food dashed grey, target dish dashed amber. */
async function renderBoxes(img, regions, names, colorFor, targetDish) {
  const W = img.widthPx, H = img.heightPx;
  let body = '';
  if (targetDish.found && targetDish.box) {
    const [x0, y0, x1, y1] = targetDish.box.pixelXyxy;
    body += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="#ffb300" stroke-width="4" stroke-dasharray="14 8"/>
      <text x="${x0 + 6}" y="${Math.min(H - 6, y1 - 8)}" font-family="Helvetica, Arial, sans-serif" font-size="16" font-weight="700" fill="#ffb300" stroke="#000" stroke-width="3" paint-order="stroke">target ${esc(targetDish.dishType ?? 'dish')}</text>`;
  }
  for (const r of regions) {
    const [x0, y0, x1, y1] = r.box.pixelXyxy;
    const other = r.error?.code === 'OTHER_DISH';
    const color = other ? '#bdbdbd' : hex(colorFor(r.itemId));
    const label = r.itemId ? names.get(r.itemId) ?? r.itemId : 'unclassified';
    body += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="${color}" stroke-width="2.5"${other ? ' stroke-dasharray="6 4"' : ''}/>`;
    if (x1 - x0 > 40) {
      body += `<text x="${x0 + 3}" y="${y0 + 13}" font-family="Helvetica, Arial, sans-serif" font-size="12" font-weight="700" fill="${color}" stroke="#000" stroke-width="3" paint-order="stroke">${esc(label)}</text>`;
    }
  }
  return compositeSvg(img.bytes, W, H, body);
}

/**
 * Raw SAM 2.1 output, exactly as the worker returned it: every food region in
 * its own colour (off-dish food grey) and the target-dish mask outlined in
 * amber. This is before overlap resolution and the dish clip.
 */
async function renderSamMasks(img, regions, raw) {
  const W = img.widthPx, H = img.heightPx;
  const { data: rgb } = await sharp(img.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) out[i] = rgb[i] * 0.45;
  const paint = (bm, [cr, cg, cb]) => {
    for (let p = 0; p < W * H; p++) {
      if (!bm[p]) continue;
      const o = p * 3;
      out[o] = rgb[o] * 0.35 + cr * 0.65;
      out[o + 1] = rgb[o + 1] * 0.35 + cg * 0.65;
      out[o + 2] = rgb[o + 2] * 0.35 + cb * 0.65;
    }
  };
  let k = 0;
  for (const r of regions) {
    const bm = raw.maskFor(r.box.pixelXyxy);
    if (!bm) continue;
    if (r.error?.code === 'OTHER_DISH') paint(bm, UNCLASSIFIED_RGB);
    else paint(bm, PALETTE[k++ % PALETTE.length]);
  }
  if (raw.dishMask) {
    const d = raw.dishMask; // amber edge of the raw dish mask
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (d[p] && (!d[p - 1] || !d[p + 1] || !d[p - W] || !d[p + W])) { out[p * 3] = 255; out[p * 3 + 1] = 179; out[p * 3 + 2] = 0; }
    }
  }
  const base = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  return base;
}

/** Wraps the SAM client and keeps every box → mask it returned, so the step pictures show SAM's own output. */
function recordingSegmenter(sam, W, H) {
  const calls = [];
  const segmenter = {
    async segment(image, boxes) {
      const res = await sam.segment(image, boxes);
      calls.push({ boxes, res });
      return res;
    },
  };
  const maskFor = (box) => {
    for (const { boxes, res } of calls) {
      const k = boxes.findIndex((b) => b.every((v, i) => v === box[i]));
      if (k >= 0 && res.results[k]) {
        const d = vision.decodeBinaryMask(res.results[k].maskPng, W, H);
        return d.ok ? d.bitmap : null;
      }
    }
    return null;
  };
  return { segmenter, maskFor };
}

const FOOD_COLORS = [[46, 204, 113], [231, 76, 60], [52, 152, 219], [241, 196, 15], [155, 89, 182], [26, 188, 156], [230, 126, 34], [236, 64, 122]];
const UNCLASSIFIED_RGB = [158, 158, 158];

/** The counted, exclusive per-food masks (vision's itemMasks) drawn with vision's renderOverlay and a pixel legend. */
async function renderFinal(img, r, seg, names, foodById, colorFor, raw) {
  if (!seg || (seg.countStatus !== 'complete' && seg.countStatus !== 'partial' && seg.countStatus !== 'empty')) return null;
  const W = img.widthPx, H = img.heightPx;
  const pngById = new Map(r.itemMasks.map((m) => [m.measurementId, m.png]));
  const buckets = [];
  for (const m of [...r.measurements].sort((a, b) => b.remainingAreaPx - a.remainingAreaPx)) {
    const decoded = vision.decodeBinaryMask(pngById.get(m.measurementId), W, H);
    if (!decoded.ok) return null;
    buckets.push({
      itemId: m.itemId, label: m.itemId ? names.get(m.itemId) ?? m.itemId : 'Unclassified food',
      pixels: m.remainingAreaPx, bitmap: decoded.bitmap, color: colorFor(m.itemId),
    });
  }
  // Not-counted food: off-dish masks plus target-food pixels outside the dish region, minus counted pixels.
  const counted = new Uint8Array(W * H);
  for (const b of buckets) for (let p = 0; p < W * H; p++) if (b.bitmap[p]) counted[p] = 1;
  const other = new Uint8Array(W * H);
  for (const g of seg.regions) {
    const bm = raw.maskFor(g.box.pixelXyxy);
    if (!bm) continue;
    const off = g.error?.code === 'OTHER_DISH';
    if (!off && !raw.dishRegion) continue;
    for (let p = 0; p < W * H; p++) if (bm[p] && !counted[p] && (off || !raw.dishRegion[p])) other[p] = 1;
  }
  const otherPx = other.reduce((a, v) => a + v, 0);
  const rendered = await vision.renderOverlay({
    image: { bytes: img.bytes }, widthPx: W, heightPx: H, buckets,
    otherDish: otherPx ? { bitmap: other, pixels: otherPx } : null,
    dishRegion: raw.dishRegion,
    dishBox: r.targetDish.box?.pixelXyxy ?? null,
    emptyText: 'No leftover food: 0 pixels wasted',
  });
  if (!rendered.ok) return null;
  return Buffer.from(rendered.overlay.jpeg);
}

// ---------------------------------------------------------------- pipeline

/**
 * Run the full pipeline on raw image bytes. Returns the four step JPEGs and a
 * JSON summary (pixels per food, relative points, database factors, provenance).
 */
export async function runSteps({ gateway, sam, bytes, foods, menuKeys = null, titles = false, eventId = `upload_${Date.now()}` }) {
  const img = await normalizeImage(bytes);
  const menu = menuFromFoods(foods, menuKeys);
  const names = new Map(menu.items.map((i) => [i.itemId, i.displayName]));
  const foodById = new Map(menu.items.map((i) => [i.itemId, foods.find((f) => `item_${f.key}` === i.itemId)]));

  const rec = recordingSegmenter(sam, img.widthPx, img.heightPx);
  const t0 = performance.now();
  const r = await vision.analyzeCaptureWithMasks(gateway, rec.segmenter, {
    eventId,
    attemptId: `${eventId}_1`,
    image: { bytes: img.bytes, mimeType: 'image/jpeg' },
    geometry: { widthPx: img.widthPx, heightPx: img.heightPx, coordinateSpace: 'topdown-normalized-v1' },
    menu,
    renderOverlay: false, // re-rendered below with colours by detection order (vision colours by menu position)
  });
  const seconds = Math.round((performance.now() - t0) / 100) / 10;

  const seg = r.attempt.segmentation;
  const regions = seg?.regions ?? [];
  // Rebuild the clip region from SAM's dish mask exactly as vision did (deterministic), for the overlay outline.
  const dishBox = r.targetDish.box?.pixelXyxy ?? null;
  const dishMask = dishBox ? rec.maskFor(dishBox) : null;
  const built = r.targetDish.clipApplied && dishMask ? vision.buildDishRegion(dishMask, img.widthPx, img.heightPx, dishBox) : null;
  const raw = { maskFor: rec.maskFor, dishMask, dishRegion: built?.ok ? built.region : null };
  const foodsOut = r.measurements.map((m) => {
    const food = m.itemId ? foodById.get(m.itemId) : null;
    return {
      itemId: m.itemId,
      food: m.itemId ? names.get(m.itemId) ?? m.itemId : 'Unclassified food',
      pixelsWasted: m.remainingAreaPx,
      boxes: regions.filter((g) => g.itemId === m.itemId && g.error?.code !== 'OTHER_DISH').length,
      points: impactFor(food, m.remainingAreaPx),
      factors: food ? {
        co2KgPerKg: food.co2KgPerKg, waterM3PerKg: food.waterM3PerKg, weightGPerCm2: food.weightGPerCm2,
        impactScorePerKg: food.impactScorePerKg, nutrientDaysPerKg: food.nutrientDaysPerKg, kcalPerKg: food.kcalPerKg,
        largestFactor: food.largestFactor, co2Label: food.co2Label, station: food.station, table: food.table,
      } : null,
    };
  }).sort((a, b) => b.pixelsWasted - a.pixelsWasted);
  // Foods found get distinct colours in order of size, shared by the box view and the final overlay.
  const foundColor = new Map(foodsOut.map((f, n) => [f.itemId, f.itemId == null ? UNCLASSIFIED_RGB : FOOD_COLORS[n % FOOD_COLORS.length]]));
  const colorFor = (itemId) => foundColor.get(itemId) ?? UNCLASSIFIED_RGB;
  const sum = (k) => {
    const vals = foodsOut.map((f) => f.points?.[k]).filter((v) => v != null);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 10) / 10 : null;
  };

  const images = {
    original: img.bytes,
    boxes: await renderBoxes(img, regions, names, colorFor, r.targetDish),
    masks: await renderSamMasks(img, regions, raw),
    final: await renderFinal(img, r, seg, names, foodById, colorFor, raw),
  };
  if (titles) {
    const total = `${(seg?.capturePixelsWasted ?? 0).toLocaleString('en-US')} pixels wasted${seg?.countStatus === 'partial' ? ' (partial)' : ''}`;
    images.original = await titled(images.original, 'Original');
    images.boxes = await titled(images.boxes, 'Gemini classification');
    images.masks = await titled(images.masks, 'SAM 2.1 masks');
    images.final = await titled(images.final, `Final result: ${total}`);
  }

  return {
    images,
    summary: {
      status: r.attempt.status,
      countStatus: seg?.countStatus ?? 'unavailable',
      error: r.attempt.error ? { code: r.attempt.error.code, message: r.attempt.error.message } : null,
      qualityFlags: r.attempt.qualityFlags,
      capturePixelsWasted: seg?.capturePixelsWasted ?? null,
      analysedImage: { widthPx: img.widthPx, heightPx: img.heightPx, sourceWidthPx: img.source.widthPx, sourceHeightPx: img.source.heightPx },
      foods: foodsOut,
      totals: { co2Points: sum('co2Points'), waterPoints: sum('waterPoints'), impactPoints: sum('impactPoints'), nutritionPoints: sum('nutritionPoints') },
      targetDish: {
        found: r.targetDish.found, dishType: r.targetDish.dishType ?? null, clipApplied: r.targetDish.clipApplied,
        excludedBoxes: r.targetDish.excludedBoxes, otherDishPx: r.targetDish.otherDishPx,
      },
      regions: regions.map((g) => ({
        regionId: g.regionId, food: g.itemId ? names.get(g.itemId) : 'unclassified', visualLabel: g.visualLabel,
        geminiBox_yxyx_1000: g.box.gemini, pixelBox_xyxy: g.box.pixelXyxy, segmentation: g.segmentationStatus,
        maskPixels: g.maskPixels ?? null, samScore: g.score ?? null, excluded: g.error?.code ?? null,
      })),
      localization: r.localization,
      overlayCheck: { dishRegionMatchesVision: built?.ok ? built.regionPx === r.targetDish.regionPx : null, visionRegionPx: r.targetDish.regionPx ?? null },
      menu: { menuId: menu.menuId, foods: menu.items.map((i) => i.displayName) },
      provenance: {
        classification: { model: r.attempt.model, promptVersion: r.attempt.promptVersion },
        segmenter: seg ? { model: seg.model, checkpoint: seg.checkpoint, settingsVersion: seg.settingsVersion, countingRuleVersion: seg.countingRuleVersion } : null,
        pointsFormula: 'base = pixels / 1000 × weight_g_per_cm2; co2Points = base × C; waterPoints = base × W; impactPoints = base × (0.19·C + 1.50·W); nutritionPoints = base × O',
      },
      seconds,
      geminiCalls: r.localization.geminiCalls,
    },
  };
}
