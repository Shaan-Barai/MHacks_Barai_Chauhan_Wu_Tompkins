/**
 * Segmented overlay JPEG (BIG-PLAN D7), ported from
 * vision/scripts/waste-impact.mjs.
 *
 * The normalized capture image with each food bucket's exclusive mask tinted
 * in its own colour (alpha 150/255), the fitted plate rim outlined in cyan
 * (plate-fit-v1 only), and a legend strip below the image: a header line
 * (calibration + total) and one line per food with its Pixels wasted.
 * Output size: width W, height H + legend height. The image itself is
 * neither resized nor re-oriented, so overlay pixels align with the masks.
 *
 * `sharp` is loaded lazily: if it is unavailable or the image cannot be
 * decoded, rendering returns an explicit failure (never throws) and the
 * analysis result is unaffected.
 */

import type { Circle } from './calibration.js';
import type { PlateCalibration } from './contracts.js';
import { sanitizeMenuText } from './prompt.js';

export const OVERLAY_VERSION = 'overlay-v1';
export const OVERLAY_JPEG_QUALITY = 88;
const TINT_ALPHA = 150;
const RIM_RGB: [number, number, number] = [0, 255, 255];
const UNKNOWN_RGB: [number, number, number] = [150, 150, 150];

export interface OverlayBucket {
  /** null = unclassified food. */
  itemId: string | null;
  label: string;
  pixels: number;
  /** Exclusive 0/1 bitmap on the W x H analyzed image. */
  bitmap: Uint8Array;
  color: [number, number, number];
}

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
  calibration: PlateCalibration;
  /** Fitted rim (plate-fit-v1); null draws no outline. */
  rim: Circle | null;
  /** Shown when there are no buckets, e.g. an explicit empty plate. */
  emptyText?: string;
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

export function calibrationHeader(cal: PlateCalibration): string {
  if (cal.method === 'configured-default') {
    return `Default scale: ${cal.plateDiameterPx} px = ${cal.plateDiameterCm} cm plate (plate not fitted)`;
  }
  const notes = [
    cal.flags.includes('plate_cut_off') ? 'cut off' : '',
    cal.flags.includes('bowl_size_assumed') ? 'bowl: size assumed' : '',
  ].filter(Boolean);
  return `${cal.dishType ?? 'plate'} ${cal.plateDiameterPx} px across = ${cal.plateDiameterCm} cm${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

/** Legend lines (also used by tests): header, then "label: N px" per bucket in the given order. */
export function legendLines(input: Pick<RenderOverlayInput, 'buckets' | 'calibration' | 'emptyText'>): string[] {
  const total = input.buckets.reduce((s, b) => s + b.pixels, 0);
  const header = `${calibrationHeader(input.calibration)} · Pixels wasted ${total.toLocaleString('en-US')} (AI masks)`;
  const rows = input.buckets.map((b) => `${sanitizeMenuText(b.label, 80)}: ${b.pixels.toLocaleString('en-US')} px`);
  if (rows.length === 0) rows.push(input.emptyText ?? 'No leftover food detected');
  return [header, ...rows];
}

type SharpFactory = typeof import('sharp');

async function loadSharp(): Promise<SharpFactory | null> {
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
    if (input.rim) {
      const { cx, cy, r } = input.rim;
      const half = Math.max(1.5, Math.min(W, H) / 400); // ~3 px wide on 1024²
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          if (Math.abs(Math.hypot(x - cx, y - cy) - r) <= half) rgba.set([...RIM_RGB, 255], (y * W + x) * 4);
    }
    const tinted = await sharp(Buffer.from(input.image.bytes))
      .composite([{ input: rgba, raw: { width: W, height: H, channels: 4 } }])
      .png()
      .toBuffer();

    const lines = legendLines(input);
    const scale = W / 1024;
    const font = Math.max(12, Math.round(18 * scale));
    const rowH = Math.round(font * 1.6);
    const pad = Math.round(14 * scale) + 2;
    const legendH = pad * 2 + lines.length * rowH;
    const swatch = Math.round(font * 1.05);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${legendH}">
  <rect width="100%" height="100%" fill="#1d1d1d"/>
  ${lines
    .map((line, k) => {
      const y = pad + k * rowH;
      const bucket = k === 0 ? undefined : input.buckets[k - 1];
      const sw = bucket ? `<rect x="${pad}" y="${y + Math.round((rowH - swatch) / 2)}" width="${swatch}" height="${swatch}" rx="3" fill="rgb(${bucket.color.join(',')})"/>` : '';
      const tx = bucket ? pad + swatch + Math.round(font * 0.6) : pad;
      return `${sw}<text x="${tx}" y="${y + Math.round(rowH * 0.7)}" font-family="Helvetica, Arial, sans-serif" font-size="${k === 0 ? font + 1 : font}" font-weight="${k === 0 ? 700 : 400}" fill="#f2f2f2">${escapeXml(line)}</text>`;
    })
    .join('\n  ')}
</svg>`;
    const jpeg = await sharp({ create: { width: W, height: H + legendH, channels: 3, background: '#1d1d1d' } })
      .composite([
        { input: tinted, left: 0, top: 0 },
        { input: Buffer.from(svg), left: 0, top: H },
      ])
      .jpeg({ quality: OVERLAY_JPEG_QUALITY })
      .toBuffer();
    return { ok: true, overlay: { jpeg: new Uint8Array(jpeg), widthPx: W, heightPx: H + legendH, mimeType: 'image/jpeg', version: OVERLAY_VERSION } };
  } catch (err) {
    return { ok: false, reason: `render_failed: ${String((err as Error)?.message ?? err).slice(0, 120)}` };
  }
}
