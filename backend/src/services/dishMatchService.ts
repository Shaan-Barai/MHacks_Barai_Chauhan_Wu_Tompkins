/**
 * Same-dish comparison for the camera bridge (BRIDGE.md §4.3).
 *
 * Validates two transient thumbnails and asks Agent 4's judgeSameDish. The
 * thumbnails are never stored, logged, or written to SpacetimeDB; only the
 * verdict is returned. Without a live Gemini key this refuses with 503
 * instead of inventing a verdict, so the bridge pauses rather than guessing.
 */

import { judgeSameDish, type GeminiGateway, type ImageInput } from '@scrap/vision';
import { HttpError, apiError, badRequest } from '../errors.js';
import type { DishMatchImage, DishMatchRequest, DishMatchResult } from '../types.js';

const MIME_TYPES: DishMatchImage['mimeType'][] = ['image/jpeg', 'image/png', 'image/webp'];
/** Per-thumbnail cap; the bridge sends ~512 px JPEGs well under this. */
export const MAX_THUMBNAIL_BYTES = 400 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeImage(raw: unknown, name: 'reference' | 'candidate'): ImageInput {
  const img = raw as Partial<DishMatchImage> | undefined;
  if (!img || typeof img !== 'object' || !MIME_TYPES.includes(img.mimeType as DishMatchImage['mimeType'])) {
    throw badRequest('INVALID_DISH_MATCH', `'${name}' needs a mimeType of ${MIME_TYPES.join(', ')} and base64 data.`, {
      field: name,
    });
  }
  if (typeof img.base64 !== 'string' || img.base64.length === 0 || !BASE64_RE.test(img.base64)) {
    throw badRequest('INVALID_DISH_MATCH', `'${name}.base64' must be non-empty base64 image data.`, { field: name });
  }
  const bytes = Buffer.from(img.base64, 'base64');
  if (bytes.byteLength > MAX_THUMBNAIL_BYTES) {
    throw badRequest('DISH_MATCH_IMAGE_TOO_LARGE', `'${name}' is larger than the ${MAX_THUMBNAIL_BYTES}-byte thumbnail limit.`, {
      field: name,
      sizeBytes: bytes.byteLength,
      maxBytes: MAX_THUMBNAIL_BYTES,
    });
  }
  return { kind: 'bytes', bytes: new Uint8Array(bytes), mimeType: img.mimeType as string };
}

export class DishMatchService {
  /** `gateway` is undefined when GEMINI_API_KEY is unset (see wiring.ts). */
  constructor(private readonly gateway: GeminiGateway | undefined) {}

  async match(body: unknown): Promise<DishMatchResult> {
    const req = (body ?? {}) as Partial<DishMatchRequest>;
    const reference = decodeImage(req.reference, 'reference');
    const candidate = decodeImage(req.candidate, 'candidate');
    if (!this.gateway) {
      throw new HttpError(
        503,
        apiError(
          'DISH_MATCH_UNAVAILABLE',
          'Dish comparison needs a configured Gemini key (GEMINI_API_KEY). No verdict was guessed.',
          true,
        ),
      );
    }
    const result = await judgeSameDish(this.gateway, { reference, candidate });
    if (!result.ok) throw new HttpError(502, result.error);
    const { model, promptVersion, reason } = result;
    return result.plateVisible
      ? { plateVisible: true, sameDish: result.sameDish, reason, model, promptVersion }
      : { plateVisible: false, reason, model, promptVersion };
  }
}
