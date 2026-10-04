/**
 * Target-dish region (BIG-PLAN v2, V3): the pixel-level safety behind
 * "count only the dish being scanned".
 *
 * Gemini's localization answer names the target dish (box + type) and marks
 * every food box as on or off that dish; off-dish boxes are dropped in
 * maskPipeline.ts. As a second line of defence, the remaining food masks are
 * clipped to the dish's region, built here from SAM's mask of the dish box:
 *
 *   1. Cut the SAM dish mask to the Gemini dish box expanded by a margin
 *      (max(dilatePx, 5% of the box's longer side)), so a mask that bled onto
 *      a neighbouring plate cannot grow the region.
 *   2. Drop specks: keep every 4-connected component of at least
 *      max(0.05% of the frame, 2% of the largest component). NOT only the
 *      largest: a fork or a band of food lying across the dish splits the
 *      dish surface into several large pieces (seen live on test2/IMG_2697).
 *   3. Fill: take the convex hull of what is left. Food on the dish shows up
 *      as holes in the dish mask, and food lying across the rim turns those
 *      holes into notches that a plain hole fill would miss. Plates, bowls
 *      and trays are convex, so the hull fills both.
 *   4. Dilate by `dilatePx` = max(2, round(1% of the image's longer side))
 *      pixels (10 px on the 1024x1024 normalized capture), square structuring
 *      element, so food resting on the rim is not shaved off.
 *   5. Plausibility: the region must cover 2-95% of the frame AND at least
 *      50% of the frame-clamped Gemini dish box (a round dish fills ~78% of
 *      its box). Otherwise it is unusable and the caller does NOT clip (it
 *      flags `target_dish_unavailable` and keeps the counts): an incomplete
 *      dish mask must never shave off real food.
 *
 * 6. Union with the ellipse inscribed in the Gemini dish box (grown by `dilatePx`), so a dish
 *    mask that missed part of the dish (bowl at an angle / at the frame edge, live
 *    IMG_2695) can never clip food Gemini put on the target dish.
 *
 * Everything here is deterministic integer image code (no model calls).
 */

export const DISH_REGION_VERSION = 'dish-region-v3';
/** Region smaller than this fraction of the frame-clamped dish box is incomplete (step 5). */
export const MIN_BOX_COVERAGE = 0.5;
/** Region smaller than this fraction of the frame is implausible (tiny). */
export const MIN_REGION_FRACTION = 0.02;
/** Region larger than this fraction of the frame is implausible (covers nearly the whole frame). */
export const MAX_REGION_FRACTION = 0.95;
/** Box margin as a fraction of the dish box's longer side (step 3). */
const BOX_MARGIN_FRACTION = 0.05;

/** Dilation radius in pixels: max(2, round(1% of the longer image side)). 10 px on 1024². */
export function dishDilatePx(width: number, height: number): number {
  return Math.max(2, Math.round(0.01 * Math.max(width, height)));
}

export type DishRegionResult =
  | { ok: true; region: Uint8Array; regionPx: number; dilatePx: number }
  | {
      ok: false;
      reason: 'dish_mask_empty' | 'region_too_small' | 'region_too_large' | 'region_incomplete';
      regionPx: number;
      dilatePx: number;
    };

/** 4-connected component labels (1..n, 0 = background) and each component's size (index = label). */
export function labelComponents(bitmap: Uint8Array, width: number, height: number): { label: Int32Array; sizes: number[] } {
  const size = width * height;
  const label = new Int32Array(size);
  const queue = new Int32Array(size);
  const sizes = [0];
  let next = 0;
  for (let start = 0; start < size; start++) {
    if (!bitmap[start] || label[start]) continue;
    next++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = next;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % width;
      if (x > 0 && bitmap[i - 1] && !label[i - 1]) (label[i - 1] = next), (queue[tail++] = i - 1);
      if (x < width - 1 && bitmap[i + 1] && !label[i + 1]) (label[i + 1] = next), (queue[tail++] = i + 1);
      if (i >= width && bitmap[i - width] && !label[i - width]) (label[i - width] = next), (queue[tail++] = i - width);
      if (i + width < size && bitmap[i + width] && !label[i + width]) (label[i + width] = next), (queue[tail++] = i + width);
    }
    sizes.push(tail);
  }
  return { label, sizes };
}

/** Largest 4-connected component of a 0/1 bitmap (ties: first found in raster order). */
export function largestComponent(bitmap: Uint8Array, width: number, height: number): { bitmap: Uint8Array; pixels: number } {
  const { label, sizes } = labelComponents(bitmap, width, height);
  let best = 0;
  for (let k = 1; k < sizes.length; k++) if (sizes[k]! > sizes[best]!) best = k;
  const out = new Uint8Array(width * height);
  if (best) for (let i = 0; i < out.length; i++) if (label[i] === best) out[i] = 1;
  return { bitmap: out, pixels: sizes[best]! };
}

/**
 * Drop specks: keep every component of at least max(minFrameFraction of the
 * frame, minLargestFraction of the largest component).
 */
export function dropSpecks(
  bitmap: Uint8Array,
  width: number,
  height: number,
  minFrameFraction = 0.0005,
  minLargestFraction = 0.02,
): { bitmap: Uint8Array; pixels: number } {
  const { label, sizes } = labelComponents(bitmap, width, height);
  const largest = Math.max(0, ...sizes);
  const min = Math.max(minFrameFraction * width * height, minLargestFraction * largest, 1);
  const keep = sizes.map((n, k) => k > 0 && n >= min);
  const out = new Uint8Array(width * height);
  let pixels = 0;
  for (let i = 0; i < out.length; i++)
    if (keep[label[i]!]) {
      out[i] = 1;
      pixels++;
    }
  return { bitmap: out, pixels };
}

/**
 * Filled convex hull of a 0/1 bitmap: every pixel whose centre lies inside or
 * on the hull of the foreground pixel centres. Andrew's monotone chain on the
 * leftmost/rightmost pixel of each row, then a scanline fill.
 */
export function convexHullFill(bitmap: Uint8Array, width: number, height: number): Uint8Array {
  const pts: Array<[number, number]> = [];
  for (let y = 0; y < height; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < width; x++)
      if (bitmap[y * width + x]) {
        if (lo < 0) lo = x;
        hi = x;
      }
    if (lo >= 0) {
      pts.push([lo, y]);
      if (hi !== lo) pts.push([hi, y]);
    }
  }
  const out = new Uint8Array(width * height);
  if (pts.length === 0) return out;
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let k = pts.length - 1; k >= 0; k--) {
    const p = pts[k]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  if (hull.length === 0) hull.push(pts[0]!);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of hull) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const eps = 1e-9;
  for (let y = minY; y <= maxY; y++) {
    let xmin = Infinity;
    let xmax = -Infinity;
    for (let k = 0; k < hull.length; k++) {
      const [x0, y0] = hull[k]!;
      const [x1, y1] = hull[(k + 1) % hull.length]!;
      if (y0 === y1) {
        if (y0 === y) {
          xmin = Math.min(xmin, x0, x1);
          xmax = Math.max(xmax, x0, x1);
        }
        continue;
      }
      if (y < Math.min(y0, y1) || y > Math.max(y0, y1)) continue;
      const x = x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
      xmin = Math.min(xmin, x);
      xmax = Math.max(xmax, x);
    }
    if (hull.length === 1) xmin = xmax = hull[0]![0];
    if (!Number.isFinite(xmin)) continue;
    const from = Math.max(0, Math.ceil(xmin - eps));
    const to = Math.min(width - 1, Math.floor(xmax + eps));
    out.fill(1, y * width + from, y * width + to + 1);
  }
  return out;
}

/** Square dilation by r pixels (Chebyshev), separable via running counts. */
export function dilateSquare(bitmap: Uint8Array, width: number, height: number, r: number): Uint8Array {
  if (r <= 0) return bitmap.slice();
  const tmp = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x < Math.min(r, width); x++) count += bitmap[row + x]!;
    for (let x = 0; x < width; x++) {
      if (x + r < width) count += bitmap[row + x + r]!;
      if (x - r - 1 >= 0) count -= bitmap[row + x - r - 1]!;
      if (count > 0) tmp[row + x] = 1;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(r, height); y++) count += tmp[y * width + x]!;
    for (let y = 0; y < height; y++) {
      if (y + r < height) count += tmp[(y + r) * width + x]!;
      if (y - r - 1 >= 0) count -= tmp[(y - r - 1) * width + x]!;
      if (count > 0) out[y * width + x] = 1;
    }
  }
  return out;
}

/**
 * Build the target-dish clip region from a validated SAM dish mask and the
 * dish's pixel XYXY box (steps 1-5 above).
 */
export function buildDishRegion(
  dishMask: Uint8Array,
  width: number,
  height: number,
  boxXyxy: [number, number, number, number],
): DishRegionResult {
  const dilatePx = dishDilatePx(width, height);
  // 1. Cut to the dish box + margin.
  const margin = Math.max(dilatePx, BOX_MARGIN_FRACTION * Math.max(boxXyxy[2] - boxXyxy[0], boxXyxy[3] - boxXyxy[1]));
  const bx0 = Math.max(0, Math.floor(boxXyxy[0] - margin));
  const by0 = Math.max(0, Math.floor(boxXyxy[1] - margin));
  const bx1 = Math.min(width, Math.ceil(boxXyxy[2] + margin));
  const by1 = Math.min(height, Math.ceil(boxXyxy[3] + margin));
  const cut = new Uint8Array(width * height);
  for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) if (dishMask[y * width + x]) cut[y * width + x] = 1;
  // 2. Drop specks (keep every significant piece), 3. hull, 4. dilate.
  const kept = dropSpecks(cut, width, height);
  if (kept.pixels === 0) return { ok: false, reason: 'dish_mask_empty', regionPx: 0, dilatePx };
  const region = dilateSquare(convexHullFill(kept.bitmap, width, height), width, height, dilatePx);
  // 5. Plausibility.
  let regionPx = 0;
  for (let i = 0; i < region.length; i++) regionPx += region[i]!;
  const frame = width * height;
  if (regionPx < MIN_REGION_FRACTION * frame) return { ok: false, reason: 'region_too_small', regionPx, dilatePx };
  if (regionPx > MAX_REGION_FRACTION * frame) return { ok: false, reason: 'region_too_large', regionPx, dilatePx };
  const boxArea =
    Math.max(0, Math.min(width, boxXyxy[2]) - Math.max(0, boxXyxy[0])) * Math.max(0, Math.min(height, boxXyxy[3]) - Math.max(0, boxXyxy[1]));
  if (regionPx < MIN_BOX_COVERAGE * boxArea) return { ok: false, reason: 'region_incomplete', regionPx, dilatePx };
  // 6. Union with the ellipse inscribed in the dish box: SAM can miss part of a bowl seen at an
  //    angle or touching the frame edge, and the hull of what it found then cuts across real food.
  //    The box is Gemini's own extent for the dish, so the ellipse is where the dish must be.
  const unioned = unionInscribedEllipse(region, width, height, boxXyxy, dilatePx);
  let unionPx = 0;
  for (let i = 0; i < unioned.length; i++) unionPx += unioned[i]!;
  return { ok: true, region: unioned, regionPx: unionPx, dilatePx };
}

/** `region` plus the ellipse inscribed in the (frame-clamped) box, grown by `grow` pixels. */
function unionInscribedEllipse(
  region: Uint8Array,
  width: number,
  height: number,
  box: [number, number, number, number],
  grow: number,
): Uint8Array {
  const out = region.slice();
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const rx = (box[2] - box[0]) / 2 + grow;
  const ry = (box[3] - box[1]) / 2 + grow;
  if (rx <= 0 || ry <= 0) return out;
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(height - 1, Math.ceil(cy + ry));
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(width - 1, Math.ceil(cx + rx));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) out[y * width + x] = 1;
    }
  return out;
}

/** Keep only the pixels of `bitmap` inside `region`. Returns the clipped copy and how many pixels were removed. */
export function clipToRegion(bitmap: Uint8Array, region: Uint8Array): { bitmap: Uint8Array; kept: number; removed: number } {
  const out = new Uint8Array(bitmap.length);
  let kept = 0;
  let removed = 0;
  for (let i = 0; i < bitmap.length; i++) {
    if (!bitmap[i]) continue;
    if (region[i]) {
      out[i] = 1;
      kept++;
    } else removed++;
  }
  return { bitmap: out, kept, removed };
}
