/**
 * Replay / file-upload capture adapter (Agent 3).
 *
 * Produces exactly one CaptureEvent per dish:
 *  - replay manifests: `entryId` declares dish identity; re-running the same
 *    entry re-uses its minted eventId and capturedAt, and an entry that
 *    already ingested successfully is returned from the registry without a
 *    second upload or submission.
 *  - manual uploads: each call with a new (or no) entryId is a new dish;
 *    passing the same entryId again retries the same dish.
 *
 * Event IDs are ULIDs minted at capture time — never derived from image
 * bytes, because identical bytes do not prove the same dish and retries of
 * one dish may produce different bytes (AGENTS.md 3.2).
 *
 * The adapter normalizes each image to `topdown-normalized-v1` (see
 * normalize.ts), uploads the normalized bytes through the Uploader seam
 * (Agent 5's two-step flow), then submits capture metadata plus the
 * finalized object reference to the IngestionSink. Image bytes never go to
 * ingestion or any database payload.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ApiError, CaptureEvent, QualityFlag } from './contract-types.js';
import { CaptureError, CaptureErrorCodes, captureError, toApiError } from './errors.js';
import type { IngestionSink } from './ingestion.js';
import { type IdFactory, newId } from './ids.js';
import {
  type DeclarableFlag,
  type LoadedManifest,
  type ReplayEntry,
  loadManifest,
} from './manifest.js';
import { SUPPORTED_INPUT_EXTENSIONS, normalizeImage } from './normalize.js';
import type { Uploader } from './uploader.js';

export type CaptureResult =
  | {
      ok: true;
      entryId: string;
      event: CaptureEvent;
      imageObjectId: string;
      /** True when this entry was already ingested and no new work was done. */
      alreadyIngested: boolean;
    }
  | {
      ok: false;
      entryId: string;
      error: ApiError;
    };

export interface ManualUploadOptions {
  imagePath: string;
  hallId: string;
  serviceId: string;
  /**
   * Stable retry key for this dish. Omitting it means "this call is a new
   * dish": a second call without an entryId mints a second capture event.
   */
  entryId?: string;
  capturedAt?: string;
  declaredFlags?: DeclarableFlag[];
  plateShape?: 'round' | 'tray' | 'other';
  plateDiameterPx?: number;
}

interface MintedIdentity {
  eventId: string;
  capturedAt: string;
}

export interface CaptureAdapterOptions {
  /** Injectable clock for tests; must return a Date. */
  clock?: () => Date;
  /** Injectable ID factory for tests. */
  idFactory?: IdFactory;
  /**
   * Optional JSON file that keeps the identity registry across processes, so
   * re-running a replay (e.g. the CLI) reuses the same eventIds instead of
   * minting new dishes. Without it the registry lives only in memory.
   */
  stateFile?: string;
}

interface RegistrySnapshot {
  minted: Record<string, MintedIdentity>;
  completed: Record<string, { event: CaptureEvent; imageObjectId: string }>;
}

export class ReplayCaptureAdapter {
  private readonly uploader: Uploader;
  private readonly sink: IngestionSink;
  private readonly clock: () => Date;
  private readonly idFactory: IdFactory;
  private readonly stateFile: string | undefined;

  /**
   * Identity registry: once an entry key has minted an eventId/capturedAt,
   * every retry re-uses them (stable IDs across retries).
   */
  private readonly minted = new Map<string, MintedIdentity>();
  /** Entries that completed ingestion; replays return these without re-work. */
  private readonly completed = new Map<
    string,
    { event: CaptureEvent; imageObjectId: string }
  >();

  constructor(uploader: Uploader, sink: IngestionSink, options: CaptureAdapterOptions = {}) {
    this.uploader = uploader;
    this.sink = sink;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? newId;
    this.stateFile = options.stateFile;
    if (this.stateFile && existsSync(this.stateFile)) {
      const snapshot = JSON.parse(readFileSync(this.stateFile, 'utf8')) as RegistrySnapshot;
      for (const [k, v] of Object.entries(snapshot.minted ?? {})) this.minted.set(k, v);
      for (const [k, v] of Object.entries(snapshot.completed ?? {})) this.completed.set(k, v);
    }
  }

  private saveState(): void {
    if (!this.stateFile) return;
    const snapshot: RegistrySnapshot = {
      minted: Object.fromEntries(this.minted),
      completed: Object.fromEntries(this.completed),
    };
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    renameSync(tmp, this.stateFile);
  }

  /**
   * Ingest every entry of a replay manifest file. Per-entry failures are
   * reported as error results (never thrown, never dropped); a structurally
   * invalid manifest throws CaptureError with code MANIFEST_INVALID.
   */
  async ingestManifestFile(manifestPath: string): Promise<CaptureResult[]> {
    const manifest = await loadManifest(manifestPath);
    return this.ingestManifest(manifest);
  }

  /** Ingest an already-loaded manifest (source label: 'replay'). */
  async ingestManifest(manifest: LoadedManifest): Promise<CaptureResult[]> {
    const results: CaptureResult[] = [];
    for (const entry of manifest.entries) {
      results.push(
        await this.ingestEntry({
          source: 'replay',
          key: `replay:${manifest.serviceId}:${entry.entryId}`,
          hallId: manifest.hallId,
          serviceId: manifest.serviceId,
          entry,
          baseDir: manifest.baseDir,
        }),
      );
    }
    return results;
  }

  /** Ingest one operator-uploaded file (source label: 'manual_upload'). */
  async ingestFile(options: ManualUploadOptions): Promise<CaptureResult> {
    const entryId = options.entryId ?? this.idFactory('man');
    const entry: ReplayEntry = {
      entryId,
      imagePath: options.imagePath,
      ...(options.capturedAt !== undefined ? { capturedAt: options.capturedAt } : {}),
      ...(options.declaredFlags !== undefined ? { declaredFlags: options.declaredFlags } : {}),
      ...(options.plateShape !== undefined ? { plateShape: options.plateShape } : {}),
      ...(options.plateDiameterPx !== undefined
        ? { plateDiameterPx: options.plateDiameterPx }
        : {}),
    };
    return this.ingestEntry({
      source: 'manual_upload',
      key: `manual_upload:${options.serviceId}:${entryId}`,
      hallId: options.hallId,
      serviceId: options.serviceId,
      entry,
      baseDir: process.cwd(),
    });
  }

  private async ingestEntry(args: {
    source: 'replay' | 'manual_upload';
    key: string;
    hallId: string;
    serviceId: string;
    entry: ReplayEntry;
    baseDir: string;
  }): Promise<CaptureResult> {
    const { source, key, hallId, serviceId, entry } = args;

    // Exactly-once: a successfully ingested entry is never re-uploaded or
    // re-submitted; it returns its original event.
    const done = this.completed.get(key);
    if (done) {
      return {
        ok: true,
        entryId: entry.entryId,
        event: done.event,
        imageObjectId: done.imageObjectId,
        alreadyIngested: true,
      };
    }

    // Stable identity across retries: mint once per entry key.
    let identity = this.minted.get(key);
    if (!identity) {
      identity = {
        eventId: this.idFactory('cap'),
        capturedAt: entry.capturedAt
          ? new Date(entry.capturedAt).toISOString()
          : this.clock().toISOString(),
      };
      this.minted.set(key, identity);
      this.saveState();
    }

    const imagePath = path.isAbsolute(entry.imagePath)
      ? entry.imagePath
      : path.resolve(args.baseDir, entry.imagePath);
    const details = { entryId: entry.entryId, imagePath, eventId: identity.eventId };

    try {
      const ext = path.extname(imagePath).toLowerCase();
      if (!SUPPORTED_INPUT_EXTENSIONS.has(ext)) {
        throw captureError(
          CaptureErrorCodes.UNSUPPORTED_IMAGE_TYPE,
          `"${ext || '(no extension)'}" files are not supported. Use a JPEG, PNG, or WebP photo.`,
          details,
          false,
        );
      }

      let inputBytes: Uint8Array;
      try {
        inputBytes = await readFile(imagePath);
      } catch (err) {
        throw captureError(
          CaptureErrorCodes.IMAGE_FILE_MISSING,
          `The image file for this capture is missing or unreadable: ${entry.imagePath}`,
          { ...details, cause: err instanceof Error ? err.message : String(err) },
          false,
        );
      }

      const normalized = await normalizeImage(
        inputBytes,
        {
          ...(entry.plateShape !== undefined ? { plateShape: entry.plateShape } : {}),
          ...(entry.plateDiameterPx !== undefined
            ? { plateDiameterPx: entry.plateDiameterPx }
            : {}),
        },
        details,
      );

      // Two-step upload through Agent 5's seam (authorize -> bytes -> finalize).
      const auth = await this.uploader.authorizeUpload({
        mimeType: normalized.mimeType,
        sizeBytes: normalized.bytes.byteLength,
        widthPx: normalized.geometry.widthPx,
        heightPx: normalized.geometry.heightPx,
        association: { kind: 'capture', id: identity.eventId },
      });
      await this.uploader.uploadBytes(auth, normalized.bytes);
      const { objectId } = await this.uploader.finalizeUpload(auth);

      const qualityFlags: QualityFlag[] = [...(entry.declaredFlags ?? [])];
      const event: CaptureEvent = {
        eventId: identity.eventId,
        hallId,
        serviceId,
        capturedAt: identity.capturedAt,
        imageObjectId: objectId,
        geometry: normalized.geometry,
        source,
        qualityFlags,
        state: 'pending',
      };

      await this.sink.submitCaptureEvent(event);
      this.completed.set(key, { event, imageObjectId: objectId });
      this.saveState();

      return {
        ok: true,
        entryId: entry.entryId,
        event,
        imageObjectId: objectId,
        alreadyIngested: false,
      };
    } catch (err) {
      const error =
        err instanceof CaptureError ? toApiError(err, details) : toApiError(err, details);
      return { ok: false, entryId: entry.entryId, error };
    }
  }
}
