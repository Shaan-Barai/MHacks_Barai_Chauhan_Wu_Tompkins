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
import { log } from '../log.js';
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
      ...(input.physical ? { physical: input.physical } : {}),
      ...(input.labelSuffix ? { labelSuffix: input.labelSuffix } : {}),
    });
    const phys = result.physical;
    const loc = result.localization;
    const dish = result.targetDish;
    log.info('vision analysis', {
      eventId: input.event.eventId,
      geminiBoxes: loc.passBoxes.map((n) => n ?? 'failed').join(','),
      mergedBoxes: loc.mergedBoxes,
      ...(loc.failedPasses.length ? { failedPasses: loc.failedPasses.join(',') } : {}),
      targetDish: dish.found ? dish.dishType ?? 'found' : 'not found',
      clip: dish.clipApplied ? `${dish.clippedPx} px` : `none (${dish.clipUnavailableReason ?? 'n/a'})`,
      otherDishBoxes: dish.excludedBoxes,
      otherDishPx: dish.otherDishPx,
      physical: phys.status,
      ...(phys.method ? { physicalMethod: phys.method } : {}),
      ...(phys.reason ? { physicalReason: phys.reason } : {}),
    });
    return result;
  }
}
