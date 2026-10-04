/**
 * Dish grouper for the Uno Q bridge (BRIDGE.md §4): counts each physical
 * dish once.
 *
 * Frames are processed strictly in order. Each one either joins a dish group,
 * is a no-plate frame, or opens a new group:
 *   1. No-AI pre-filter: if the frame barely differs from the previous frame,
 *      it inherits the previous frame's assignment (no Gemini call).
 *   2. Otherwise Gemini compares it with the open group's latest frame (or,
 *      with no open group, the last closed group's, so a plate that reappears
 *      after a flush or gap is not counted again). 'same' and 'unsure' join;
 *      'different' closes the open group and opens a new one.
 *   3. With no group to compare against, the frame is compared with itself,
 *      which only answers "is a plate visible?".
 * A group closes on a 'different' verdict, a no-plate gap of `closeGraceMs`
 * (by frame time), a service change, idle time, or flush. Closed groups are
 * ingested once, using their middle frame as the representative.
 *
 * Every verdict is persisted, so a rerun never asks Gemini again and cannot
 * regroup frames into extra dishes. A matcher error propagates before the
 * frame is recorded: processing pauses there and resumes on the next call.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { DishMatchImage } from './contract-types.js';
import { DEFAULT_PREFILTER_MAD, PREFILTER_VERSION, fingerprint, meanAbsDiff, thumbnail } from './frames.js';
import type { DishMatcher } from './http.js';
import type { InboxFrame } from './inbox.js';

export type CloseReason = 'different' | 'gap' | 'idle' | 'flush' | 'service_change' | 'no_dedupe';

export type FrameVerdict =
  | { by: 'prefilter'; version: string; mad: number; previous: string }
  | {
      by: 'gemini';
      against: string;
      plateVisible: boolean;
      sameDish?: 'same' | 'different' | 'unsure';
      reason: string;
      model: string;
      promptVersion: string;
    }
  | { by: 'no_dedupe' };

export interface FrameRecord {
  serviceId: string;
  capturedAt: string;
  photoPath: string;
  /** Written by simulate-camera rather than the Uno Q (absent = real camera). */
  simulated?: boolean;
  /** Dish group this frame belongs to; null for a no-plate frame. */
  groupId: string | null;
  verdict: FrameVerdict;
}

export interface DishGroup {
  /** The first member's captureId. */
  groupId: string;
  hallId: string;
  serviceId: string;
  /** Plate-visible frames assigned while the group was open, in order. */
  members: string[];
  lastPlateAt: string;
  status: 'open' | 'closed' | 'ingested';
  closedBy?: CloseReason;
  representative?: string;
  /** Frames of this dish seen after it closed; never a new dish. */
  lateMembers: number;
  unsureMerges: number;
  eventId?: string;
}

interface GrouperState {
  version: 1;
  frames: Record<string, FrameRecord>;
  groups: Record<string, DishGroup>;
  openGroupId: string | null;
  lastClosedGroupId: string | null;
  previousFrameId: string | null;
}

export interface DishGrouperOptions {
  matcher: DishMatcher;
  stateFile?: string;
  prefilterMad?: number;
  closeGraceMs?: number;
  /** One dish per manual capture, no Gemini; interval frames are skipped. */
  noDedupe?: boolean;
}

export type GroupEvent =
  | { kind: 'joined'; captureId: string; groupId: string; by: 'prefilter' | 'gemini'; late: boolean }
  | { kind: 'unsure'; captureId: string; groupId: string; reason: string }
  | { kind: 'opened'; captureId: string; groupId: string }
  | { kind: 'no_plate'; captureId: string }
  | { kind: 'skipped'; captureId: string; why: string }
  | { kind: 'closed'; group: DishGroup };

export const DEFAULT_CLOSE_GRACE_MS = 3000;

export class DishGrouper {
  private readonly matcher: DishMatcher;
  private readonly stateFile: string | undefined;
  private readonly prefilterMad: number;
  private readonly closeGraceMs: number;
  private readonly noDedupe: boolean;
  private readonly state: GrouperState;
  /** In-memory caches; recomputed from files after a restart. */
  private readonly fingerprints = new Map<string, Uint8Array>();
  private readonly thumbnails = new Map<string, DishMatchImage>();
  /** Gemini calls made by this process (for reporting). */
  matchCalls = 0;

  constructor(options: DishGrouperOptions) {
    this.matcher = options.matcher;
    this.stateFile = options.stateFile;
    this.prefilterMad = options.prefilterMad ?? DEFAULT_PREFILTER_MAD;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.noDedupe = options.noDedupe ?? false;
    this.state =
      this.stateFile && existsSync(this.stateFile)
        ? (JSON.parse(readFileSync(this.stateFile, 'utf8')) as GrouperState)
        : { version: 1, frames: {}, groups: {}, openGroupId: null, lastClosedGroupId: null, previousFrameId: null };
  }

  processedIds(): ReadonlySet<string> {
    return new Set(Object.keys(this.state.frames));
  }

  groups(): DishGroup[] {
    return Object.values(this.state.groups);
  }

  frame(captureId: string): FrameRecord | undefined {
    return this.state.frames[captureId];
  }

  /** Closed groups waiting for ingestion. */
  pendingIngestion(): DishGroup[] {
    return this.groups().filter((g) => g.status === 'closed');
  }

  markIngested(groupId: string, eventId: string): void {
    const group = this.state.groups[groupId];
    if (!group) throw new Error(`Unknown dish group ${groupId}`);
    group.status = 'ingested';
    group.eventId = eventId;
    this.save();
  }

  /** Close the open group (idle timeout or shutdown). */
  close(reason: 'idle' | 'flush'): GroupEvent[] {
    const events: GroupEvent[] = [];
    this.closeOpen(reason, events);
    this.save();
    return events;
  }

  async process(frame: InboxFrame, context: { hallId: string; serviceId: string }): Promise<GroupEvent[]> {
    if (this.state.frames[frame.captureId]) return [];
    const events: GroupEvent[] = [];
    const open = this.openGroup();
    if (open && open.serviceId !== context.serviceId) this.closeOpen('service_change', events);

    if (this.noDedupe) {
      if (frame.trigger === 'interval') {
        // Not recorded: a later run with dedupe on can still group it.
        return [{ kind: 'skipped', captureId: frame.captureId, why: 'interval frame (dish identity unresolved)' }];
      }
      this.record(frame, context.serviceId, frame.captureId, { by: 'no_dedupe' });
      this.openNew(frame, context, events);
      this.closeOpen('no_dedupe', events);
      this.save();
      return events;
    }

    // 1. Pre-filter against the previous frame of the same service.
    const previousId = this.state.previousFrameId;
    const previous = previousId ? this.state.frames[previousId] : undefined;
    if (previousId && previous && previous.serviceId === context.serviceId) {
      const mad = meanAbsDiff(await this.fingerprint(frame.captureId, frame.photoPath), await this.fingerprint(previousId, previous.photoPath));
      if (mad < this.prefilterMad) {
        const verdict: FrameVerdict = { by: 'prefilter', version: PREFILTER_VERSION, mad, previous: previousId };
        const group = previous.groupId ? this.state.groups[previous.groupId] : undefined;
        if (group) this.join(group, frame, verdict, 'prefilter', events);
        else this.noPlate(frame, context.serviceId, verdict, events);
        this.save();
        return events;
      }
    }

    // 2./3. Gemini against the open group, else the last closed group, else itself.
    const target = this.openGroup() ?? this.lastClosed(context.serviceId);
    const againstId = target ? target.members[target.members.length - 1]! : frame.captureId;
    const againstPath = target ? this.state.frames[againstId]!.photoPath : frame.photoPath;
    const [reference, candidate] = await Promise.all([
      this.thumbnail(againstId, againstPath),
      this.thumbnail(frame.captureId, frame.photoPath),
    ]);
    this.matchCalls++;
    const result = await this.matcher.match({ reference, candidate }); // throws => pause here
    const verdict: FrameVerdict = {
      by: 'gemini',
      against: againstId,
      plateVisible: result.plateVisible,
      ...(result.plateVisible ? { sameDish: result.sameDish } : {}),
      reason: result.reason,
      model: result.model,
      promptVersion: result.promptVersion,
    };

    if (!result.plateVisible) {
      this.noPlate(frame, context.serviceId, verdict, events);
    } else if (!target) {
      this.record(frame, context.serviceId, frame.captureId, verdict);
      this.openNew(frame, context, events);
    } else if (result.sameDish === 'different') {
      this.closeOpen('different', events);
      this.record(frame, context.serviceId, frame.captureId, verdict);
      this.openNew(frame, context, events);
    } else {
      if (result.sameDish === 'unsure') {
        target.unsureMerges++;
        events.push({ kind: 'unsure', captureId: frame.captureId, groupId: target.groupId, reason: result.reason });
      }
      this.join(target, frame, verdict, 'gemini', events);
    }
    this.save();
    return events;
  }

  private openGroup(): DishGroup | undefined {
    return this.state.openGroupId ? this.state.groups[this.state.openGroupId] : undefined;
  }

  private lastClosed(serviceId: string): DishGroup | undefined {
    const group = this.state.lastClosedGroupId ? this.state.groups[this.state.lastClosedGroupId] : undefined;
    return group?.serviceId === serviceId ? group : undefined;
  }

  private record(frame: InboxFrame, serviceId: string, groupId: string | null, verdict: FrameVerdict): void {
    this.state.frames[frame.captureId] = {
      serviceId,
      capturedAt: frame.capturedAt,
      photoPath: frame.photoPath,
      ...(frame.simulated ? { simulated: true } : {}),
      groupId,
      verdict,
    };
    this.state.previousFrameId = frame.captureId;
  }

  private join(
    group: DishGroup,
    frame: InboxFrame,
    verdict: FrameVerdict,
    by: 'prefilter' | 'gemini',
    events: GroupEvent[],
  ): void {
    this.record(frame, group.serviceId, group.groupId, verdict);
    const late = group.status !== 'open';
    if (late) {
      group.lateMembers++;
    } else {
      group.members.push(frame.captureId);
      group.lastPlateAt = frame.capturedAt;
    }
    events.push({ kind: 'joined', captureId: frame.captureId, groupId: group.groupId, by, late });
  }

  private noPlate(frame: InboxFrame, serviceId: string, verdict: FrameVerdict, events: GroupEvent[]): void {
    this.record(frame, serviceId, null, verdict);
    events.push({ kind: 'no_plate', captureId: frame.captureId });
    const open = this.openGroup();
    if (open && Date.parse(frame.capturedAt) - Date.parse(open.lastPlateAt) >= this.closeGraceMs) {
      this.closeOpen('gap', events);
    }
  }

  private openNew(frame: InboxFrame, context: { hallId: string; serviceId: string }, events: GroupEvent[]): void {
    this.state.groups[frame.captureId] = {
      groupId: frame.captureId,
      hallId: context.hallId,
      serviceId: context.serviceId,
      members: [frame.captureId],
      lastPlateAt: frame.capturedAt,
      status: 'open',
      lateMembers: 0,
      unsureMerges: 0,
    };
    this.state.openGroupId = frame.captureId;
    events.push({ kind: 'opened', captureId: frame.captureId, groupId: frame.captureId });
  }

  private closeOpen(reason: CloseReason, events: GroupEvent[]): void {
    const open = this.openGroup();
    if (!open) return;
    open.status = 'closed';
    open.closedBy = reason;
    open.representative = open.members[Math.floor((open.members.length - 1) / 2)]!;
    this.state.openGroupId = null;
    this.state.lastClosedGroupId = open.groupId;
    events.push({ kind: 'closed', group: open });
  }

  private async fingerprint(captureId: string, photoPath: string): Promise<Uint8Array> {
    let fp = this.fingerprints.get(captureId);
    if (!fp) {
      fp = await fingerprint(await readFile(photoPath));
      this.fingerprints.set(captureId, fp);
      if (this.fingerprints.size > 8) this.fingerprints.delete(this.fingerprints.keys().next().value!);
    }
    return fp;
  }

  private async thumbnail(captureId: string, photoPath: string): Promise<DishMatchImage> {
    let thumb = this.thumbnails.get(captureId);
    if (!thumb) {
      thumb = await thumbnail(await readFile(photoPath));
      this.thumbnails.set(captureId, thumb);
      if (this.thumbnails.size > 4) this.thumbnails.delete(this.thumbnails.keys().next().value!);
    }
    return thumb;
  }

  private save(): void {
    if (!this.stateFile) return;
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.stateFile);
  }
}
