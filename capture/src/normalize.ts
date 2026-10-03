/**
 * Normalization to the shared coordinate space `topdown-normalized-v1`.
 *
 * Definition (deterministic; applied identically to observation AND reference
 * images per AGENTS.md 3.3 / §7.3):
 *   1. Decode (JPEG, PNG, or WebP only) and auto-orient using EXIF rotation,
 *      so "up" in the output is the camera's top-down up.
 *   2. Center-crop to the largest centered square:
 *      side = min(width, height); left = floor((w - side) / 2);
 *      top  = floor((h - side) / 2).
 *   3. Resize to exactly 1024 x 1024 with Lanczos3 resampling.
 *   4. Encode as JPEG quality 90.
 *
 * Every event's ImageGeometry is therefore 1024x1024 in
 * 'topdown-normalized-v1'. All pixel areas downstream (Agent 4 estimates,
 * Agent 2 baselines) are measured in this space.
 *
 * Cheap programmatic quality checks happen here too: unreadable files,
 * unsupported formats, and zero/missing dimensions fail with actionable
 * ApiError envelopes instead of being dropped.
 */

import sharp from 'sharp';

import type { ImageGeometry } from './contract-types.js';
import { CaptureErrorCodes, captureError } from './errors.js';

export const NORMALIZED_SIZE_PX = 1024;
export const COORDINATE_SPACE = 'topdown-normalized-v1' as const;
export const NORMALIZED_MIME_TYPE = 'image/jpeg';

const SUPPORTED_INPUT_FORMATS = new Set(['jpeg', 'png', 'webp']);
export const SUPPORTED_INPUT_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export interface NormalizedImage {
  /** JPEG bytes in the normalized coordinate space. */
  bytes: Uint8Array;
  mimeType: typeof NORMALIZED_MIME_TYPE;
  geometry: ImageGeometry;
  /** Decoded source dimensions before cropping (after EXIF orientation). */
  sourceWidthPx: number;
  sourceHeightPx: number;
}

export interface PlateGeometryHints {
  plateShape?: 'round' | 'tray' | 'other';
  /** Plate diameter measured in the normalized 1024x1024 space. */
  plateDiameterPx?: number;
}

/** Throws CaptureError when width/height are missing, zero, or not finite. */
export function assertValidDimensions(
  width: number | undefined,
  height: number | undefined,
  details: Record<string, unknown>,
): asserts width is number {
  const bad = (v: number | undefined) => v === undefined || !Number.isFinite(v) || v <= 0;
  if (bad(width) || bad(height)) {
    throw captureError(
      CaptureErrorCodes.INVALID_IMAGE_DIMENSIONS,
      'This image has no usable width/height and cannot be measured. Re-take or re-export the photo.',
      { ...details, widthPx: width ?? 0, heightPx: height ?? 0 },
      false,
    );
  }
}

export async function normalizeImage(
  input: Uint8Array,
  hints: PlateGeometryHints = {},
  details: Record<string, unknown> = {},
): Promise<NormalizedImage> {
  let image: sharp.Sharp;
  let meta: sharp.Metadata;
  try {
    image = sharp(input, { failOn: 'error' }).rotate(); // EXIF auto-orient
    meta = await image.metadata();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/unsupported image format/i.test(message)) {
      throw captureError(
        CaptureErrorCodes.UNSUPPORTED_IMAGE_TYPE,
        'This file is not a supported image. Use a JPEG, PNG, or WebP photo.',
        { ...details, cause: message },
        false,
      );
    }
    throw captureError(
      CaptureErrorCodes.IMAGE_UNREADABLE,
      'This image file could not be read. It may be corrupted; re-take or re-export the photo.',
      { ...details, cause: message },
      false,
    );
  }

  if (!meta.format || !SUPPORTED_INPUT_FORMATS.has(meta.format)) {
    throw captureError(
      CaptureErrorCodes.UNSUPPORTED_IMAGE_TYPE,
      `Image format "${meta.format ?? 'unknown'}" is not supported. Use a JPEG, PNG, or WebP photo.`,
      { ...details, format: meta.format ?? 'unknown' },
      false,
    );
  }

  // Dimensions after EXIF orientation swap (sharp reports pre-rotate values).
  const orientationSwaps = (meta.orientation ?? 1) >= 5;
  const width = orientationSwaps ? meta.height : meta.width;
  const height = orientationSwaps ? meta.width : meta.height;
  assertValidDimensions(width, height, details);
  const w = width as number;
  const h = height as number;

  const side = Math.min(w, h);
  const left = Math.floor((w - side) / 2);
  const top = Math.floor((h - side) / 2);

  let bytes: Buffer;
  try {
    bytes = await image
      .extract({ left, top, width: side, height: side })
      .resize(NORMALIZED_SIZE_PX, NORMALIZED_SIZE_PX, { kernel: sharp.kernel.lanczos3 })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw captureError(
      CaptureErrorCodes.IMAGE_UNREADABLE,
      'This image file could not be decoded completely. Re-take or re-export the photo.',
      { ...details, cause: message },
      false,
    );
  }

  const geometry: ImageGeometry = {
    widthPx: NORMALIZED_SIZE_PX,
    heightPx: NORMALIZED_SIZE_PX,
    coordinateSpace: COORDINATE_SPACE,
    ...(hints.plateShape !== undefined ? { plateShape: hints.plateShape } : {}),
    ...(hints.plateDiameterPx !== undefined ? { plateDiameterPx: hints.plateDiameterPx } : {}),
  };

  return {
    bytes: new Uint8Array(bytes),
    mimeType: NORMALIZED_MIME_TYPE,
    geometry,
    sourceWidthPx: w,
    sourceHeightPx: h,
  };
}
