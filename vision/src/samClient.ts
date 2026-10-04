/**
 * Client for the SAM 2.1 worker (vision/sam/worker.py). Server-side only;
 * the worker runs locally and holds no storage credentials.
 */

import { GatewayError, makeApiError } from './errors.js';

export interface SegmenterInfo {
  model: string;
  checkpoint: string;
  codeRevision: string;
  device: string;
  settingsVersion: string;
}

export interface SegmentResponse extends SegmenterInfo {
  widthPx: number;
  heightPx: number;
  results: { maskPng: Uint8Array; score: number; foregroundPx: number }[];
}

/** The segmentation seam; tests and offline runs inject a fake. */
export interface Segmenter {
  segment(image: Uint8Array, boxesXyxy: [number, number, number, number][]): Promise<SegmentResponse>;
}

/**
 * `token` is sent as `X-Worker-Token` (IT_4: the worker rejects a missing or
 * wrong token with 401 when its WORKER_TOKEN is set). Default env WORKER_TOKEN.
 */
export function createSamWorkerClient(
  url = process.env.SAM_WORKER_URL ?? 'http://127.0.0.1:8790',
  timeoutMs = Number(process.env.SAM_TIMEOUT_MS ?? 60_000),
  token = process.env.WORKER_TOKEN ?? '',
): Segmenter {
  const base = url.replace(/\/$/, '');
  return {
    async segment(image, boxesXyxy) {
      let res: Response;
      try {
        res = await fetch(`${base}/segment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Worker-Token': token } : {}) },
          body: JSON.stringify({ image_b64: Buffer.from(image).toString('base64'), boxes: boxesXyxy }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new GatewayError(
          makeApiError('SEGMENTATION_UNAVAILABLE', 'The segmentation service is not reachable. It is safe to retry.', true),
        );
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new GatewayError(
          makeApiError(
            res.status === 401 ? 'SEGMENTATION_UNAUTHORIZED' : res.status >= 500 ? 'SEGMENTATION_FAILED' : 'SEGMENTATION_REJECTED',
            'The segmentation service could not process this image.',
            res.status >= 500,
            { workerStatus: res.status, workerError: String(body.error ?? '').slice(0, 200) },
          ),
        );
      }
      const results = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
      return {
        model: String(body.model),
        checkpoint: String(body.checkpoint),
        codeRevision: String(body.codeRevision),
        device: String(body.device),
        settingsVersion: String(body.settingsVersion),
        widthPx: Number(body.widthPx),
        heightPx: Number(body.heightPx),
        results: results.map((r) => ({
          maskPng: new Uint8Array(Buffer.from(String(r.maskPngB64 ?? ''), 'base64')),
          score: Number(r.score),
          foregroundPx: Number(r.foregroundPx),
        })),
      };
    },
  };
}
