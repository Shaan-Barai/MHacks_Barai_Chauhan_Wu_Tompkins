/**
 * Deterministic mock implementation of the Analyzer seam, used for tests and
 * offline runs (no GEMINI_API_KEY). It mimics the mask pipeline's output
 * shape: fixture `remainingAreaPx` values are integer Pixels wasted, the
 * capture union is their sum (no overlaps), and the segmentation result is
 * labeled 'mock-segmenter' so it is never mistaken for a real SAM run. Each
 * measurement gets a synthetic exclusive mask (its first N free pixels) so
 * maskCount provenance is exercised end to end.
 *
 * Determinism: results come either from a fixture map keyed by eventId, or —
 * when no fixture matches — from a stable default (25% remaining of the first
 * menu item that has a baseline). Same input, same output, no network.
 */

import { encodeBinaryMask } from '@scrap/vision';
import { apiError } from '../errors.js';
import type { Analyzer, AnalyzerInput } from './analyzer.js';
import type {
  AnalysisResult,
  AnalysisStatus,
  CountStatus,
  FoodMeasurement,
  PlateCalibration,
  QualityFlag,
  SegmentationResult,
} from '../types.js';

export interface MockMeasurementSpec {
  /** null = unknown/non-menu food. */
  itemId: string | null;
  remainingAreaPx: number;
  qualityFlags?: QualityFlag[];
}

export interface MockFixture {
  status?: AnalysisStatus;
  measurements?: MockMeasurementSpec[];
  qualityFlags?: QualityFlag[];
  errorCode?: string;
  /** Plate calibration to report on the attempt (BIG-PLAN D2); none by default. */
  calibration?: PlateCalibration;
  /** Overlay JPEG to return (D7); none by default. */
  overlay?: AnalysisResult['overlay'];
}

export class MockAnalyzer implements Analyzer {
  constructor(
    private readonly fixtures: Record<string, MockFixture> = {},
    private readonly model = 'mock-analyzer',
    private readonly promptVersion = 'mock-v1',
  ) {}

  async analyze(input: AnalyzerInput): Promise<AnalysisResult> {
    const { event, attemptId, menu, baselines } = input;
    const fixture = this.fixtures[event.eventId];
    const baselineByItem = new Map(baselines.map((b) => [b.itemId, b]));

    const status: AnalysisStatus = fixture?.status ?? 'succeeded';
    const specs: MockMeasurementSpec[] =
      fixture?.measurements ??
      (status === 'succeeded' ? this.defaultSpecs(baselines) : []);

    const measurements: FoodMeasurement[] =
      status === 'failed'
        ? []
        : specs.map((spec, i) => {
            const baseline = spec.itemId !== null ? baselineByItem.get(spec.itemId) : undefined;
            const flags: QualityFlag[] = ['ai_estimate', ...(spec.qualityFlags ?? [])];
            const m: FoodMeasurement = {
              measurementId: `meas_${attemptId}_${i + 1}`,
              eventId: event.eventId,
              attemptId,
              itemId: spec.itemId,
              remainingAreaPx: Math.round(spec.remainingAreaPx),
              method: 'mask_pixel_count',
              qualityFlags: flags,
            };
            if (baseline && Number.isFinite(baseline.expectedAreaPx) && baseline.expectedAreaPx > 0) {
              m.baselineId = baseline.baselineId;
              m.baselineAreaPx = baseline.expectedAreaPx;
              m.rawWasteFraction = spec.remainingAreaPx / baseline.expectedAreaPx;
              m.displayWastePercent = 100 * Math.min(Math.max(m.rawWasteFraction, 0), 1);
              if (m.rawWasteFraction > 1 && !flags.includes('above_baseline')) {
                flags.push('above_baseline');
              }
            } else if (spec.itemId === null) {
              m.unavailableReason = 'unknown_item_no_menu_match';
            } else {
              m.unavailableReason = 'missing_baseline';
              if (!flags.includes('missing_baseline')) flags.push('missing_baseline');
            }
            return m;
          });

    return {
      attempt: {
        eventId: event.eventId,
        attemptId,
        menuId: menu.service.menuId,
        menuVersion: menu.service.menuVersion,
        baselineVersions: Object.fromEntries(
          baselines.map((b) => [b.itemId, b.baselineVersion]),
        ),
        model: this.model,
        promptVersion: this.promptVersion,
        status,
        ...(status === 'failed'
          ? {
              error: apiError(
                fixture?.errorCode ?? 'ANALYSIS_FAILED',
                'The image could not be analyzed.',
                true,
              ),
            }
          : {}),
        qualityFlags: ['ai_estimate', ...(fixture?.qualityFlags ?? [])],
        createdAt: new Date().toISOString(),
        segmentation: this.segmentation(event.geometry, status, measurements),
        ...(fixture?.calibration ? { calibration: structuredClone(fixture.calibration) } : {}),
      },
      measurements,
      itemMasks: this.itemMasks(input, measurements),
      ...(fixture?.overlay !== undefined ? { overlay: fixture.overlay } : {}),
    };
  }

  private itemMasks(input: AnalyzerInput, measurements: FoodMeasurement[]): NonNullable<AnalysisResult['itemMasks']> {
    const { widthPx: W, heightPx: H } = input.event.geometry;
    let offset = 0;
    return measurements.map((m) => {
      const bitmap = new Uint8Array(W * H);
      bitmap.fill(1, offset, Math.min(W * H, offset + m.remainingAreaPx));
      offset += m.remainingAreaPx;
      return {
        measurementId: m.measurementId,
        png: encodeBinaryMask(bitmap, W, H),
        count: {
          pixelsWasted: m.remainingAreaPx,
          geometry: input.event.geometry,
          menuId: input.menu.service.menuId,
          menuVersion: input.menu.service.menuVersion,
          classificationVersion: `${this.model}/${this.promptVersion}`,
          segmentationVersion: 'mock-segmenter/mock/mock-v1',
          processingVersion: 'smallest-first-v1',
          assignment: 'exclusive',
          validated: true,
        },
      };
    });
  }

  private segmentation(
    geometry: AnalyzerInput['event']['geometry'],
    status: AnalysisStatus,
    measurements: FoodMeasurement[],
  ): SegmentationResult {
    const total = measurements.reduce((sum, m) => sum + m.remainingAreaPx, 0);
    const countStatus: CountStatus =
      status === 'failed' ? 'unavailable' : status === 'needs_review' ? 'partial' : measurements.length === 0 ? 'empty' : 'complete';
    return {
      model: 'mock-segmenter',
      checkpoint: 'mock',
      codeRevision: 'mock',
      promptSource: 'gemini_box',
      settingsVersion: 'mock-v1',
      countingRuleVersion: 'smallest-first-v1',
      status: status === 'failed' ? 'failed' : status === 'needs_review' ? 'partial' : measurements.length === 0 ? 'skipped' : 'succeeded',
      countStatus,
      ...(countStatus === 'unavailable' ? {} : { capturePixelsWasted: total }),
      widthPx: geometry.widthPx,
      heightPx: geometry.heightPx,
      regions: [],
    };
  }

  private defaultSpecs(baselines: AnalyzerInput['baselines']): MockMeasurementSpec[] {
    const first = baselines[0];
    if (!first) return [];
    return [{ itemId: first.itemId, remainingAreaPx: Math.round(first.expectedAreaPx * 0.25) }];
  }
}
