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
import { scanInbox, type InboxIssue } from './inbox.js';

export type BridgeEvent =
  | GroupEvent
  | { kind: 'issue'; issue: InboxIssue }
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

  constructor(private readonly options: InboxBridgeOptions) {}

  async pass(): Promise<PassResult> {
    const { grouper, hallId, serviceId } = this.options;
    const scan = await scanInbox(this.options.inbox, grouper.processedIds());
    for (const issue of scan.issues) {
      const key = `${issue.captureId}:${issue.error.code}`;
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      this.emit({ kind: 'issue', issue });
    }
    let paused = false;
    for (const frame of scan.frames) {
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

  private emit(event: BridgeEvent): void {
    this.options.onEvent?.(event);
  }
}
