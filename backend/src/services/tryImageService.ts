/**
 * "Try an Image": a public, in-memory, one-at-a-time analysis of a visitor's
 * photo (Gemini classify + boxes -> SAM 2.1 -> counted pixels). Nothing is
 * written to R2 or SpacetimeDB, so these uploads never reach dashboard data.
 * The pipeline (upload_demo/pipeline.mjs) is imported lazily on first use so
 * backend startup and tests never load vision/sharp.
 */

import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apiError } from '../errors.js';
import type { TryImageError, TryImageImages, TryImageJob, TryImageStatus, TryImageSummary } from '../types.js';

export interface TryImageRunResult {
  summary: TryImageSummary;
  images: Record<keyof TryImageImages, Uint8Array | Buffer | null | undefined>;
}
export type TryImageRunner = (bytes: Buffer) => Promise<TryImageRunResult>;

export const TRY_IMAGE_MAX_WAITING = 4;
export const TRY_IMAGE_KEPT = 20;
const MENU_KEYS = ['halal-chicken', 'halal-rice'];

export function repoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  const marker = `${sep}backend${sep}`;
  const at = here.lastIndexOf(`${sep}dist${marker}`);
  // dist/backend/src/services/x.js -> <repo>/backend/dist/... ; src/services/x.ts -> <repo>/backend/src/...
  return at >= 0 ? resolve(here.slice(0, at), '..') : resolve(dirname(here), '../../..');
}

/** Lazy runner around upload_demo/pipeline.mjs (absolute path computed at runtime). */
export function createPipelineRunner(opts: { samWorkerUrl: string; workerToken?: string }): TryImageRunner {
  let ready: Promise<{ run: (bytes: Buffer) => Promise<TryImageRunResult> }> | undefined;
  const load = async () => {
    const modPath = join(repoRoot(), 'upload_demo', 'pipeline.mjs');
    const p = (await import(pathToFileURL(modPath).href)) as any;
    const foods = p.loadFoodDatabase();
    const gateway = p.createGeminiGateway();
    const sam = p.createSamWorkerClient(opts.samWorkerUrl, undefined, opts.workerToken ?? '');
    return {
      run: (bytes: Buffer) => p.runSteps({ gateway, sam, foods, bytes, menuKeys: MENU_KEYS }) as Promise<TryImageRunResult>,
    };
  };
  return async (bytes) => {
    ready ??= load().catch((e) => {
      ready = undefined;
      throw e;
    });
    return (await ready).run(bytes);
  };
}

export class TryImageRejection extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
  get body() {
    return apiError(this.code, this.message, this.retryable, this.details);
  }
}

interface Job {
  id: string;
  status: TryImageJob['status'];
  bytes?: Buffer;
  error?: TryImageError;
  summary?: TryImageSummary;
  images?: TryImageImages;
}

const dataUrl = (b: Uint8Array | Buffer | null | undefined): string | null =>
  b ? `data:image/jpeg;base64,${Buffer.from(b).toString('base64')}` : null;

export function friendlyFailure(err: unknown): TryImageError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/unsupported image format|Input buffer|corrupt|pngload|jpegload|webpload/i.test(msg)) {
    return { code: 'UNREADABLE_IMAGE', message: 'That file could not be read as an image. Try a JPEG, PNG or WebP photo.' };
  }
  if (/fetch failed|ECONNREFUSED|SAM/i.test(msg)) {
    return {
      code: 'ANALYSIS_FAILED',
      message: 'The SAM 2.1 worker is not reachable right now, so the photo could not be analysed. Try again later.',
    };
  }
  return { code: 'ANALYSIS_FAILED', message: 'Analysis failed. Try again or use another photo.' };
}

export class TryImageService {
  private readonly jobs = new Map<string, Job>(); // oldest first
  private readonly queue: Job[] = [];
  private running: Job | null = null;
  private readonly accepted: number[] = [];

  constructor(
    private readonly opts: {
      runner: TryImageRunner;
      /** null when Gemini is live; otherwise why the feature is off. */
      unavailableReason: string | null;
      maxPerHour: number;
      now?: () => number;
      maxWaiting?: number;
    },
  ) {}

  private get now() {
    return (this.opts.now ?? Date.now)();
  }
  private get maxWaiting() {
    return this.opts.maxWaiting ?? TRY_IMAGE_MAX_WAITING;
  }
  private hourlyRemaining(): number {
    const cutoff = this.now - 3_600_000;
    while (this.accepted.length && (this.accepted[0] as number) <= cutoff) this.accepted.shift();
    return Math.max(0, this.opts.maxPerHour - this.accepted.length);
  }

  status(): TryImageStatus {
    const reason =
      this.opts.unavailableReason ??
      (this.hourlyRemaining() <= 0 ? 'The hourly limit for demo analyses has been used up. Try again later.' : null);
    return {
      available: reason === null,
      ...(reason ? { reason } : {}),
      waiting: this.queue.length,
      running: this.running !== null,
      maxWaiting: this.maxWaiting,
      hourlyRemaining: this.hourlyRemaining(),
    };
  }

  /** Throws TryImageRejection (503/429) when a new analysis cannot be accepted. */
  assertAccepting(): void {
    if (this.opts.unavailableReason) {
      throw new TryImageRejection(503, 'UNAVAILABLE', this.opts.unavailableReason, true);
    }
    if (this.hourlyRemaining() <= 0) {
      throw new TryImageRejection(429, 'RATE_LIMITED', 'The hourly limit for demo analyses has been used up. Try again later.', true);
    }
    if (this.queue.length >= this.maxWaiting) {
      throw new TryImageRejection(429, 'BUSY', 'Several photos are already waiting. Try again in a minute.', true, {
        waiting: this.queue.length,
      });
    }
  }

  submit(bytes: Buffer): { id: string; status: 'queued'; position: number } {
    this.assertAccepting();
    this.accepted.push(this.now);
    const job: Job = { id: randomUUID().slice(0, 8), status: 'queued', bytes };
    this.jobs.set(job.id, job);
    while (this.jobs.size > TRY_IMAGE_KEPT) {
      const oldest = [...this.jobs.values()].find((j) => j.status === 'done' || j.status === 'failed');
      if (!oldest) break;
      this.jobs.delete(oldest.id);
    }
    this.queue.push(job);
    const position = this.positionOf(job) as number;
    void this.pump();
    return { id: job.id, status: 'queued', position };
  }

  /** 1-based place in line (the running analysis counts as place 1); undefined once running or finished. */
  private positionOf(job: Job): number | undefined {
    const i = this.queue.indexOf(job);
    return i < 0 ? undefined : i + 1 + (this.running ? 1 : 0);
  }

  get(id: string): TryImageJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const position = this.positionOf(job);
    return {
      id: job.id,
      status: job.status,
      ...(position !== undefined ? { position } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.summary ? { summary: job.summary } : {}),
      ...(job.images ? { images: job.images } : {}),
    };
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = job;
    job.status = 'running';
    try {
      const out = await this.opts.runner(job.bytes as Buffer);
      job.summary = out.summary;
      job.images = {
        original: dataUrl(out.images.original),
        boxes: dataUrl(out.images.boxes),
        masks: dataUrl(out.images.masks),
        final: dataUrl(out.images.final),
      };
      job.status = 'done';
    } catch (err) {
      job.error = friendlyFailure(err);
      job.status = 'failed';
    } finally {
      delete job.bytes;
      this.running = null;
      void this.pump();
    }
  }
}
