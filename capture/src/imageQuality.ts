/**
 * Cheap checks that a camera photo is usable before it is analyzed:
 * a valid JPEG of the expected size that is not black and not blurry.
 *
 * - brightness: mean luminance (0-255) of the image.
 * - sharpness: variance of a Laplacian-filtered grayscale copy (higher =
 *   more edges). Computed on a 512 px-wide copy so the number does not
 *   depend on the camera resolution.
 * The thresholds are provisional and can be tuned from real C920 frames.
 */

import sharp from 'sharp';

export const MIN_BRIGHTNESS = 25;
export const MIN_SHARPNESS = 15;

export interface ImageQuality {
  format: string;
  widthPx: number;
  heightPx: number;
  brightness: number;
  sharpness: number;
}

export interface QualityVerdict {
  ok: boolean;
  problems: string[];
  quality: ImageQuality;
}

export async function measureImageQuality(bytes: Uint8Array): Promise<ImageQuality> {
  const meta = await sharp(bytes).metadata();
  const { data, info } = await sharp(bytes).rotate().resize({ width: 512 }).grayscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let total = 0;
  for (let i = 0; i < data.length; i++) total += data[i]!;
  // Variance of the 4-neighbour Laplacian over the interior pixels.
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = data[i - 1]! + data[i + 1]! + data[i - width]! + data[i + width]! - 4 * data[i]!;
      sum += v;
      sq += v * v;
      n++;
    }
  }
  const mean = n > 0 ? sum / n : 0;
  return {
    format: meta.format ?? 'unknown',
    widthPx: meta.width ?? 0,
    heightPx: meta.height ?? 0,
    brightness: data.length > 0 ? total / data.length : 0,
    sharpness: n > 0 ? sq / n - mean * mean : 0,
  };
}

export async function checkCameraPhoto(
  bytes: Uint8Array,
  expected: { widthPx: number; heightPx: number },
  thresholds: { minBrightness?: number; minSharpness?: number } = {},
): Promise<QualityVerdict> {
  const problems: string[] = [];
  const soi = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!soi) problems.push('not a JPEG (no start-of-image marker)');
  let quality: ImageQuality;
  try {
    quality = await measureImageQuality(bytes);
  } catch (err) {
    return {
      ok: false,
      problems: [...problems, `cannot be decoded: ${err instanceof Error ? err.message : String(err)}`],
      quality: { format: 'unknown', widthPx: 0, heightPx: 0, brightness: 0, sharpness: 0 },
    };
  }
  if (quality.format !== 'jpeg') problems.push(`format is ${quality.format}, not jpeg`);
  if (quality.widthPx !== expected.widthPx || quality.heightPx !== expected.heightPx) {
    problems.push(`size is ${quality.widthPx}x${quality.heightPx}, expected ${expected.widthPx}x${expected.heightPx}`);
  }
  const minBrightness = thresholds.minBrightness ?? MIN_BRIGHTNESS;
  const minSharpness = thresholds.minSharpness ?? MIN_SHARPNESS;
  if (quality.brightness < minBrightness) {
    problems.push(`too dark (brightness ${quality.brightness.toFixed(1)} < ${minBrightness}): lens cap or privacy shutter closed, or no light`);
  }
  if (quality.sharpness < minSharpness) {
    problems.push(`blurry (sharpness ${quality.sharpness.toFixed(1)} < ${minSharpness}): check focus and camera height`);
  }
  return { ok: problems.length === 0, problems, quality };
}
