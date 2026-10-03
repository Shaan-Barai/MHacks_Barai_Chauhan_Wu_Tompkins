/**
 * Validation errors in the shared ApiError envelope (contracts/types.ts).
 * Codes are SCREAMING_SNAKE and stable; messages are plain language safe
 * to show dining staff. Parsing/validation failures are never retryable —
 * the input itself must change.
 */

import type { ApiError } from './types.js';

export class DataValidationError extends Error {
  readonly apiError: ApiError;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DataValidationError';
    this.apiError = { code, message, ...(details ? { details } : {}), retryable: false };
  }
}

export function invalid(code: string, message: string, details?: Record<string, unknown>): never {
  throw new DataValidationError(code, message, details);
}
