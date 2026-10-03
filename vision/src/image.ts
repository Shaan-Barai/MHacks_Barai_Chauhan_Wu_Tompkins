/**
 * Image input handling (AGENTS.md 4.7).
 *
 * The caller (Agent 5) hands us either raw bytes or a temporary read URL it
 * has already authorized. This module only owns Gemini's inline-data
 * formatting; bucket access, object validation, and read-URL issuance stay
 * with Agent 5.
 */

import { GatewayError, makeApiError, normalizeProviderError } from './errors.js';
import type { GatewayInlineDataPart } from './gateway.js';

export type ImageInput =
  | { kind: 'bytes'; bytes: Uint8Array; mimeType: string }
  | { kind: 'url'; url: string; mimeType?: string; timeoutMs?: number };

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
/** Guard against absurd payloads; Gemini inline data is limited anyway. */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

function assertSupportedMime(mimeType: string): void {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new GatewayError(
      makeApiError('VISION_UNSUPPORTED_IMAGE_TYPE', `Image type ${mimeType} is not supported for analysis.`, false, {
        allowed: [...ALLOWED_MIME_TYPES],
      }),
    );
  }
}

function toPart(bytes: Uint8Array, mimeType: string): GatewayInlineDataPart {
  assertSupportedMime(mimeType);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new GatewayError(
      makeApiError('VISION_IMAGE_SIZE_INVALID', 'The capture image is empty or too large to analyze.', false, {
        sizeBytes: bytes.byteLength,
        maxBytes: MAX_IMAGE_BYTES,
      }),
    );
  }
  return { inlineData: { mimeType, data: Buffer.from(bytes).toString('base64') } };
}

/** Convert caller-supplied image input into a Gemini inline-data part. */
export async function imageInputToPart(input: ImageInput): Promise<GatewayInlineDataPart> {
  if (input.kind === 'bytes') {
    return toPart(input.bytes, input.mimeType);
  }
  // Temporary read URL from Agent 5's storage interface. Fetch server-side,
  // then inline. Never log the (possibly signed) URL.
  let response: Response;
  try {
    response = await fetch(input.url, {
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const normalized = normalizeProviderError(err);
    throw new GatewayError(
      makeApiError('VISION_IMAGE_FETCH_FAILED', 'Could not download the capture image for analysis.', true, {
        cause: normalized.code,
      }),
    );
  }
  if (!response.ok) {
    throw new GatewayError(
      makeApiError(
        'VISION_IMAGE_FETCH_FAILED',
        'Could not download the capture image for analysis.',
        response.status === 403 || response.status === 404 ? false : true,
        { httpStatus: response.status },
      ),
    );
  }
  const mimeType = input.mimeType ?? response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  const bytes = new Uint8Array(await response.arrayBuffer());
  return toPart(bytes, mimeType);
}
