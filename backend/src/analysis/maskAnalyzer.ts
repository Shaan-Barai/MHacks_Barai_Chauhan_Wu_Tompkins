/**
 * Analyzer for the classification -> segmentation -> Pixels wasted pipeline
 * (contracts/measurement.md). Gemini classifies and boxes the leftovers;
 * the SAM 2.1 worker (vision/sam/worker.py) segments them; @scrap/vision
 * validates the masks and counts pixels, fits the plate rim for the
 * cm²/px calibration, and renders the segmented overlay. The backend stores
 * the returned masks and overlay in object storage (IngestionService).
 */

import { analyzeCaptureWithMasks, type GeminiGateway, type Segmenter } from '@scrap/vision';
import type { Analyzer, AnalyzerInput } from './analyzer.js';
import type { AnalysisResult } from '../types.js';

export class MaskAnalyzer implements Analyzer {
  constructor(
    private readonly gateway: GeminiGateway,
    private readonly segmenter: Segmenter,
    /** PLATE_DIAMETER_PX: fallback for the configured-default calibration (BIG-PLAN D2). */
    private readonly options: { plateDiameterPx?: number } = {},
  ) {}

  async analyze(input: AnalyzerInput): Promise<AnalysisResult> {
    const { bytes, mimeType } = await input.getImage();
    const result = await analyzeCaptureWithMasks(this.gateway, this.segmenter, {
      eventId: input.event.eventId,
      attemptId: input.attemptId,
      image: { bytes, mimeType },
      geometry: input.event.geometry,
      menu: {
        menuId: input.menu.service.menuId,
        menuVersion: input.menu.service.menuVersion,
        items: input.menu.items,
      },
      baselines: input.baselines,
      ...(this.options.plateDiameterPx !== undefined
        ? { calibration: { defaultPlateDiameterPx: this.options.plateDiameterPx } }
        : {}),
    });
    const loc = result.localization;
    console.log(
      `[vision] ${input.event.eventId}: Gemini boxes ${loc.passBoxes.map((n, k) => `pass ${k + 1}=${n ?? 'failed'}`).join(', ')}, after merge=${loc.mergedBoxes}` +
        (loc.failedPasses.length ? ` (failed: ${loc.failedPasses.join(', ')})` : ''),
    );
    return result;
  }
}
