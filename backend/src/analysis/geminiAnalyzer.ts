/**
 * Analyzer backed by Agent 4's vision module (@scrap/vision).
 *
 * The backend supplies the frozen menu/baseline context and lazy image access
 * (AGENTS.md 4.7, 5.4); vision owns the Gemini prompt, validation, and §7
 * math, and returns explicit needs_review/failed attempts instead of throwing.
 */

import { analyzeCapture, type GeminiGateway } from '@scrap/vision';
import type { Analyzer, AnalyzerInput } from './analyzer.js';
import type { AnalysisResult } from '../types.js';

export class GeminiAnalyzer implements Analyzer {
  constructor(private readonly gateway: GeminiGateway) {}

  get model(): string {
    return this.gateway.model;
  }

  async analyze(input: AnalyzerInput): Promise<AnalysisResult> {
    const { bytes, mimeType } = await input.getImage();
    return analyzeCapture(this.gateway, {
      eventId: input.event.eventId,
      attemptId: input.attemptId,
      image: { kind: 'bytes', bytes, mimeType },
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
