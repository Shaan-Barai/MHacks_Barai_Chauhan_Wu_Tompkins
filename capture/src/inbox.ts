/**
 * Uno Q inbox reader (BRIDGE.md §5, §7).
 *
 * `laptop_capture.py` publishes each capture atomically as
 * `<inbox>/<captureId>/photo.jpg` + `metadata.json` (protocol v1). This
 * module lists complete captures, re-verifies each photo's length and
 * SHA-256 against its metadata, and reports everything else as an issue
 * instead of dropping it. The inbox is read-only: nothing is moved or deleted.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ApiError } from './contract-types.js';

export interface InboxFrame {
  captureId: string;
  /** Board frame-received time, UTC ISO 8601. */
  capturedAt: string;
  photoPath: string;
  /** 'interval' frames come from `--auto`; 'manual' from Enter / `--once`. */
  trigger: 'manual' | 'interval';
}

export interface InboxIssue {
  captureId: string;
  error: ApiError;
}

export interface InboxScan {
  /** Verified frames in capture order (capturedAt, then captureId). */
  frames: InboxFrame[];
  issues: InboxIssue[];
}

interface UnoQMetadata {
  protocolVersion?: unknown;
  captureId?: unknown;
  capturedAt?: unknown;
  byteLength?: unknown;
  sha256?: unknown;
  triggerSource?: unknown;
}

function issue(captureId: string, code: string, message: string, retryable: boolean): InboxIssue {
  return { captureId, error: { code, message, details: { captureId }, retryable } };
}

async function readFrame(inbox: string, name: string): Promise<InboxFrame | InboxIssue> {
  const dir = path.join(inbox, name);
  let metadata: UnoQMetadata;
  try {
    metadata = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8')) as UnoQMetadata;
  } catch {
    return issue(name, 'INBOX_INCOMPLETE', 'This capture has no readable metadata.json yet.', true);
  }
  if (metadata.protocolVersion !== 1 || metadata.captureId !== name) {
    return issue(name, 'INBOX_METADATA_INVALID', 'metadata.json is not protocol v1 for this capture folder.', false);
  }
  const capturedAt = typeof metadata.capturedAt === 'string' ? Date.parse(metadata.capturedAt) : NaN;
  if (!Number.isFinite(capturedAt)) {
    return issue(name, 'INBOX_METADATA_INVALID', 'metadata.json has no valid capturedAt time.', false);
  }
  let photo: Buffer;
  try {
    photo = await readFile(path.join(dir, 'photo.jpg'));
  } catch {
    return issue(name, 'INBOX_INCOMPLETE', 'This capture has no readable photo.jpg yet.', true);
  }
  const sha256 = createHash('sha256').update(photo).digest('hex');
  if (photo.byteLength !== metadata.byteLength || sha256 !== metadata.sha256) {
    return issue(
      name,
      'CHECKSUM_MISMATCH',
      'photo.jpg does not match the length/checksum recorded by the camera. Re-capture this dish.',
      false,
    );
  }
  return {
    captureId: name,
    capturedAt: new Date(capturedAt).toISOString(),
    photoPath: path.join(dir, 'photo.jpg'),
    trigger: metadata.triggerSource === 'interval' ? 'interval' : 'manual',
  };
}

/** List complete, verified captures. `skip` avoids re-reading known IDs. */
export async function scanInbox(inbox: string, skip: ReadonlySet<string> = new Set()): Promise<InboxScan> {
  const names = (await readdir(inbox)).filter((n) => !n.startsWith('.') && !skip.has(n));
  const frames: InboxFrame[] = [];
  const issues: InboxIssue[] = [];
  for (const name of names) {
    if (!(await stat(path.join(inbox, name))).isDirectory()) continue;
    const result = await readFrame(inbox, name);
    if ('error' in result) issues.push(result);
    else frames.push(result);
  }
  frames.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.captureId.localeCompare(b.captureId));
  return { frames, issues };
}
