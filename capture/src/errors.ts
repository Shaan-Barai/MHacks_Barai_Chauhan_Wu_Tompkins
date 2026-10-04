/**
 * Capture error helpers. Every failure is reported as the shared `ApiError`
 * envelope from contracts (code, plain message, details, retryable) so
 * nothing is silently dropped and messages are safe for dining staff.
 */

import type { ApiError } from './contract-types.js';

export const CaptureErrorCodes = {
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  IMAGE_FILE_MISSING: 'IMAGE_FILE_MISSING',
  IMAGE_UNREADABLE: 'IMAGE_UNREADABLE',
  UNSUPPORTED_IMAGE_TYPE: 'UNSUPPORTED_IMAGE_TYPE',
  INVALID_IMAGE_DIMENSIONS: 'INVALID_IMAGE_DIMENSIONS',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
} as const;

export type CaptureErrorCode = (typeof CaptureErrorCodes)[keyof typeof CaptureErrorCodes];

export class CaptureError extends Error {
  readonly apiError: ApiError;

  constructor(apiError: ApiError) {
    super(`${apiError.code}: ${apiError.message}`);
    this.name = 'CaptureError';
    this.apiError = apiError;
  }
}

export function captureError(
  code: CaptureErrorCode,
  message: string,
  details: Record<string, unknown>,
  retryable: boolean,
): CaptureError {
  return new CaptureError({ code, message, details, retryable });
}

/** Normalize any thrown value into an ApiError envelope. */
export function toApiError(err: unknown, details: Record<string, unknown>): ApiError {
  if (err instanceof CaptureError) {
    return { ...err.apiError, details: { ...err.apiError.details, ...details } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: CaptureErrorCodes.UPLOAD_FAILED,
    message: `The image could not be sent to storage. Please try this capture again. (${message})`,
    details,
    retryable: true,
  };
}
