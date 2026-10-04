/**
 * D6: remembers whether the analysis provider (Gemini) is currently refusing
 * work for a reason that needs a human (billing/credits). Set by a failed
 * analysis attempt, cleared by the next succeeded one; reported on
 * GET /api/ready. In memory: it resets on restart and costs no provider call.
 */

import { log } from '../log.js';

/** Provider errors that only an operator can fix; retrying alone will not help. */
const OPERATOR_CODES = new Set(['GEMINI_BILLING']);

export interface ProviderStatusReport {
  ok: boolean;
  code?: string;
  since?: string;
  failures?: number;
  hint?: string;
}

export class ProviderStatus {
  private code: string | null = null;
  private since = 0;
  private failures = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Called with every finished attempt's status and error code. */
  observe(status: string, errorCode?: string): void {
    if (status === 'succeeded') {
      if (this.code) log.info('analysis provider recovered', { code: this.code });
      this.code = null;
      this.failures = 0;
      return;
    }
    if (!errorCode || !OPERATOR_CODES.has(errorCode)) return;
    this.failures++;
    if (this.code !== errorCode) {
      this.code = errorCode;
      this.since = this.now();
      log.error('ANALYSIS PROVIDER UNAVAILABLE: captures fail until it is fixed; then run backend/scripts/retry-failed.mjs', {
        code: errorCode,
      });
    }
  }

  report(): ProviderStatusReport {
    if (!this.code) return { ok: true };
    return {
      ok: false,
      code: this.code,
      since: new Date(this.since).toISOString(),
      failures: this.failures,
      hint: 'Top up the Gemini API billing, then run: node backend/scripts/retry-failed.mjs --start YYYY-MM-DD --end YYYY-MM-DD',
    };
  }
}
