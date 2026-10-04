/**
 * Box conversion, mask decoding/validation, and Pixels wasted counting
 * (contracts/measurement.md, MVP_AI.md steps 3, 5, 6, 7).
 *
 * Counting rule "smallest-first-v1":
 *  - Region masks are sorted by their own foreground size, smallest first
 *    (ties: item id, then first foreground pixel; never list order). Each mask claims only the pixels no
 *    earlier mask has claimed, so where masks overlap the smaller mask wins
 *    (a carrot slice on rice keeps its pixels; the rice mask loses them).
 *  - Claimed pixels go to the region's bucket: its menu item, or the
 *    unclassified bucket for menu_id 0 (itemId null).
 *  - Item pixels = sum of what its regions claimed, so multiple regions of
 *    one item never double-count. Any overlap flags 'overlapping_masks'.
 *  - Capture total = union of every valid mask = sum of all buckets.
 *  - The pixels assigned to each bucket form an exclusive mask (no pixel in
 *    two buckets); these back FoodMeasurement.maskCount.
 */

import { PNG } from 'pngjs';
import type { RegionBox } from './contracts.js';

export const BOX_CONVENTION = 'gemini-yxyx-1000_to_xyxy-px_v1' as const;
/** The overlap rule implemented by countPixels below. */
export const SMALLEST_FIRST_RULE = 'smallest-first-v1';
/**
 * The capture counting rule recorded on attempts and mask counts (BIG-PLAN
 * v2, V3): food boxes Gemini puts on another dish are dropped, the remaining
 * masks are clipped to the target-dish region when one is available
 * (targetDish.ts), then smallest-first-v1 assigns every pixel to at most one
 * bucket. Capture total = union of the clipped masks = sum of the buckets.
 */
export const COUNTING_RULE_VERSION = 'target-dish-v1';

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

/** Intersection-over-union of two pixel XYXY boxes. */
export function boxIoU(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
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
  /** Pixels claimed by unclassified (menu_id 0) regions. */
  unclassifiedPx: number;
  unclassifiedRegionIds: string[];
  /** Pixels covered by more than one mask (each counted once, for the smallest). */
  overlapPx: number;
  /** Union of all valid masks. */
  capturePx: number;
  /** itemId -> bitmap of exactly the pixels assigned to that item. */
  itemBitmaps: Map<string, Uint8Array>;
  /** Bitmap of the unclassified bucket. */
  unclassifiedBitmap: Uint8Array;
}

/** Apply counting rule smallest-first-v1 to validated, equally sized bitmaps. */
export function countPixels(regions: CountedRegion[], size: number): PixelCounts {
  const sized = regions.map((r, order) => {
    let px = 0;
    for (let i = 0; i < size; i++) if (r.bitmap[i]) px++;
    let first = -1;
    for (let i = 0; i < size; i++) if (r.bitmap[i]) { first = i; break; }
    return { r, order, px, first };
  });
  // Ties (equal size) resolve by content, not list order: item id (unclassified last), first pixel.
  const key = (id: string | null) => id ?? '\uffff';
  sized.sort((a, b) => a.px - b.px || (key(a.r.itemId) < key(b.r.itemId) ? -1 : key(a.r.itemId) > key(b.r.itemId) ? 1 : 0) || a.first - b.first || a.order - b.order);

  const claimed = new Uint8Array(size);
  const perItem = new Map<string, number>();
  const regionsPerItem = new Map<string, string[]>();
  const itemBitmaps = new Map<string, Uint8Array>();
  const unclassifiedBitmap = new Uint8Array(size);
  const unclassifiedRegionIds: string[] = [];
  let unclassifiedPx = 0;
  let overlapPx = 0;
  let capturePx = 0;
  // Regions keep classification order in regionsPerItem; claiming follows size order.
  for (const r of regions) {
    if (r.itemId === null) unclassifiedRegionIds.push(r.regionId);
    else regionsPerItem.set(r.itemId, [...(regionsPerItem.get(r.itemId) ?? []), r.regionId]);
  }
  for (const { r } of sized) {
    let target: Uint8Array;
    if (r.itemId === null) target = unclassifiedBitmap;
    else {
      target = itemBitmaps.get(r.itemId) ?? new Uint8Array(size);
      itemBitmaps.set(r.itemId, target);
      if (!perItem.has(r.itemId)) perItem.set(r.itemId, 0);
    }
    let won = 0;
    for (let i = 0; i < size; i++) {
      if (!r.bitmap[i]) continue;
      if (claimed[i]) {
        if (claimed[i] === 1) overlapPx++; // count each overlapped pixel once
        claimed[i] = 2;
        continue;
      }
      claimed[i] = 1;
      target[i] = 1;
      won++;
      capturePx++;
    }
    if (r.itemId === null) unclassifiedPx += won;
    else perItem.set(r.itemId, perItem.get(r.itemId)! + won);
  }
  return { perItem, regionsPerItem, unclassifiedPx, unclassifiedRegionIds, overlapPx, capturePx, itemBitmaps, unclassifiedBitmap };
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
