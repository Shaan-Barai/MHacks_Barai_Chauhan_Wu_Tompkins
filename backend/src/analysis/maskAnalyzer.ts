/**
 * Analyzer for the classification -> segmentation -> Pixels wasted pipeline
 * (contracts/measurement.md). Gemini classifies and boxes the leftovers;
 * the SAM 2.1 worker (vision/sam/worker.py) segments them; @scrap/vision
 * validates the masks and counts pixels (only food on the scanned target dish,
 * BIG-PLAN v2 V3) and renders the segmented overlay. There is no plate
 * calibration (v2). The backend stores the returned masks and overlay in
 * object storage (IngestionService).
 */

import { analyzeCaptureWithMasks, type GeminiGateway, type Segmenter } from '@scrap/vision';
import type { Analyzer, AnalyzerInput } from './analyzer.js';
import type { AnalysisResult } from '../types.js';

export class MaskAnalyzer implements Analyzer {
  constructor(
    private readonly gateway: GeminiGateway,
    private readonly segmenter: Segmenter,
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
    });
    const loc = result.localization;
    console.log(
      `[vision] ${input.event.eventId}: Gemini boxes ${loc.passBoxes.map((n, k) => `pass ${k + 1}=${n ?? 'failed'}`).join(', ')}, after merge=${loc.mergedBoxes}` +
        (loc.failedPasses.length ? ` (failed: ${loc.failedPasses.join(', ')})` : ''),
    );
    const dish = result.targetDish;
    console.log(
      `[vision] ${input.event.eventId}: target dish ${dish.found ? dish.dishType ?? 'found' : 'not found'}, ` +
        (dish.clipApplied ? `clipped ${dish.clippedPx} px` : `no clip (${dish.clipUnavailableReason ?? 'n/a'})`) +
        `, other-dish boxes ${dish.excludedBoxes}, other-dish px ${dish.otherDishPx}`,
    );
    return result;
  }
}
