/**
 * Local pixel measurement on images/: Gemini classification, then Gemini
 * segmentation masks, then real pixel counting.
 *
 *   cd vision && npm run build && node --env-file=../.env scripts/segment-eval.mjs [outDir]
 *
 * 1. Classify (assessLeftovers): label + countable/uncountable.
 * 2. Segment: Gemini returns one polygon outline per piece (points as
 *    [y, x] on a 0-1000 grid), constrained by a response schema. Gemini 3.x
 *    models don't return the PNG probability masks of the 2.5 family (which
 *    is closed to new API keys), so masks are polygons.
 * 3. Each polygon is filled at the image's real resolution and OR-ed into one
 *    bitmap per label, so overlapping masks never count a pixel twice
 *    (AGENTS.md §7.4). Instance count = number of polygons (a piece count for
 *    countable food).
 *
 * Blind like leftover-eval.mjs: metadata stripped, shuffled, anonymous ids.
 * Writes mask overlays to outDir (default: a temp folder) for visual review.
 */

import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { assessLeftovers, createGeminiGateway } from '../dist/src/index.js';

const sharp = createRequire(fileURLToPath(new URL('../../capture/package.json', import.meta.url)))('sharp');
const dir = fileURLToPath(new URL('../../images/', import.meta.url));
const outDir = process.argv[2] ?? path.join(tmpdir(), 'scrap-segmentation');
mkdirSync(outDir, { recursive: true });
const LABELS = ['burger', 'fries'];
const MODEL = process.env.GEMINI_SEGMENT_MODEL || process.env.GEMINI_MODEL || 'gemini-3.8-flash';

const gateway = createGeminiGateway();
if (gateway.mode !== 'live') throw new Error('GEMINI_API_KEY is not set: this script makes live calls.');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function segmentPrompt(label, countable) {
  const target = countable
    ? `each individual piece of ${label} (one outline per separate piece, including partly hidden pieces)`
    : `the ${label} (one outline tracing its whole visible edge, including any bitten edge)`;
  return (
    `Segment ${target}. Only food: exclude plate, background, and shadows. ` +
    'For each, return a polygon outline that tightly follows the food edge, as [y, x] points normalized to 0-1000, ' +
    'ordered around the boundary, with enough points (20-60) to follow curves and bite marks.'
  );
}

const POLYGON_SCHEMA = {
  type: 'OBJECT',
  required: ['masks'],
  properties: {
    masks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['label', 'polygon'],
        properties: {
          label: { type: 'STRING' },
          polygon: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'INTEGER' } } },
        },
      },
    },
  },
};

async function segment(jpeg, label, countable) {
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }, { text: segmentPrompt(label, countable) }] }],
    config: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: POLYGON_SCHEMA,
      thinkingConfig: { thinkingBudget: 0 },
      abortSignal: AbortSignal.timeout(120_000),
    },
  });
  return JSON.parse(res.text ?? '{}').masks ?? [];
}

/** Fill every polygon at full resolution and OR them into one bitmap. */
async function rasterize(masks, width, height) {
  const union = new Uint8Array(width * height);
  let used = 0;
  for (const m of masks) {
    const pts = (m.polygon ?? []).filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
    if (pts.length < 3) continue;
    const points = pts.map(([y, x]) => `${((x / 1000) * width).toFixed(1)},${((y / 1000) * height).toFixed(1)}`).join(' ');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/><polygon points="${points}" fill="white"/></svg>`;
    const { data } = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < union.length; i++) if (data[i] > 127) union[i] = 1;
    used++;
  }
  return { union, used };
}

/**
 * Sanity reference for white-background photos only: pixels that aren't
 * near-white (any channel < 230, or clearly coloured). Not a general food
 * segmenter — real trays aren't white — just a yardstick for these images.
 */
async function whiteBackgroundReference(jpeg) {
  const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ref = new Uint8Array(info.width * info.height);
  for (let i = 0; i < ref.length; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    if (Math.min(r, g, b) < 200 || Math.max(r, g, b) - Math.min(r, g, b) > 40) ref[i] = 1;
  }
  return ref;
}

/**
 * Pixel-based "% left" for uncountable food: the convex hull of the mask
 * approximates the uneaten serving (a bite is a concave notch), so
 * mask area / hull area ≈ fraction remaining. Rough: it can't see a bite
 * taken from a convex edge, or food missing from the middle.
 */
function hullPercent(union, width, height) {
  const pts = [];
  for (let y = 0; y < height; y++) {
    let lo = -1, hi = -1;
    for (let x = 0; x < width; x++) if (union[y * width + x]) { if (lo < 0) lo = x; hi = x; }
    if (lo >= 0) pts.push([lo, y], [hi + 1, y], [lo, y + 1], [hi + 1, y + 1]);
  }
  if (pts.length < 3) return null;
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const h = [];
    for (const p of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    return h;
  };
  const hull = [...half(pts).slice(0, -1), ...half([...pts].reverse()).slice(0, -1)];
  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i], [x2, y2] = hull[(i + 1) % hull.length];
    area += x1 * y2 - x2 * y1;
  }
  const maskPx = union.reduce((s, v) => s + v, 0);
  return area ? (100 * maskPx) / (Math.abs(area) / 2) : null;
}

async function overlay(jpeg, union, width, height, file) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < union.length; i++) if (union[i]) rgba.set([255, 0, 128, 140], i * 4);
  await sharp(jpeg)
    .composite([{ input: rgba, raw: { width, height, channels: 4 } }])
    .png()
    .toFile(path.join(outDir, file));
}

const files = readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
const images = [];
for (const file of files) {
  const jpeg = await sharp(readFileSync(path.join(dir, file))).jpeg({ quality: 92 }).toBuffer(); // metadata dropped
  const { width, height } = await sharp(jpeg).metadata();
  images.push({ file, jpeg, width, height });
}
images.sort(() => Math.random() - 0.5);
images.forEach((img, i) => (img.id = `image-${i + 1}`));
console.log(`classification: ${gateway.model}; segmentation: ${MODEL}; overlays -> ${outDir}\n`);

const rows = [];
for (const img of images) {
  const cls = await assessLeftovers(gateway, { image: { kind: 'bytes', bytes: img.jpeg, mimeType: 'image/jpeg' }, labels: LABELS });
  if (!cls.ok || cls.items.length === 0) {
    rows.push({ ...img, note: cls.ok ? 'no food found' : `classification failed: ${cls.error.code}` });
    console.log(`${img.id}: ${rows.at(-1).note}`);
    continue;
  }
  const top = cls.items[0];
  let masks = [];
  let error;
  try {
    masks = await segment(img.jpeg, top.label, top.countable);
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 120) : String(err);
  }
  const { union, used } = await rasterize(masks, img.width, img.height);
  const foodPx = union.reduce((s, v) => s + v, 0);
  const ref = await whiteBackgroundReference(img.jpeg);
  let refPx = 0, both = 0, either = 0;
  for (let i = 0; i < ref.length; i++) {
    refPx += ref[i];
    both += ref[i] & union[i];
    either += ref[i] | union[i];
  }
  await overlay(img.jpeg, union, img.width, img.height, `${MODEL}-${img.id}.png`);
  const row = {
    ...img,
    label: top.label,
    countable: top.countable,
    geminiEstimate: top.countable ? `${top.count} pieces` : `${top.percentRemaining}% left`,
    masks: used,
    foodPx,
    framePct: (100 * foodPx) / (img.width * img.height),
    refPx,
    hullPct: top.countable ? null : hullPercent(union, img.width, img.height),
    recall: refPx ? (100 * both) / refPx : 0,
    iou: either ? (100 * both) / either : 0,
    error,
  };
  rows.push(row);
  console.log(
    `${img.id}: ${row.label} (${row.countable ? 'countable' : 'uncountable'}) | Gemini: ${row.geminiEstimate} | ` +
      `masks: ${used} | food pixels: ${foodPx.toLocaleString()} of ${(img.width * img.height).toLocaleString()} (${row.framePct.toFixed(1)}%)` +
      (error ? ` | segmentation error: ${error}` : ''),
  );
}

console.log('\nUnblinded (file names were never sent):');
for (const r of rows.sort((a, b) => a.file.localeCompare(b.file))) {
  console.log(
    `  ${r.file.padEnd(15)} ${r.id.padEnd(8)} ` +
      (r.note ??
        `${r.label}: ${r.geminiEstimate}; ${r.masks} mask(s); Gemini mask ${r.foodPx.toLocaleString()} px vs ` +
          `white-bg reference ${r.refPx.toLocaleString()} px (covers ${r.recall.toFixed(0)}% of it, IoU ${r.iou.toFixed(0)}%)` +
          (r.hullPct != null ? `; pixel-based ${r.hullPct.toFixed(0)}% left (mask / convex hull)` : '')),
  );
}
