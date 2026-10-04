/**
 * GET /api/ready (IT_4 I11): is every dependency reachable? Reports each
 * check separately. `required` checks decide the HTTP status (200 vs 503):
 * the database and object storage always, the SAM worker only when live
 * mask analysis is configured.
 * No URLs, keys or tokens appear in the report.
 */

import type { Repository } from '../repo/repository.js';
import type { ProviderStatus, ProviderStatusReport } from './providerStatus.js';
import type { ObjectStorageAdapter } from '../storage/objectStorage.js';

export interface ReadinessCheck {
  ok: boolean;
  required: boolean;
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  ready: boolean;
  checks: Record<'database' | 'objectStorage' | 'samWorker', ReadinessCheck>;
  /** D6: informational (never changes `ready`): a Gemini billing outage seen by recent captures. */
  providers: { gemini: ProviderStatusReport };
}

export interface ReadinessOptions {
  repo: Repository;
  storage: ObjectStorageAdapter;
  samWorkerUrl?: string;
  workerToken?: string;
  /** SAM is needed only for live mask analysis (not the mock analyzer). */
  samRequired: boolean;
  providerStatus?: ProviderStatus;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const SENTINEL_KEY = '_ready/probe';

export class ReadinessService {
  constructor(private readonly opts: ReadinessOptions) {}

  async check(): Promise<ReadinessReport> {
    const timeoutMs = this.opts.timeoutMs ?? 3000;
    const [database, objectStorage, samWorker] = await Promise.all([
      timed(true, timeoutMs, async () => {
        await this.opts.repo.ping?.();
      }),
      timed(true, timeoutMs, async () => {
        // A HEAD on a key that never exists: proves reachability + credentials.
        await this.opts.storage.statObject(SENTINEL_KEY);
      }),
      timed(this.opts.samRequired, timeoutMs, () => this.worker(this.opts.samWorkerUrl, timeoutMs)),
    ]);
    const checks = { database, objectStorage, samWorker };
    return {
      ready: Object.values(checks).every((c) => c.ok || !c.required),
      checks,
      providers: { gemini: this.opts.providerStatus?.report() ?? { ok: true } },
    };
  }

  private async worker(url: string | undefined, timeoutMs: number): Promise<void> {
    if (!url) throw new Error('not configured');
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${url.replace(/\/$/, '')}/health`, {
      headers: this.opts.workerToken ? { 'X-Worker-Token': this.opts.workerToken } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`health returned HTTP ${res.status}`);
  }
}

async function timed(required: boolean, timeoutMs: number, fn: () => Promise<void>): Promise<ReadinessCheck> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs).unref()),
    ]);
    return { ok: true, required, latencyMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unreachable';
    // Short, URL-free reason (fetch errors can embed the target).
    const error = /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message) ? 'unreachable' : message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 120);
    return { ok: false, required, latencyMs: Date.now() - start, error };
  }
}
