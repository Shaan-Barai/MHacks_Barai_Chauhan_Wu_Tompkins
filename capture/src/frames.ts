/**
 * Frame helpers for dish grouping (BRIDGE.md §4.1).
 *
 * Both work on the same centered square crop that `normalizeImage` uses, so
 * the bridge compares exactly the region that would be uploaded.
 *  - fingerprint: 64x64 RGB pixels for the no-AI "nothing moved" check. RGB,
 *    not grayscale: two differently colored plates can share a gray level.
 *  - thumbnail: 512x512 JPEG sent (transiently) to POST /api/dish-match.
 */

import sharp from 'sharp';

export const PREFILTER_VERSION = 'prefilter-v1';
/** Mean absolute per-channel difference (0-255) below which two frames count as unchanged. */
export const DEFAULT_PREFILTER_MAD = 4;
const FINGERPRINT_PX = 64;
const THUMBNAIL_PX = 512;

async function centerSquare(bytes: Uint8Array): Promise<sharp.Sharp> {
  const image = sharp(bytes, { failOn: 'error' }).rotate();
  const meta = await image.metadata();
  const swaps = (meta.orientation ?? 1) >= 5;
  const w = (swaps ? meta.height : meta.width) ?? 0;
  const h = (swaps ? meta.width : meta.height) ?? 0;
  const side = Math.min(w, h);
  return image.extract({ left: Math.floor((w - side) / 2), top: Math.floor((h - side) / 2), width: side, height: side });
}

export async function fingerprint(bytes: Uint8Array): Promise<Uint8Array> {
  const image = await centerSquare(bytes);
  const raw = await image.resize(FINGERPRINT_PX, FINGERPRINT_PX).removeAlpha().toColourspace('srgb').raw().toBuffer();
  return new Uint8Array(raw);
}

export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

export async function thumbnail(bytes: Uint8Array): Promise<{ mimeType: 'image/jpeg'; base64: string }> {
  const image = await centerSquare(bytes);
  const jpeg = await image.resize(THUMBNAIL_PX, THUMBNAIL_PX).jpeg({ quality: 80 }).toBuffer();
  return { mimeType: 'image/jpeg', base64: jpeg.toString('base64') };
}
