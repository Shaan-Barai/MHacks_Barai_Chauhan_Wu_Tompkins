/**
 * Ingestion seam: after the image is uploaded and finalized, the capture
 * event (metadata + finalized object reference, never bytes) is submitted
 * here. Agent 5's backend owns the real implementation; the in-memory sink
 * is for tests. Submission is idempotent by eventId on the receiving side
 * (AGENTS.md 5.3); the adapter additionally avoids re-submitting entries it
 * already ingested successfully.
 */

import type { CaptureEvent, ScanSubmission } from './contract-types.js';

export interface IngestionSink {
  /** Accept one capture event (plus its scan details). Must be idempotent by event.eventId. */
  submitCaptureEvent(event: CaptureEvent, scan?: ScanSubmission): Promise<void>;
}

export class InMemoryIngestionSink implements IngestionSink {
  private readonly byEventId = new Map<string, CaptureEvent>();
  /** Scan details by eventId, as submitted. */
  readonly scans = new Map<string, ScanSubmission>();
  /** Total submit calls, including idempotent re-submissions (for tests). */
  submissionCount = 0;

  async submitCaptureEvent(event: CaptureEvent, scan?: ScanSubmission): Promise<void> {
    this.submissionCount += 1;
    if (scan) this.scans.set(event.eventId, { ...scan });
    this.byEventId.set(event.eventId, event); // idempotent upsert by eventId
  }

  events(): CaptureEvent[] {
    return [...this.byEventId.values()];
  }

  get(eventId: string): CaptureEvent | undefined {
    return this.byEventId.get(eventId);
  }
}
