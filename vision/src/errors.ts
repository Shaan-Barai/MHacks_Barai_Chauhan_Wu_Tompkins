/**
 * Normalization of provider / transport failures into the shared ApiError
 * envelope (contracts/types.ts). Nothing in this module throws raw SDK errors
 * past the gateway boundary.
 */

import type { ApiError } from './contracts.js';

/** Thrown internally so callers can carry a normalized ApiError with a stack. */
export class GatewayError extends Error {
  readonly apiError: ApiError;

  constructor(apiError: ApiError) {
    super(`${apiError.code}: ${apiError.message}`);
    this.name = 'GatewayError';
    this.apiError = apiError;
  }
}

export function makeApiError(
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): ApiError {
  return details === undefined
    ? { code, message, retryable }
    : { code, message, details, retryable };
}

/** Best-effort extraction of an HTTP-ish status code from an unknown error. */
function extractStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'code', 'httpStatus']) {
    const value = candidate[key];
    if (typeof value === 'number' && value >= 100 && value <= 599) return value;
  }
  // Some SDK errors embed the status in the message, e.g. "got status: 429 ...".
  if (typeof candidate['message'] === 'string') {
    const match = /\b(4\d\d|5\d\d)\b/.exec(candidate['message']);
    if (match) return Number(match[0]);
  }
  return undefined;
}

function isAbortLike(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; message?: unknown };
  return (
    e.name === 'AbortError' ||
    e.name === 'TimeoutError' ||
    (typeof e.message === 'string' && /abort|timed? ?out/i.test(e.message))
  );
}

/**
 * Normalize any error thrown while talking to Gemini (SDK error, fetch
 * failure, abort, or an already-normalized GatewayError) into an ApiError.
 */
export function normalizeProviderError(err: unknown): ApiError {
  if (err instanceof GatewayError) return err.apiError;

  if (isAbortLike(err)) {
    return makeApiError(
      'GEMINI_TIMEOUT',
      'The image analysis service took too long to answer. It is safe to retry.',
      true,
    );
  }

  const status = extractStatus(err);
  const rawMessage = err instanceof Error ? err.message : String(err);
  const details: Record<string, unknown> = { providerMessage: rawMessage.slice(0, 500) };
  if (status !== undefined) details['providerStatus'] = status;

  // Google answers an invalid API key with 400 INVALID_ARGUMENT, reason API_KEY_INVALID.
  const invalidKey = status === 400 && /API_KEY_INVALID|API key not valid/i.test(rawMessage);
  if (status === 401 || status === 403 || invalidKey) {
    return makeApiError(
      'GEMINI_AUTH_FAILED',
      'The image analysis service rejected our credentials. Check the server configuration.',
      false,
      details,
    );
  }
  if (status === 404) {
    return makeApiError(
      'GEMINI_MODEL_NOT_FOUND',
      'The configured analysis model is not available. Check GEMINI_MODEL.',
      false,
      details,
    );
  }
  // 402 / prepaid credits depleted: a billing problem, not a busy service.
  if (status === 402 || /prepayment credits are depleted|billing/i.test(rawMessage)) {
    return makeApiError(
      'GEMINI_BILLING',
      'The image analysis service account is out of credits. Top up billing for the Gemini API key.',
      false,
      details,
    );
  }
  if (status === 429) {
    return makeApiError(
      'GEMINI_RATE_LIMITED',
      'The image analysis service is busy right now. It is safe to retry shortly.',
      true,
      details,
    );
  }
  if (status !== undefined && status >= 500) {
    return makeApiError(
      'GEMINI_UNAVAILABLE',
      'The image analysis service had a temporary problem. It is safe to retry.',
      true,
      details,
    );
  }
  if (status !== undefined && status >= 400) {
    return makeApiError(
      'GEMINI_BAD_REQUEST',
      'The analysis request was rejected by the image analysis service.',
      false,
      details,
    );
  }
  return makeApiError(
    'GEMINI_REQUEST_FAILED',
    'Could not reach the image analysis service. It is safe to retry.',
    true,
    details,
  );
}
