/**
 * Analysis seam — the backend's view of Agent 4's Gemini module.
 *
 * Agent 4 owns the Gemini client, prompts, retries, and response validation
 * (AGENTS.md 4.1–4.5). The backend owns WHAT context the analyzer sees:
 * the menu and baseline versions are resolved by the ingestion service and
 * FROZEN into the input (and into AnalysisAttempt.menuVersion /
 * baselineVersions) so later menu or baseline edits never rewrite history.
 *
 * The analyzer receives temporary read access to the image through the
 * storage interface (AGENTS.md 4.7) — never bucket credentials, never bytes
 * through a database payload.
 */

import type { LabelSuffix, PhysicalStageInput } from '@scrap/vision';
import type {
  AnalysisResult,
  CaptureEvent,
  MenuBundle,
  ReferencePortion,
} from '../types.js';

export interface AnalyzerInput {
  event: CaptureEvent;
  /** Pre-assigned so retries of a failed call never mint duplicate IDs mid-attempt. */
  attemptId: string;
  /** The exact menu (id + version) the attempt is measured against. */
  menu: MenuBundle;
  /** Latest compatible baseline per menu item, frozen for this attempt. */
  baselines: ReferencePortion[];
  /** Lazily fetch the image bytes via temporary read access. */
  getImage: () => Promise<{ bytes: Buffer; mimeType: string }>;
  /**
   * IT_4: the hall's active calibration, snapshotted for this attempt
   * (calibrated area = pixels × k).
   */
  physical?: PhysicalStageInput;
  /** IT_4 I8: overlay legend text after each food (grams · kg CO2e · L water). */
  labelSuffix?: LabelSuffix;
}

export interface Analyzer {
  /**
   * Returns a contract-valid AnalysisAttempt plus FoodMeasurement[] —
   * including explicit `needs_review`/`failed` attempts. Must not throw for
   * ordinary analysis failures; throwing means infrastructure failure.
   */
  analyze(input: AnalyzerInput): Promise<AnalysisResult>;
}
