/**
 * Uno Q inbox → backend bridge (BRIDGE.md §3).
 *
 * One pass: scan the inbox for new verified frames, group them into dishes
 * in capture order, then ingest every closed dish once through the existing
 * adapter (normalize → R2 upload → finalize → POST /api/captures). A
 * dish-match failure pauses the pass at that frame; nothing after it is
 * processed until the next pass, so frames are never grouped out of order.
 */

import type { ApiError } from './contract-types.js';
import type { CaptureResult, ReplayCaptureAdapter } from './adapter.js';
import type { DishGroup, DishGrouper, GroupEvent } from './dishGrouper.js';
import { scanInbox, type InboxFrame, type InboxIssue } from './inbox.js';

export type BridgeEvent =
  | GroupEvent
  | { kind: 'issue'; issue: InboxIssue }
  /** A calibration frame in the inbox: skipped here, uploaded by `npm run calibrate`. */
  | { kind: 'calibration_frame'; captureId: string }
  /** A camera frame whose focus is not locked, or not locked like the newest calibration frame. */
  | { kind: 'focus_warning'; captureId: string; message: string }
  | { kind: 'paused'; captureId: string; error: ApiError | { message: string } }
  | { kind: 'ingested'; group: DishGroup; result: CaptureResult };

export interface InboxBridgeOptions {
  inbox: string;
  hallId: string;
  serviceId: string;
  grouper: DishGrouper;
  adapter: ReplayCaptureAdapter;
  onEvent?: (event: BridgeEvent) => void;
}

export interface PassResult {
  newFrames: number;
  paused: boolean;
}

export class InboxBridge {
  /** Issues already reported by this process, so --watch does not repeat them. */
  private readonly reported = new Set<string>();
  /** Calibration frames already seen; they are never dishes, so skip re-reading them. */
  private readonly calibrationIds = new Set<string>();
  private calibrationFocus: InboxFrame['focus'] | undefined;
  private focusWarned = false;

  constructor(private readonly options: InboxBridgeOptions) {}

  async pass(): Promise<PassResult> {
    const { grouper, hallId, serviceId } = this.options;
    const skip = new Set([...grouper.processedIds(), ...this.calibrationIds]);
    const scan = await scanInbox(this.options.inbox, skip);
    for (const issue of scan.issues) {
      const key = `${issue.captureId}:${issue.error.code}`;
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      this.emit({ kind: 'issue', issue });
    }
    for (const frame of scan.calibrations) {
      this.calibrationIds.add(frame.captureId);
      this.calibrationFocus = frame.focus ?? this.calibrationFocus;
      this.emit({ kind: 'calibration_frame', captureId: frame.captureId });
    }
    let paused = false;
    for (const frame of scan.frames) {
      this.checkFocus(frame);
      try {
        for (const event of await grouper.process(frame, { hallId, serviceId })) this.emit(event);
      } catch (err) {
        const error =
          err && typeof err === 'object' && 'apiError' in err && (err as { apiError?: ApiError }).apiError
            ? (err as { apiError: ApiError }).apiError
            : { message: err instanceof Error ? err.message : String(err) };
        this.emit({ kind: 'paused', captureId: frame.captureId, error });
        paused = true;
        break;
      }
    }
    await this.ingestClosed();
    return { newFrames: scan.frames.length, paused };
  }

  /** Close the open dish (idle timeout or shutdown) and ingest it. */
  async close(reason: 'idle' | 'flush'): Promise<void> {
    for (const event of this.options.grouper.close(reason)) this.emit(event);
    await this.ingestClosed();
  }

  private async ingestClosed(): Promise<void> {
    const { grouper, adapter } = this.options;
    for (const group of grouper.pendingIngestion()) {
      const rep = grouper.frame(group.representative!)!;
      const result = await adapter.ingestCameraCapture({
        groupId: group.groupId,
        imagePath: rep.photoPath,
        capturedAt: rep.capturedAt,
        hallId: group.hallId,
        serviceId: group.serviceId,
        source: rep.simulated ? 'replay' : 'camera',
      });
      // A failed dish stays 'closed' and is retried with the same eventId next pass.
      if (result.ok) grouper.markIngested(group.groupId, result.event.eventId);
      this.emit({ kind: 'ingested', group, result });
    }
  }

  /**
   * Autofocus changes the focal length, which breaks a calibration (IT_4 I3).
   * Warn once per run; the dish is still ingested (pixels stay valid).
   */
  private checkFocus(frame: InboxFrame): void {
    if (this.focusWarned || frame.simulated || !frame.focus) return;
    let message: string | undefined;
    if (frame.focus.lock !== 'locked') {
      message = `focus is not locked on the camera (${frame.focus.lock}); physical estimates may be off`;
    } else if (
      this.calibrationFocus?.lock === 'locked' &&
      this.calibrationFocus.absolute !== frame.focus.absolute
    ) {
      message =
        `focus_absolute=${frame.focus.absolute} differs from the calibration frame ` +
        `(${this.calibrationFocus.absolute}); recalibrate or use the same --focus-absolute`;
    }
    if (!message) return;
    this.focusWarned = true;
    this.emit({ kind: 'focus_warning', captureId: frame.captureId, message });
  }

  private emit(event: BridgeEvent): void {
    this.options.onEvent?.(event);
  }
}
