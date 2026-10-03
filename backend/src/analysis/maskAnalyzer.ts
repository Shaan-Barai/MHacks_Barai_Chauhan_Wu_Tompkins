/**
 * Analyzer for the classification -> segmentation -> Pixels wasted pipeline
 * (contracts/measurement.md). Gemini classifies and boxes the leftovers;
 * the SAM 2.1 worker (vision/sam/worker.py) segments them; @scrap/vision
 * validates the masks and counts pixels. The backend stores the returned
 * masks in object storage (IngestionService).
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
    return analyzeCaptureWithMasks(this.gateway, this.segmenter, {
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
  }
}
