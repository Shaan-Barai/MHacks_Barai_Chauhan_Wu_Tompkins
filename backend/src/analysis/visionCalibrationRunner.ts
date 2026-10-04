/**
 * Live CalibrationRunner: vision's runCalibration (Gemini box → SAM 2.1 mask
 * → N_ref, k, C920s intrinsics, geometric height; DAv2 scale + table plane
 * when the depth worker answers). Retryable failures (Gemini, SAM or other
 * provider errors) throw, so nothing is persisted and the same upload can be
 * retried; final failures (reference not found, invalid mask) become a
 * stored `failed` calibration.
 */

import {
  intrinsicsOverridesFromEnv,
  runCalibration,
  type DepthEstimator,
  type GeminiGateway,
  type Segmenter,
} from '@scrap/vision';
import { HttpError } from '../errors.js';
import type { CalibrationRunInput, CalibrationRunOutput, CalibrationRunner } from './calibrationRunner.js';

export class VisionCalibrationRunner implements CalibrationRunner {
  constructor(
    private readonly gateway: GeminiGateway,
    private readonly sam: Segmenter,
    private readonly depth: DepthEstimator | null,
  ) {}

  async run(input: CalibrationRunInput): Promise<CalibrationRunOutput> {
    const result = await runCalibration({
      imageBytes: input.image.bytes,
      mimeType: input.image.mimeType,
      knownAreaCm2: input.knownAreaCm2,
      referenceLabel: input.referenceLabel,
      gateway: this.gateway,
      sam: this.sam,
      depth: input.withDepth ? this.depth : null,
      intrinsicsOverrides: intrinsicsOverridesFromEnv(),
    });
    if (!result.ok) {
      if (result.error.retryable) throw new HttpError(503, result.error);
      if (!result.intrinsics || !result.widthPx || !result.heightPx) throw new HttpError(422, result.error);
      return {
        status: 'failed',
        widthPx: result.widthPx,
        heightPx: result.heightPx,
        referencePixels: 0,
        cm2PerPx: 0,
        intrinsics: result.intrinsics,
        cameraHeightCmGeometric: 0,
        depth: null,
        flags: result.flags,
        ...(result.overlay ? { overlayJpeg: result.overlay.jpeg } : {}),
        error: result.error,
      };
    }
    const c = result.calibration;
    return {
      status: 'succeeded',
      widthPx: c.widthPx,
      heightPx: c.heightPx,
      referencePixels: c.referencePixels,
      cm2PerPx: c.cm2PerPx,
      intrinsics: c.intrinsics,
      cameraHeightCmGeometric: c.cameraHeightCmGeometric,
      depth: c.depth && result.depthPng ? { ...c.depth, depthPng: result.depthPng } : null,
      flags: c.flags,
      ...(result.overlay ? { overlayJpeg: result.overlay.jpeg } : {}),
      referenceMaskPng: result.referenceMaskPng,
    };
  }
}
