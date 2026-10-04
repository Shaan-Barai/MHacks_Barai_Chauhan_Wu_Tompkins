/**
 * Segmented overlay JPEG (BIG-PLAN D7, v2 target-dish counting).
 *
 * The normalized capture image with:
 *  - each counted food bucket's exclusive mask tinted in its own colour
 *    (alpha 150/255);
 *  - food that was NOT counted because it lies outside the scanned dish
 *    (other-dish boxes and pixels clipped off by the target-dish region)
 *    hatched in neutral grey;
 *  - the target dish outlined in cyan (its clip region), or its Gemini box
 *    drawn in amber when no region could be used (no clipping);
 *  - a legend strip below the image: a header line (Pixels wasted total and
 *    target-dish status), one line per food with its pixels, and
 *    "Other dish (not counted): N px". Pixels always; when the caller passes
 *    `labelSuffix` (IT_4 I8), its text follows the pixels on each food line,
 *    e.g. "Ancho Flank Steak: 12,345 px · 38 g · 1.1 kg CO2e · 18 L water".
 *    Vision never computes grams/CO2/water itself (that is analytics); the
 *    backend supplies the callback. Lines that would overflow the image
 *    width are truncated with "…" (the food name is shortened first, so the
 *    numbers stay readable).
 *
 * Output size: width W, height H + legend height. The image itself is
 * neither resized nor re-oriented, so overlay pixels align with the masks.
 *
 * `sharp` is loaded lazily: if it is unavailable or the image cannot be
 * decoded, rendering returns an explicit failure (never throws) and the
 * analysis result is unaffected.
 */

import type { PhysicalEstimate } from './contracts.js';
import { sanitizeMenuText } from './prompt.js';

export const OVERLAY_VERSION = 'overlay-v2';
export const OVERLAY_JPEG_QUALITY = 88;
const TINT_ALPHA = 150;
const DISH_RGB: [number, number, number] = [0, 255, 255];
const DISH_BOX_RGB: [number, number, number] = [255, 190, 0];
const UNKNOWN_RGB: [number, number, number] = [150, 150, 150];
/** Neutral grey for not-counted (other-dish) food. */
export const OTHER_DISH_COLOR: [number, number, number] = [205, 205, 205];

export interface OverlayBucket {
  /** null = unclassified food. */
  itemId: string | null;
  label: string;
  pixels: number;
  /** Exclusive 0/1 bitmap on the W x H analyzed image. */
  bitmap: Uint8Array;
  color: [number, number, number];
  /** IT_4: the bucket's calibrated area estimate, when one was computed. */
  physical?: PhysicalEstimate | null;
}

/** IT_4 I8: text appended to a food's legend line (e.g. "38 g · 1.1 kg CO2e · 18 L water"); null = none. */
export type LabelSuffix = (bucket: OverlayBucket) => string | null | undefined;

export interface OverlayImage {
  jpeg: Uint8Array;
  widthPx: number;
  heightPx: number;
  mimeType: 'image/jpeg';
  version: typeof OVERLAY_VERSION;
}

export interface RenderOverlayInput {
  image: { bytes: Uint8Array };
  widthPx: number;
  heightPx: number;
  buckets: OverlayBucket[];
  /** Not-counted food outside the target dish (0/1 bitmap + its pixel count). */
  otherDish?: { bitmap: Uint8Array; pixels: number } | null;
  /** Target-dish clip region (outlined in cyan). */
  dishRegion?: Uint8Array | null;
  /** Gemini's target-dish pixel XYXY box; drawn in amber only when there is no dishRegion. */
  dishBox?: [number, number, number, number] | null;
  /** Shown when there are no buckets, e.g. an explicit empty plate. */
  emptyText?: string;
  /** IT_4 I8: per-food suffix supplied by the backend (vision does not import analytics). */
  labelSuffix?: LabelSuffix;
}

export type RenderOverlayResult = { ok: true; overlay: OverlayImage } | { ok: false; reason: string };

/** One fixed colour per menu position (golden-angle hue); unknown food is grey. */
export function colorForIndex(k: number): [number, number, number] {
  const h = (k * 137.508) % 360;
  const sat = 0.75;
  const l = 0.5;
  const c = (1 - Math.abs(2 * l - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255)) as [number, number, number];
}

export const UNKNOWN_COLOR = UNKNOWN_RGB;

const escapeXml = (t: string) =>
  t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

export interface LegendLine {
  text: string;
  kind: 'header' | 'bucket' | 'other' | 'empty' | 'info';
  color?: [number, number, number];
  /** Bucket lines: the food name, shortened first when the line must be truncated. */
  head?: string;
  /** Bucket lines: everything after the name (": N px · suffix"). */
  tail?: string;
}

type LegendInput = Pick<RenderOverlayInput, 'buckets' | 'otherDish' | 'dishRegion' | 'dishBox' | 'emptyText' | 'labelSuffix'>;

/** Legend rows (also used by tests): header, "label: N px[ · suffix]" per bucket in order, then the other-dish line. */
export function legendRows(input: LegendInput): LegendLine[] {
  const total = input.buckets.reduce((s, b) => s + b.pixels, 0);
  const dish = input.dishRegion
    ? 'target dish outlined'
    : input.dishBox
      ? 'target dish not segmented (not clipped)'
      : 'target dish not found (not clipped)';
  const rows: LegendLine[] = [
    { kind: 'header', text: `Pixels wasted ${total.toLocaleString('en-US')} px (AI masks) · ${dish}` },
    ...input.buckets.map((b) => {
      let suffix = '';
      try {
        const raw = input.labelSuffix?.(b);
        if (typeof raw === 'string') suffix = sanitizeMenuText(raw, 80);
      } catch {
        suffix = ''; // a failing callback never breaks the overlay
      }
      const head = sanitizeMenuText(b.label, 80);
      const tail = `: ${b.pixels.toLocaleString('en-US')} px${suffix ? ` · ${suffix}` : ''}`;
      return { kind: 'bucket' as const, color: b.color, text: head + tail, head, tail };
    }),
  ];
  if (input.buckets.length === 0) rows.push({ kind: 'empty', text: input.emptyText ?? 'No leftover food detected' });
  if (input.otherDish && input.otherDish.pixels > 0) {
    rows.push({ kind: 'other', color: OTHER_DISH_COLOR, text: `Other dish (not counted): ${input.otherDish.pixels.toLocaleString('en-US')} px` });
  }
  return rows;
}

/** Legend text lines only. */
export function legendLines(input: LegendInput): string[] {
  return legendRows(input).map((r) => r.text);
}

/**
 * Fit a legend row into `maxChars` characters. Bucket rows shorten the food
 * name first (keeping at least 8 characters) so the numbers stay; anything
 * still too long is cut at the end. Truncation is marked with "…".
 */
export function fitLegendText(row: Pick<LegendLine, 'text' | 'head' | 'tail'>, maxChars: number): string {
  const max = Math.max(4, Math.floor(maxChars));
  if (row.text.length <= max) return row.text;
  if (row.head !== undefined && row.tail !== undefined) {
    const room = max - row.tail.length - 1;
    if (room >= Math.min(8, row.head.length)) return `${row.head.slice(0, room).trimEnd()}…${row.tail}`;
  }
  return `${row.text.slice(0, max - 1).trimEnd()}…`;
}

/** Approximate average glyph width of Helvetica/Arial, as a fraction of the font size (bold is wider). */
const GLYPH_EM = 0.56;
const GLYPH_EM_BOLD = 0.62;

export interface LegendLayout {
  svg: string;
  height: number;
  /** The text actually drawn per row (after truncation). */
  drawn: string[];
}

/** The legend strip below the image: one row per line, swatches for coloured rows, no line wider than W. */
export function layoutLegend(rows: LegendLine[], W: number): LegendLayout {
  const scale = W / 1024;
  const font = Math.max(12, Math.round(18 * scale));
  const rowH = Math.round(font * 1.6);
  const pad = Math.round(14 * scale) + 2;
  const height = pad * 2 + rows.length * rowH;
  const swatch = Math.round(font * 1.05);
  const drawn: string[] = [];
  const body = rows
    .map((row, k) => {
      const y = pad + k * rowH;
      const sy = y + Math.round((rowH - swatch) / 2);
      const sw = row.color
        ? `<rect x="${pad}" y="${sy}" width="${swatch}" height="${swatch}" rx="3" fill="${row.kind === 'other' ? 'url(#hatch)' : `rgb(${row.color.join(',')})`}"/>`
        : '';
      const tx = row.color ? pad + swatch + Math.round(font * 0.6) : pad;
      const header = row.kind === 'header';
      const size = header ? font + 1 : font;
      const maxChars = (W - tx - pad) / (size * (header ? GLYPH_EM_BOLD : GLYPH_EM));
      const text = fitLegendText(row, maxChars);
      drawn.push(text);
      return `${sw}<text x="${tx}" y="${y + Math.round(rowH * 0.7)}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${header ? 700 : 400}" fill="${row.kind === 'other' ? '#c8c8c8' : '#f2f2f2'}">${escapeXml(text)}</text>`;
    })
    .join('\n  ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}">
  <defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#3c3c3c"/><rect width="2" height="6" fill="rgb(${OTHER_DISH_COLOR.join(',')})"/></pattern></defs>
  <rect width="100%" height="100%" fill="#1d1d1d"/>
  ${body}
</svg>`;
  return { svg, height, drawn };
}

export type SharpFactory = typeof import('sharp');

export async function loadSharp(): Promise<SharpFactory | null> {
  try {
    const mod = (await import('sharp')) as unknown as { default?: SharpFactory };
    return mod.default ?? (mod as unknown as SharpFactory);
  } catch {
    return null;
  }
}

export async function renderOverlay(input: RenderOverlayInput): Promise<RenderOverlayResult> {
  const { widthPx: W, heightPx: H } = input;
  const sharp = await loadSharp();
  if (!sharp) return { ok: false, reason: 'sharp_unavailable' };
  try {
    const meta = await sharp(Buffer.from(input.image.bytes)).metadata();
    if (meta.width !== W || meta.height !== H) return { ok: false, reason: 'image_dimension_mismatch' };

    const rgba = Buffer.alloc(W * H * 4);
    const other = input.otherDish;
    if (other && other.bitmap.length !== W * H) return { ok: false, reason: 'bitmap_dimension_mismatch' };
    if (other) {
      // Hatched neutral grey: diagonal stripes, so it never reads as a food colour.
      const period = Math.max(6, Math.round(W / 128));
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (!other.bitmap[i]) continue;
          const stripe = (x + y) % period < period / 3;
          rgba.set(stripe ? [...OTHER_DISH_COLOR, 215] : [60, 60, 60, 120], i * 4);
        }
    }
    for (const b of input.buckets) {
      if (b.bitmap.length !== W * H) return { ok: false, reason: 'bitmap_dimension_mismatch' };
      const [r, g, bl] = b.color;
      for (let i = 0; i < W * H; i++)
        if (b.bitmap[i]) {
          rgba[i * 4] = r;
          rgba[i * 4 + 1] = g;
          rgba[i * 4 + 2] = bl;
          rgba[i * 4 + 3] = TINT_ALPHA;
        }
    }
    const t = Math.max(2, Math.round(Math.min(W, H) / 340)); // ~3 px outline on 1024²
    if (input.dishRegion) {
      const reg = input.dishRegion;
      if (reg.length !== W * H) return { ok: false, reason: 'bitmap_dimension_mismatch' };
      const on = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && reg[y * W + x] === 1;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          if (on(x, y) && (!on(x - t, y) || !on(x + t, y) || !on(x, y - t) || !on(x, y + t))) rgba.set([...DISH_RGB, 255], (y * W + x) * 4);
    } else if (input.dishBox) {
      const [x0, y0, x1, y1] = input.dishBox.map(Math.round) as [number, number, number, number];
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          const edge = x - x0 < t || x1 - 1 - x < t || y - y0 < t || y1 - 1 - y < t;
          const dash = Math.floor((x + y) / (4 * t)) % 2 === 0;
          if (edge && dash) rgba.set([...DISH_BOX_RGB, 255], (y * W + x) * 4);
        }
    }
    return await composeWithLegend(sharp, input.image.bytes, W, H, rgba, legendRows(input));
  } catch (err) {
    return { ok: false, reason: `render_failed: ${String((err as Error)?.message ?? err).slice(0, 120)}` };
  }
}

/**
 * Composite a W × H RGBA layer over the image and add the legend strip below
 * it. Shared by the capture overlay and the calibration overlay.
 */
export async function composeWithLegend(
  sharp: SharpFactory,
  imageBytes: Uint8Array,
  W: number,
  H: number,
  rgba: Buffer,
  rows: LegendLine[],
): Promise<RenderOverlayResult> {
  const tinted = await sharp(Buffer.from(imageBytes))
    .composite([{ input: rgba, raw: { width: W, height: H, channels: 4 } }])
    .png()
    .toBuffer();
  const legend = layoutLegend(rows, W);
  const jpeg = await sharp({ create: { width: W, height: H + legend.height, channels: 3, background: '#1d1d1d' } })
    .composite([
      { input: tinted, left: 0, top: 0 },
      { input: Buffer.from(legend.svg), left: 0, top: H },
    ])
    .jpeg({ quality: OVERLAY_JPEG_QUALITY })
    .toBuffer();
  return { ok: true, overlay: { jpeg: new Uint8Array(jpeg), widthPx: W, heightPx: H + legend.height, mimeType: 'image/jpeg', version: OVERLAY_VERSION } };
}
