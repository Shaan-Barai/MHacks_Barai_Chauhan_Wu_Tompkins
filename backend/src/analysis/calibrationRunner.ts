/**
 * Calibration seam (IT_4 I2/I3): the backend's view of vision's
 * `runCalibration` (vision/src/calibration.ts). Vision owns the Gemini box of
 * the reference object, the SAM mask, N_ref, k, the C920s intrinsics, the
 * geometric height, the Depth Anything V2 scale + table plane and the overlay
 * JPEG. The backend owns storage (overlay/mask/depth PNGs → object storage)
 * and persistence (camera_calibration). Tests inject a fake runner.
 */

import type { ApiError, CalibrationDepth, CameraCalibrationFlag, CameraIntrinsics } from '../types.js';

export interface CalibrationRunInput {
  image: { bytes: Buffer; mimeType: string };
  knownAreaCm2: number;
  referenceLabel: string;
  /** Try Depth Anything V2 (the runner flags depth_unavailable when the worker is down). */
  withDepth: boolean;
}

export interface CalibrationRunOutput {
  status: 'succeeded' | 'failed';
  widthPx: number;
  heightPx: number;
  /** N_ref: integer foreground pixels of the reference mask (0 when failed). */
  referencePixels: number;
  /** k = knownAreaCm2 / referencePixels (0 when failed). */
  cm2PerPx: number;
  intrinsics: CameraIntrinsics;
  cameraHeightCmGeometric: number;
  /** Depth calibration without its storage id; the backend stores depthPng and fills depthObjectId. */
  depth: (Omit<CalibrationDepth, 'depthObjectId'> & { depthPng: Uint8Array }) | null;
  flags: CameraCalibrationFlag[];
  /** Reference outline drawn on the photo. */
  overlayJpeg?: Uint8Array;
  /** Binary reference mask (255 = reference). */
  referenceMaskPng?: Uint8Array;
  error?: ApiError;
}

export interface CalibrationRunner {
  /** Ordinary "reference not found" outcomes return status 'failed'; throwing means infrastructure failure. */
  run(input: CalibrationRunInput): Promise<CalibrationRunOutput>;
}
