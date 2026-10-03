/**
 * Box conversion, mask decoding/validation, and Pixels wasted counting
 * (contracts/measurement.md, MVP_AI.md steps 3, 5, 6, 7).
 *
 * Counting rule "union-v1":
 *  - An item's pixels = union of its own regions' masks (multiple regions of
 *    one item, e.g. scattered fries, never double-count).
 *  - A pixel claimed by two different named items is attributed to neither:
 *    it goes to the unclassified bucket and the capture is flagged
 *    'overlapping_masks' — no pixel is awarded to two items.
 *  - Regions classified as unknown food (itemId null) feed the unclassified bucket.
 *  - Capture total = union of every valid mask, so it always equals the sum
 *    of the per-item counts plus the unclassified bucket.
 *  - The pixels assigned to each bucket form an exclusive mask (no pixel in
 *    two buckets); these back FoodMeasurement.maskCount.
 */

import { PNG } from 'pngjs';
import type { RegionBox } from './contracts.js';

export const BOX_CONVENTION = 'gemini-yxyx-1000_to_xyxy-px_v1' as const;
export const COUNTING_RULE_VERSION = 'union-v1';

export type BoxResult = { ok: true; box: RegionBox } | { ok: false; reason: string };

/**
 * Gemini [ymin, xmin, ymax, xmax] on 0-1000 -> SAM pixel XYXY on a W x H image:
 *   [xmin * W / 1000, ymin * H / 1000, xmax * W / 1000, ymax * H / 1000]
 * Rejects nonfinite, out-of-range, reversed, and zero-size boxes.
 */
export function geminiBoxToPixels(gemini: unknown, width: number, height: number): BoxResult {
  if (!Array.isArray(gemini) || gemini.length !== 4) return { ok: false, reason: 'box_not_4_numbers' };
  if (!gemini.every((v) => typeof v === 'number' && Number.isFinite(v))) return { ok: false, reason: 'box_nonfinite' };
  const [ymin, xmin, ymax, xmax] = gemini as [number, number, number, number];
  if (![ymin, xmin, ymax, xmax].every((v) => v >= 0 && v <= 1000)) return { ok: false, reason: 'box_out_of_range' };
  if (!(xmax > xmin && ymax > ymin)) return { ok: false, reason: 'box_reversed_or_empty' };
  const pixelXyxy: [number, number, number, number] = [
    (xmin * width) / 1000,
    (ymin * height) / 1000,
    (xmax * width) / 1000,
    (ymax * height) / 1000,
  ];
  if (pixelXyxy[2] - pixelXyxy[0] < 1 || pixelXyxy[3] - pixelXyxy[1] < 1) return { ok: false, reason: 'box_under_one_pixel' };
  return {
    ok: true,
    box: { gemini: [ymin, xmin, ymax, xmax], pixelXyxy, convention: BOX_CONVENTION },
  };
}

export type MaskResult = { ok: true; bitmap: Uint8Array; pixels: number } | { ok: false; reason: string };

/**
 * Decode a binary PNG mask (foreground 255, background 0) and check it is
 * aligned with the analyzed image: exact dimensions, single-valued pixels.
 * Any other value (soft mask, overlay colour, JPEG artefact) is rejected
 * rather than silently thresholded.
 */
export function decodeBinaryMask(png: Uint8Array, width: number, height: number): MaskResult {
  let decoded: PNG;
  try {
    decoded = PNG.sync.read(Buffer.from(png));
  } catch {
    return { ok: false, reason: 'mask_not_png' };
  }
  if (decoded.width !== width || decoded.height !== height) return { ok: false, reason: 'mask_dimension_mismatch' };
  const bitmap = new Uint8Array(width * height);
  let pixels = 0;
  // pngjs always yields RGBA; a grey/binary mask has r === g === b and alpha 255.
  for (let i = 0; i < bitmap.length; i++) {
    const r = decoded.data[i * 4]!;
    if (decoded.data[i * 4 + 1] !== r || decoded.data[i * 4 + 2] !== r || decoded.data[i * 4 + 3] !== 255) {
      return { ok: false, reason: 'mask_not_greyscale' };
    }
    if (r === 255) {
      bitmap[i] = 1;
      pixels++;
    } else if (r !== 0) {
      return { ok: false, reason: 'mask_not_binary' };
    }
  }
  return { ok: true, bitmap, pixels };
}

export interface CountedRegion {
  regionId: string;
  itemId: string | null;
  bitmap: Uint8Array;
}

export interface PixelCounts {
  /** itemId -> assigned pixels (only items with at least one valid region). */
  perItem: Map<string, number>;
  /** itemId -> contributing regionIds. */
  regionsPerItem: Map<string, string[]>;
  /** Unknown-food pixels plus pixels contested between different items. */
  unclassifiedPx: number;
  unclassifiedRegionIds: string[];
  /** Pixels claimed by two or more different named items. */
  contestedPx: number;
  /** Union of all valid masks. */
  capturePx: number;
  /** itemId -> bitmap of exactly the pixels assigned to that item. */
  itemBitmaps: Map<string, Uint8Array>;
  /** Bitmap of the unclassified bucket (unknown food + contested pixels). */
  unclassifiedBitmap: Uint8Array;
}

/** Apply counting rule union-v1 to validated, equally sized bitmaps. */
export function countPixels(regions: CountedRegion[], size: number): PixelCounts {
  const UNCLAIMED = -1;
  const CONTESTED = -2;
  const UNKNOWN = -3;
  const itemIndex = new Map<string, number>();
  const owner = new Int32Array(size).fill(UNCLAIMED);
  let unknown = new Uint8Array(0);
  const regionsPerItem = new Map<string, string[]>();
  const unclassifiedRegionIds: string[] = [];

  for (const region of regions) {
    if (region.itemId === null) {
      if (unknown.length === 0) unknown = new Uint8Array(size);
      for (let i = 0; i < size; i++) if (region.bitmap[i]) unknown[i] = 1;
      unclassifiedRegionIds.push(region.regionId);
      continue;
    }
    let idx = itemIndex.get(region.itemId);
    if (idx === undefined) {
      idx = itemIndex.size;
      itemIndex.set(region.itemId, idx);
    }
    regionsPerItem.set(region.itemId, [...(regionsPerItem.get(region.itemId) ?? []), region.regionId]);
    for (let i = 0; i < size; i++) {
      if (!region.bitmap[i]) continue;
      const current = owner[i]!;
      if (current === UNCLAIMED) owner[i] = idx;
      else if (current >= 0 && current !== idx) owner[i] = CONTESTED;
    }
  }

  const perItemCounts = new Array<number>(itemIndex.size).fill(0);
  const bitmaps = Array.from({ length: itemIndex.size }, () => new Uint8Array(size));
  const unclassifiedBitmap = new Uint8Array(size);
  let unclassifiedPx = 0;
  let contestedPx = 0;
  let capturePx = 0;
  for (let i = 0; i < size; i++) {
    let o = owner[i]!;
    if (o === UNCLAIMED && unknown.length > 0 && unknown[i]) o = UNKNOWN;
    if (o === UNCLAIMED) continue;
    capturePx++;
    if (o >= 0) {
      perItemCounts[o]!++;
      bitmaps[o]![i] = 1;
    } else {
      unclassifiedPx++;
      unclassifiedBitmap[i] = 1;
      if (o === CONTESTED) contestedPx++;
    }
  }
  const perItem = new Map<string, number>();
  const itemBitmaps = new Map<string, Uint8Array>();
  for (const [itemId, idx] of itemIndex) {
    perItem.set(itemId, perItemCounts[idx]!);
    itemBitmaps.set(itemId, bitmaps[idx]!);
  }
  return { perItem, regionsPerItem, unclassifiedPx, unclassifiedRegionIds, contestedPx, capturePx, itemBitmaps, unclassifiedBitmap };
}

/** Encode a 0/1 bitmap as a binary greyscale PNG (255 = food) that decodeBinaryMask accepts. */
export function encodeBinaryMask(bitmap: Uint8Array, width: number, height: number): Uint8Array {
  const png = new PNG({ width, height, colorType: 0, inputColorType: 0, inputHasAlpha: false });
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < bitmap.length; i++) {
    const v = bitmap[i] ? 255 : 0;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  png.data = data;
  return new Uint8Array(PNG.sync.write(png, { colorType: 0 }));
}
