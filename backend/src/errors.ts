/**
 * Shared ApiError envelope helpers (contracts/types.ts ApiError).
 * Every HTTP error response and every stored failure uses this shape:
 * { code, message, details?, retryable }.
 */

import type { ApiError } from './types.js';

/** An Error that carries an HTTP status plus the contract ApiError body. */
export class HttpError extends Error {
  readonly status: number;
  readonly apiError: ApiError;

  constructor(status: number, apiError: ApiError) {
    super(`${apiError.code}: ${apiError.message}`);
    this.name = 'HttpError';
    this.status = status;
    this.apiError = apiError;
  }
}

export function apiError(
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): ApiError {
  return details === undefined
    ? { code, message, retryable }
    : { code, message, details, retryable };
}

export function badRequest(code: string, message: string, details?: Record<string, unknown>): HttpError {
  return new HttpError(400, apiError(code, message, false, details));
}

export function notFound(code: string, message: string, details?: Record<string, unknown>): HttpError {
  return new HttpError(404, apiError(code, message, false, details));
}

export function conflict(code: string, message: string, details?: Record<string, unknown>): HttpError {
  return new HttpError(409, apiError(code, message, true, details));
}

/** Coerce any thrown value into an HttpError with an ApiError body. */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const message =
    err instanceof Error ? err.message : 'Something went wrong on the server. Please try again.';
  return new HttpError(500, apiError('INTERNAL_ERROR', message, true));
}
