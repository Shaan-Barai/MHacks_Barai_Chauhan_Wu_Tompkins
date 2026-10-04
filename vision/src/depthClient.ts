/**
 * Client for the Depth Anything V2 worker (vision/depth/worker.py, IT_4 I4)
 * plus the 16-bit PNG codec used to store depth maps in object storage.
 *
 * Server-side only. The worker returns little-endian float32 metres,
 * row-major, at exactly the input image size; this client re-validates the
 * dimensions and byte length before decoding.
 *
 * Storage format (`depth-png16-v1`): 16-bit greyscale PNG, one sample per
 * pixel = round(depth_m × 10 000), i.e. units of 0.1 mm, clamped to
 * 1..65 535 (max 6.5535 m). 0 means "no valid depth" (non-finite or ≤ 0).
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { GatewayError, makeApiError } from './errors.js';

export const DEPTH_CHECKPOINT = 'depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf';
export const DEPTH_SETTINGS_VERSION = 'dav2-metric-small-v1';
export const DEPTH_PNG_VERSION = 'depth-png16-v1';
/** PNG sample units per metre (0.1 mm). */
export const DEPTH_PNG_UNITS_PER_M = 10_000;

export interface DepthInfo {
  model: string;
  checkpoint: string;
  device: string;
  settingsVersion: string;
}

export interface DepthMap extends DepthInfo {
  widthPx: number;
  heightPx: number;
  /** Raw DAv2 metric depth, metres, row-major (index = y × widthPx + x). */
  depthM: Float32Array;
  minM: number;
  maxM: number;
}

/** The depth seam; tests and offline runs inject a fake. */
export interface DepthEstimator {
  /** `expected` (when given) must match the worker's output size, else DEPTH_MISALIGNED. */
  estimate(image: Uint8Array, expected?: { widthPx: number; heightPx: number }): Promise<DepthMap>;
}

export interface DepthWorkerClientOptions {
  /** Default env DEPTH_WORKER_URL, then http://127.0.0.1:8791. */
  url?: string;
  /** Default env DEPTH_TIMEOUT_MS, then 60000. */
  timeoutMs?: number;
  /** Sent as X-Worker-Token. Default env WORKER_TOKEN; unset ⇒ no header. */
  token?: string;
}

/** Validate a worker JSON body and decode it into a DepthMap. Throws GatewayError(DEPTH_INVALID / DEPTH_MISALIGNED). */
export function decodeDepthResponse(body: Record<string, unknown>, expected?: { widthPx: number; heightPx: number }): DepthMap {
  const W = Number(body.widthPx);
  const H = Number(body.heightPx);
  const bad = (reason: string, details: Record<string, unknown> = {}) =>
    new GatewayError(makeApiError('DEPTH_INVALID', 'The depth service returned an unusable depth map.', false, { reason, ...details }));
  if (!Number.isInteger(W) || !Number.isInteger(H) || W <= 0 || H <= 0) throw bad('bad_dimensions');
  if (expected && (expected.widthPx !== W || expected.heightPx !== H)) {
    throw new GatewayError(
      makeApiError('DEPTH_MISALIGNED', 'The depth map does not match the analyzed image.', false, {
        expected: [expected.widthPx, expected.heightPx],
        got: [W, H],
      }),
    );
  }
  const raw = Buffer.from(String(body.depthF32B64 ?? ''), 'base64');
  if (raw.length !== W * H * 4) throw bad('bad_length', { bytes: raw.length, expectedBytes: W * H * 4 });
  const depthM = new Float32Array(W * H);
  let minM = Infinity;
  let maxM = -Infinity;
  for (let i = 0; i < depthM.length; i++) {
    const v = raw.readFloatLE(i * 4);
    depthM[i] = v;
    if (Number.isFinite(v)) {
      if (v < minM) minM = v;
      if (v > maxM) maxM = v;
    }
  }
  if (!Number.isFinite(minM)) throw bad('no_finite_values');
  return {
    model: String(body.model ?? ''),
    checkpoint: String(body.checkpoint ?? ''),
    device: String(body.device ?? ''),
    settingsVersion: String(body.settingsVersion ?? ''),
    widthPx: W,
    heightPx: H,
    depthM,
    minM,
    maxM,
  };
}

export function createDepthWorkerClient(opts: DepthWorkerClientOptions = {}): DepthEstimator {
  const base = (opts.url ?? process.env.DEPTH_WORKER_URL ?? 'http://127.0.0.1:8791').replace(/\/$/, '');
  const timeoutMs = opts.timeoutMs ?? Number(process.env.DEPTH_TIMEOUT_MS ?? 60_000);
  const token = opts.token ?? process.env.WORKER_TOKEN ?? '';
  return {
    async estimate(image, expected) {
      let res: Response;
      try {
        res = await fetch(`${base}/depth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Worker-Token': token } : {}) },
          body: JSON.stringify({ image_b64: Buffer.from(image).toString('base64') }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new GatewayError(makeApiError('DEPTH_UNAVAILABLE', 'The depth service is not reachable. It is safe to retry.', true));
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new GatewayError(
          makeApiError(
            res.status === 401 ? 'DEPTH_UNAUTHORIZED' : res.status >= 500 ? 'DEPTH_FAILED' : 'DEPTH_REJECTED',
            'The depth service could not process this image.',
            res.status >= 500,
            { workerStatus: res.status, workerError: String(body.error ?? '').slice(0, 200) },
          ),
        );
      }
      return decodeDepthResponse(body, expected);
    },
  };
}

// ---------------------------------------------------------------------------
// 16-bit greyscale PNG codec (no dependency; zlib + CRC32 only).
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Metres → 0.1 mm units, clamped to 1..65535; non-finite or ≤ 0 → 0 (invalid). */
export function depthToUnits(m: number): number {
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.min(65_535, Math.max(1, Math.round(m * DEPTH_PNG_UNITS_PER_M)));
}

/** Encode metres as a 16-bit greyscale PNG in 0.1 mm units (`depth-png16-v1`). */
export function encodeDepthPng16(depthM: ArrayLike<number>, widthPx: number, heightPx: number): Uint8Array {
  if (depthM.length !== widthPx * heightPx) throw new RangeError('depth length does not match dimensions');
  const stride = widthPx * 2;
  // Filter type 2 (Up) per row: depth is smooth, so this compresses well.
  const raw = Buffer.alloc((stride + 1) * heightPx);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < widthPx; x++) cur.writeUInt16BE(depthToUnits(depthM[y * widthPx + x]!), x * 2);
    const o = y * (stride + 1);
    raw[o] = 2;
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (cur[i]! - prev[i]!) & 0xff;
    cur.copy(prev);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(widthPx, 0);
  ihdr.writeUInt32BE(heightPx, 4);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 0; // greyscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return new Uint8Array(
    Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]),
  );
}

export interface DecodedDepthPng {
  widthPx: number;
  heightPx: number;
  /** Raw 0.1 mm units (0 = invalid). */
  units: Uint16Array;
  /** Metres; NaN where the stored value was 0 (invalid). */
  depthM: Float32Array;
}

/** Decode a `depth-png16-v1` PNG (16-bit greyscale, non-interlaced; any row filter). */
export function decodeDepthPng16(png: Uint8Array): DecodedDepthPng {
  const buf = Buffer.from(png);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let off = 8;
  let W = 0;
  let H = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      W = data.readUInt32BE(0);
      H = data.readUInt32BE(4);
      if (data[8] !== 16 || data[9] !== 0 || data[12] !== 0) throw new Error('depth PNG must be 16-bit greyscale, non-interlaced');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!W || !H || idat.length === 0) throw new Error('depth PNG is missing IHDR or IDAT');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = W * 2;
  if (raw.length !== (stride + 1) * H) throw new Error('depth PNG data length mismatch');
  const units = new Uint16Array(W * H);
  const depthM = new Float32Array(W * H);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  const bpp = 2;
  for (let y = 0; y < H; y++) {
    const o = y * (stride + 1);
    const ft = raw[o]!;
    for (let i = 0; i < stride; i++) {
      const x = raw[o + 1 + i]!;
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v: number;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`bad PNG filter ${ft}`);
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < W; x++) {
      const u = cur.readUInt16BE(x * 2);
      units[y * W + x] = u;
      depthM[y * W + x] = u === 0 ? NaN : u / DEPTH_PNG_UNITS_PER_M;
    }
    cur.copy(prev);
  }
  return { widthPx: W, heightPx: H, units, depthM };
}
