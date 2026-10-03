/**
 * Replay manifest: a JSON file listing capture images with hall/service
 * context, used to run the demo before camera hardware exists (AGENTS.md 3.1)
 * and as replay input for Agent 8.
 *
 * Idempotency contract: `entryId` is the operator-declared identity of one
 * dish passing the camera. Re-running a manifest re-uses each entry's capture
 * event; it never mints a new dish. Two entries with different entryIds are
 * two dishes even if their image bytes are identical (AGENTS.md 3.2).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { QualityFlag } from './contract-types.js';
import { CaptureErrorCodes, captureError } from './errors.js';

/** Flags an operator may declare on a replay entry (subset of QualityFlag). */
export const DECLARABLE_FLAGS = [
  'blurred',
  'no_plate',
  'multiple_dishes',
  'incompatible_geometry',
] as const satisfies readonly QualityFlag[];

export type DeclarableFlag = (typeof DECLARABLE_FLAGS)[number];

export interface ReplayEntry {
  /** Stable, manifest-unique dish identity; the idempotency key. */
  entryId: string;
  /** Image path, relative to the manifest file (or absolute). */
  imagePath: string;
  /** Optional UTC/ISO capture time; defaults to time of first ingestion. */
  capturedAt?: string;
  /** Operator-declared quality flags for this capture. */
  declaredFlags?: DeclarableFlag[];
  plateShape?: 'round' | 'tray' | 'other';
  /** Plate diameter in the normalized 1024x1024 space, when known. */
  plateDiameterPx?: number;
}

export interface ReplayManifest {
  manifestVersion: 1;
  hallId: string;
  serviceId: string;
  entries: ReplayEntry[];
}

/** A manifest whose relative image paths are resolved against its location. */
export interface LoadedManifest extends ReplayManifest {
  /** Directory used to resolve relative imagePath values. */
  baseDir: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

const DECLARABLE = new Set<string>(DECLARABLE_FLAGS);

function invalid(message: string, details: Record<string, unknown>): never {
  throw captureError(CaptureErrorCodes.MANIFEST_INVALID, message, details, false);
}

/** Validate a parsed manifest object. Throws CaptureError (MANIFEST_INVALID). */
export function validateManifest(raw: unknown, source: string): ReplayManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid('The replay manifest must be a JSON object.', { source });
  }
  const m = raw as Record<string, unknown>;
  if (m.manifestVersion !== 1) {
    invalid('The replay manifest must declare "manifestVersion": 1.', {
      source,
      manifestVersion: m.manifestVersion ?? null,
    });
  }
  if (!isNonEmptyString(m.hallId)) invalid('The replay manifest needs a "hallId".', { source });
  if (!isNonEmptyString(m.serviceId)) {
    invalid('The replay manifest needs a "serviceId".', { source });
  }
  if (!Array.isArray(m.entries) || m.entries.length === 0) {
    invalid('The replay manifest needs a non-empty "entries" array.', { source });
  }

  const seen = new Set<string>();
  const entries: ReplayEntry[] = m.entries.map((e, i) => {
    if (typeof e !== 'object' || e === null) {
      invalid(`Entry ${i} must be an object.`, { source, index: i });
    }
    const entry = e as Record<string, unknown>;
    if (!isNonEmptyString(entry.entryId)) {
      invalid(`Entry ${i} needs a stable "entryId".`, { source, index: i });
    }
    if (seen.has(entry.entryId)) {
      invalid(
        `Entry ID "${entry.entryId}" appears more than once; each dish needs its own entryId.`,
        { source, entryId: entry.entryId },
      );
    }
    seen.add(entry.entryId);
    if (!isNonEmptyString(entry.imagePath)) {
      invalid(`Entry "${entry.entryId}" needs an "imagePath".`, { source, entryId: entry.entryId });
    }
    if (entry.capturedAt !== undefined) {
      if (!isNonEmptyString(entry.capturedAt) || Number.isNaN(Date.parse(entry.capturedAt))) {
        invalid(`Entry "${entry.entryId}" has an invalid "capturedAt" timestamp.`, {
          source,
          entryId: entry.entryId,
          capturedAt: entry.capturedAt,
        });
      }
    }
    let declaredFlags: DeclarableFlag[] | undefined;
    if (entry.declaredFlags !== undefined) {
      if (!Array.isArray(entry.declaredFlags)) {
        invalid(`Entry "${entry.entryId}" has a non-array "declaredFlags".`, {
          source,
          entryId: entry.entryId,
        });
      }
      for (const flag of entry.declaredFlags) {
        if (typeof flag !== 'string' || !DECLARABLE.has(flag)) {
          invalid(
            `Entry "${entry.entryId}" declares unknown quality flag "${String(flag)}". ` +
              `Allowed: ${DECLARABLE_FLAGS.join(', ')}.`,
            { source, entryId: entry.entryId, flag: String(flag) },
          );
        }
      }
      declaredFlags = [...new Set(entry.declaredFlags as DeclarableFlag[])];
    }
    if (
      entry.plateShape !== undefined &&
      entry.plateShape !== 'round' &&
      entry.plateShape !== 'tray' &&
      entry.plateShape !== 'other'
    ) {
      invalid(`Entry "${entry.entryId}" has invalid "plateShape".`, {
        source,
        entryId: entry.entryId,
        plateShape: String(entry.plateShape),
      });
    }
    if (
      entry.plateDiameterPx !== undefined &&
      (typeof entry.plateDiameterPx !== 'number' ||
        !Number.isFinite(entry.plateDiameterPx) ||
        entry.plateDiameterPx <= 0)
    ) {
      invalid(`Entry "${entry.entryId}" has invalid "plateDiameterPx" (must be a number > 0).`, {
        source,
        entryId: entry.entryId,
      });
    }
    return {
      entryId: entry.entryId,
      imagePath: entry.imagePath,
      ...(entry.capturedAt !== undefined ? { capturedAt: entry.capturedAt as string } : {}),
      ...(declaredFlags !== undefined ? { declaredFlags } : {}),
      ...(entry.plateShape !== undefined
        ? { plateShape: entry.plateShape as 'round' | 'tray' | 'other' }
        : {}),
      ...(entry.plateDiameterPx !== undefined
        ? { plateDiameterPx: entry.plateDiameterPx as number }
        : {}),
    };
  });

  return {
    manifestVersion: 1,
    hallId: m.hallId,
    serviceId: m.serviceId,
    entries,
  };
}

/** Read + parse + validate a manifest file. Throws CaptureError on failure. */
export async function loadManifest(manifestPath: string): Promise<LoadedManifest> {
  let text: string;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch (err) {
    invalid(`The replay manifest file could not be read: ${manifestPath}`, {
      manifestPath,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    invalid(`The replay manifest is not valid JSON: ${manifestPath}`, {
      manifestPath,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  const manifest = validateManifest(raw, manifestPath);
  return { ...manifest, baseDir: path.dirname(path.resolve(manifestPath)) };
}
