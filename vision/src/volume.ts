/**
 * Calibrated area (IT_4 I6, `area-calibrated-v1`) and Depth Anything V2
 * volume (IT_4 I5, `volume-dav2-v1`). Pure, deterministic code: no model
 * calls, no I/O.
 *
 * Area method: area_cm2 = pixels × k (k = calibration cm²/px at the base plane).
 *
 * Volume method, per capture (D(p) = scale × DAv2(p) × 100, cm):
 *   1. Plate reference plane. Robust plane fit Z(x, y) = a·x + b·y + c to D
 *      over the "plate ring": target-dish-region pixels, eroded by 2% of the
 *      longer image side (drops the rim and the table margin the region's
 *      dilation added), minus all food masks dilated by 1% (DAv2 smooths depth
 *      edges, so pixels right next to food read high). The fit starts from the
 *      median (a flat plane), keeps points within max(0.3 cm, 3 × 1.4826 ×
 *      MAD) of the current plane, refits by least squares, and repeats
 *      (trimmed IRLS, at most 8 rounds). Deterministic: no random sampling.
 *      If the ring has fewer than 2% of the dish pixels (food covers the
 *      plate), or there is no dish region, the plane is the calibration table
 *      plane minus `plateThicknessCm`, flagged `plate_plane_from_calibration`.
 *   2. h(p) = clamp(Z_plane(p) − D(p), 0, maxFoodHeightCm). When more than 5%
 *      of a bucket's valid pixels were clamped below 0 / above the max, the
 *      bucket is flagged `negative_heights_clipped` / `height_outliers_clipped`.
 *   3. a(p) = (D(p)/fx)·(D(p)/fy) cm² (the pixel's footprint at the food surface).
 *   4. volume = Σ h·a (cm³), area = Σ a (cm²), mean/max height (mm).
 *
 * Buckets are the pipeline's exclusive per-food bitmaps, so overlaps are
 * already counted once; a pixel that still appears in two buckets counts for
 * the first only. Invalid depth (non-finite, ≤ 0, > 20 m) in more than 10% of
 * a bucket ⇒ that bucket falls back to the area method with `depth_invalid`;
 * fewer invalid pixels are extrapolated from the valid ones. Bowls and
 * liquids (`bowl`) ⇒ the area method with `bowl_volume_unreliable`: the bowl
 * floor is hidden, so depth cannot give the food's thickness. A fallback is
 * never a zero.
 */

import type { PhysicalEstimate, VolumeFlag } from './contracts.js';
import { dilateSquare } from './targetDish.js';

export const AREA_METHOD = 'area-calibrated-v1' as const;
export const VOLUME_METHOD = 'volume-dav2-v1' as const;
export const DEFAULT_MAX_FOOD_HEIGHT_CM = 12;
export const DEFAULT_PLATE_THICKNESS_CM = 1.5;
/** Ring pixels below this fraction of the dish region ⇒ calibration-plane fallback. */
export const MIN_RING_FRACTION = 0.02;
/** A clip flag is raised when more than this fraction of a bucket's valid pixels were clamped. */
export const CLIP_FLAG_FRACTION = 0.05;
/** More invalid depth than this fraction of a bucket ⇒ area fallback with depth_invalid. */
export const MAX_INVALID_FRACTION = 0.1;
const MAX_VALID_DEPTH_M = 20;
const MIN_PLANE_TOLERANCE_CM = 0.3;
const MAX_FIT_POINTS = 200_000;

export interface Plane {
  a: number;
  b: number;
  c: number;
}

export const planeAt = (p: Plane, x: number, y: number) => p.a * x + p.b * y + p.c;

export interface AreaCalibration {
  calibrationId: string;
  /** k, cm² per pixel at the base plane. */
  cm2PerPx: number;
}

/** IT_4 I6: area_cm2 = pixels × k. */
export function computeAreaEstimate(pixels: number, calibration: AreaCalibration, flags: VolumeFlag[] = []): PhysicalEstimate {
  return {
    calibrationId: calibration.calibrationId,
    method: AREA_METHOD,
    areaCm2: round(pixels * calibration.cm2PerPx, 4),
    volumeCm3: null,
    meanHeightMm: null,
    maxHeightMm: null,
    flags: [...new Set(flags)],
  };
}

/** Least-squares plane through points (pixel x, y → z). null when degenerate. */
export function fitPlaneLeastSquares(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>, n = zs.length): Plane | null {
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i]!;
    my += ys[i]!;
    mz += zs[i]!;
  }
  mx /= n;
  my /= n;
  mz /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxz = 0;
  let syz = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    const dz = zs[i]! - mz;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    sxz += dx * dz;
    syz += dy * dz;
  }
  const det = sxx * syy - sxy * sxy;
  // Collinear / single-row points: fall back to a flat plane through the mean.
  if (!(Math.abs(det) > 1e-9 * Math.max(1, sxx * syy))) return { a: 0, b: 0, c: mz };
  const a = (sxz * syy - syz * sxy) / det;
  const b = (syz * sxx - sxz * sxy) / det;
  return { a, b, c: mz - a * mx - b * my };
}

function median(values: Float64Array | number[], n = values.length): number {
  const arr = Float64Array.from({ length: n }, (_, i) => values[i]!).sort();
  if (n === 0) return NaN;
  return n % 2 ? arr[(n - 1) / 2]! : (arr[n / 2 - 1]! + arr[n / 2]!) / 2;
}

export interface RobustPlaneFit {
  plane: Plane;
  /** Points used in the final least-squares fit. */
  inliers: number;
  /** Points offered to the fit (after subsampling). */
  points: number;
  /** Median absolute residual of the inliers (cm). */
  residualMadCm: number;
}

/**
 * Trimmed IRLS plane fit: start flat at the median, keep points within
 * max(minTol, 3 × 1.4826 × MAD) of the current plane, refit, repeat.
 */
export function fitPlaneRobust(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  zs: ArrayLike<number>,
  minTolerance = MIN_PLANE_TOLERANCE_CM,
): RobustPlaneFit | null {
  const n = zs.length;
  if (n < 3) return null;
  let plane: Plane = { a: 0, b: 0, c: median(Float64Array.from(zs as ArrayLike<number>)) };
  const res = new Float64Array(n);
  const ix = new Float64Array(n);
  const iy = new Float64Array(n);
  const iz = new Float64Array(n);
  let inliers = n;
  let mad = 0;
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < n; i++) res[i] = Math.abs(zs[i]! - planeAt(plane, xs[i]!, ys[i]!));
    mad = median(res);
    const tol = Math.max(minTolerance, 3 * 1.4826 * mad);
    let k = 0;
    for (let i = 0; i < n; i++)
      if (res[i]! <= tol) {
        ix[k] = xs[i]!;
        iy[k] = ys[i]!;
        iz[k] = zs[i]!;
        k++;
      }
    if (k < 3) break;
    const next = fitPlaneLeastSquares(ix, iy, iz, k);
    if (!next) break;
    const stable = k === inliers && Math.abs(next.a - plane.a) < 1e-9 && Math.abs(next.b - plane.b) < 1e-9 && Math.abs(next.c - plane.c) < 1e-6;
    plane = next;
    inliers = k;
    if (stable) break;
  }
  const finalRes: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.abs(zs[i]! - planeAt(plane, xs[i]!, ys[i]!));
    if (r <= Math.max(minTolerance, 3 * 1.4826 * mad)) finalRes.push(r);
  }
  return { plane, inliers, points: n, residualMadCm: round(median(finalRes), 4) };
}

/** Collect (x, y, D cm) for the selected pixels with valid depth, subsampled to ≤ MAX_FIT_POINTS by a fixed stride. */
export function collectPoints(
  select: Uint8Array,
  depthM: ArrayLike<number>,
  width: number,
  scale: number,
): { xs: Float64Array; ys: Float64Array; zs: Float64Array } {
  let total = 0;
  for (let i = 0; i < select.length; i++) if (select[i] && validDepth(depthM[i]!)) total++;
  const stride = Math.max(1, Math.ceil(total / MAX_FIT_POINTS));
  const m = Math.ceil(total / stride);
  const xs = new Float64Array(m);
  const ys = new Float64Array(m);
  const zs = new Float64Array(m);
  let seen = 0;
  let k = 0;
  for (let i = 0; i < select.length && k < m; i++) {
    if (!select[i] || !validDepth(depthM[i]!)) continue;
    if (seen++ % stride !== 0) continue;
    xs[k] = i % width;
    ys[k] = Math.floor(i / width);
    zs[k] = depthM[i]! * scale * 100;
    k++;
  }
  return { xs: xs.subarray(0, k), ys: ys.subarray(0, k), zs: zs.subarray(0, k) };
}

export const validDepth = (m: number) => Number.isFinite(m) && m > 0 && m <= MAX_VALID_DEPTH_M;

/** Square erosion by r pixels (complement of the dilated complement). */
export function erodeSquare(bitmap: Uint8Array, width: number, height: number, r: number): Uint8Array {
  if (r <= 0) return bitmap.slice();
  const inv = new Uint8Array(bitmap.length);
  for (let i = 0; i < bitmap.length; i++) inv[i] = bitmap[i] ? 0 : 1;
  const grown = dilateSquare(inv, width, height, r);
  const out = new Uint8Array(bitmap.length);
  for (let i = 0; i < bitmap.length; i++) out[i] = grown[i] ? 0 : 1;
  return out;
}

export interface VolumeBucket {
  /** Caller's key (e.g. measurementId or itemId); echoed back. */
  key: string;
  /** Exclusive 0/1 bitmap on the W × H image (the pipeline's per-bucket mask). */
  bitmap: Uint8Array;
  /** Bowl or liquid (soup) bucket ⇒ area method + bowl_volume_unreliable. */
  bowl?: boolean;
}

export interface VolumeInput {
  calibrationId: string;
  /** k, used for area fallbacks. */
  cm2PerPx: number;
  /** Raw DAv2 metric depth (m), row-major W × H. */
  depthM: ArrayLike<number>;
  width: number;
  height: number;
  /** Calibration depth scale (multiplies raw DAv2 depth). */
  scale: number;
  intrinsics: { fxPx: number; fyPx: number };
  buckets: VolumeBucket[];
  /** Target-dish clip region (0/1, W × H); null/absent ⇒ calibration-plane fallback. */
  dishRegion?: Uint8Array | null;
  /** Extra pixels to keep out of the plate fit (e.g. other-dish food). */
  excludeFromPlate?: Uint8Array | null;
  /** Calibration table plane in corrected depth (cm, pixel coords). */
  tablePlane: Plane;
  plateThicknessCm?: number;
  /** Whole capture is a bowl / liquid. */
  bowl?: boolean;
  maxFoodHeightCm?: number;
  depthSettingsVersion?: string;
}

export interface PlateReferenceInfo {
  reference: 'dish-ring-fit' | 'calibration-plane';
  plane: Plane;
  dishPx: number;
  ringPx: number;
  /** Robust-fit details when the ring was used. */
  fit?: { inliers: number; points: number; residualMadCm: number };
  /** Why the calibration plane was used. */
  fallbackReason?: 'no_dish_region' | 'ring_too_small' | 'ring_fit_failed';
}

export interface VolumeResult {
  /** One estimate per input bucket, same order. */
  estimates: Array<{ key: string; estimate: PhysicalEstimate }>;
  /** null when depth was unusable for the whole capture (everything fell back to area). */
  plate: PlateReferenceInfo | null;
  depthValid: boolean;
}

/** IT_4 I5. See the file header for the method. */
export function computeVolumeEstimates(input: VolumeInput): VolumeResult {
  const { width: W, height: H, scale } = input;
  const N = W * H;
  const maxH = input.maxFoodHeightCm ?? DEFAULT_MAX_FOOD_HEIGHT_CM;
  const thickness = input.plateThicknessCm ?? DEFAULT_PLATE_THICKNESS_CM;
  const { fxPx: fx, fyPx: fy } = input.intrinsics;
  const area = (b: VolumeBucket, flags: VolumeFlag[]) => {
    let px = 0;
    for (let i = 0; i < N; i++) px += b.bitmap[i] ? 1 : 0;
    return { key: b.key, estimate: computeAreaEstimate(px, input, flags) };
  };
  const t = input.tablePlane;
  const depthOk =
    input.depthM.length === N &&
    Number.isFinite(scale) &&
    scale > 0 &&
    fx > 0 &&
    fy > 0 &&
    [t.a, t.b, t.c].every(Number.isFinite) &&
    input.buckets.every((b) => b.bitmap.length === N);
  if (!depthOk) return { estimates: input.buckets.map((b) => area(b, ['depth_invalid'])), plate: null, depthValid: false };

  // 1. Plate reference plane.
  const foodUnion = new Uint8Array(N);
  for (const b of input.buckets) for (let i = 0; i < N; i++) if (b.bitmap[i]) foodUnion[i] = 1;
  if (input.excludeFromPlate) for (let i = 0; i < N; i++) if (input.excludeFromPlate[i]) foodUnion[i] = 1;
  const longSide = Math.max(W, H);
  let plate: PlateReferenceInfo;
  const calibrationPlane: Plane = { a: t.a, b: t.b, c: t.c - thickness };
  const dish = input.dishRegion && input.dishRegion.length === N ? input.dishRegion : null;
  if (!dish) {
    plate = { reference: 'calibration-plane', plane: calibrationPlane, dishPx: 0, ringPx: 0, fallbackReason: 'no_dish_region' };
  } else {
    let dishPx = 0;
    for (let i = 0; i < N; i++) dishPx += dish[i] ? 1 : 0;
    const inner = erodeSquare(dish, W, H, Math.max(1, Math.round(0.02 * longSide)));
    const nearFood = dilateSquare(foodUnion, W, H, Math.max(1, Math.round(0.01 * longSide)));
    const ring = new Uint8Array(N);
    let ringPx = 0;
    for (let i = 0; i < N; i++)
      if (inner[i] && !nearFood[i] && validDepth(input.depthM[i]!)) {
        ring[i] = 1;
        ringPx++;
      }
    if (ringPx < MIN_RING_FRACTION * dishPx || ringPx < 3) {
      plate = { reference: 'calibration-plane', plane: calibrationPlane, dishPx, ringPx, fallbackReason: 'ring_too_small' };
    } else {
      const pts = collectPoints(ring, input.depthM, W, scale);
      const fit = fitPlaneRobust(pts.xs, pts.ys, pts.zs);
      plate =
        fit && [fit.plane.a, fit.plane.b, fit.plane.c].every(Number.isFinite)
          ? {
              reference: 'dish-ring-fit',
              plane: fit.plane,
              dishPx,
              ringPx,
              fit: { inliers: fit.inliers, points: fit.points, residualMadCm: fit.residualMadCm },
            }
          : { reference: 'calibration-plane', plane: calibrationPlane, dishPx, ringPx, fallbackReason: 'ring_fit_failed' };
    }
  }
  const plateFlags: VolumeFlag[] = plate.reference === 'calibration-plane' ? ['plate_plane_from_calibration'] : [];

  // 2-4. Heights, footprints, sums per bucket (first bucket wins a shared pixel).
  const claimed = new Uint8Array(N);
  const estimates = input.buckets.map((b) => {
    if (b.bowl || input.bowl) return area(b, ['bowl_volume_unreliable']);
    let n = 0;
    let valid = 0;
    let neg = 0;
    let over = 0;
    let vol = 0;
    let areaSum = 0;
    let hSum = 0;
    let hMax = 0;
    for (let i = 0; i < N; i++) {
      if (!b.bitmap[i] || claimed[i]) continue;
      claimed[i] = 1;
      n++;
      const raw = input.depthM[i]!;
      if (!validDepth(raw)) continue;
      valid++;
      const D = raw * scale * 100;
      let h = planeAt(plate.plane, i % W, Math.floor(i / W)) - D;
      if (h < 0) {
        neg++;
        h = 0;
      } else if (h > maxH) {
        over++;
        h = maxH;
      }
      const a = (D / fx) * (D / fy);
      vol += h * a;
      areaSum += a;
      hSum += h;
      if (h > hMax) hMax = h;
    }
    if (n === 0) return { key: b.key, estimate: computeAreaEstimate(0, input, [...plateFlags]) };
    if (valid === 0 || (n - valid) / n > MAX_INVALID_FRACTION) return area(b, ['depth_invalid']);
    const extrapolate = n / valid;
    const flags: VolumeFlag[] = [...plateFlags];
    if (neg > CLIP_FLAG_FRACTION * valid) flags.push('negative_heights_clipped');
    if (over > CLIP_FLAG_FRACTION * valid) flags.push('height_outliers_clipped');
    const estimate: PhysicalEstimate = {
      calibrationId: input.calibrationId,
      method: VOLUME_METHOD,
      areaCm2: round(areaSum * extrapolate, 4),
      volumeCm3: round(vol * extrapolate, 4),
      meanHeightMm: round((10 * hSum) / valid, 3),
      maxHeightMm: round(10 * hMax, 3),
      ...(input.depthSettingsVersion ? { depthSettingsVersion: input.depthSettingsVersion } : {}),
      plateReference: plate.reference,
      flags,
    };
    return { key: b.key, estimate };
  });
  return { estimates, plate, depthValid: true };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
