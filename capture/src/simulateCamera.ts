/**
 * Camera simulator for the Uno Q inbox (BRIDGE.md "Run it without the board").
 *
 * Writes existing photos into an inbox exactly the way
 * `capture/uno-q/laptop_capture.py` publishes a manual (Enter / `--once`)
 * capture:
 *
 *   <inbox>/<uuid4>/photo.jpg       the JPEG bytes, unchanged
 *   <inbox>/<uuid4>/metadata.json   protocol v1 fields, 2-space JSON + newline
 *
 * Each capture is written into a dot-prefixed `.receive-*` directory first
 * (files fsynced), then renamed into place, so the bridge never sees a
 * half-written capture. The metadata has the same fields as a real manual
 * capture; only the values that would be false are changed:
 * `captureSource: 'simulated_camera'` and `device: 'simulate-camera:<file>'`.
 * The bridge reads `captureSource` and labels these dishes `source: 'replay'`.
 *
 * Every photo is one new capture (one distinct dish). No network, no Gemini.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { SIMULATED_CAPTURE_SOURCE } from './inbox.js';

/** Same limits laptop_capture.py enforces on a received bundle. */
export const MAX_SIMULATED_JPEG_BYTES = 16 * 1024 * 1024;
const MAX_DIMENSION_PX = 8192;

/** The metadata.json a manual Uno Q capture carries (uno_q_camera.py capture_image). */
export interface SimulatedCaptureMetadata {
  protocolVersion: 1;
  captureId: string;
  capturedAt: string;
  timestampBasis: 'board_frame_received';
  captureSource: typeof SIMULATED_CAPTURE_SOURCE;
  device: string;
  mimeType: 'image/jpeg';
  widthPx: number;
  heightPx: number;
  requestedWidthPx: number;
  requestedHeightPx: number;
  normalized: false;
  byteLength: number;
  sha256: string;
}

export interface SimulatedCapture {
  captureId: string;
  /** Final capture directory inside the inbox. */
  dir: string;
  sourcePhoto: string;
  metadata: SimulatedCaptureMetadata;
}

export interface SimulateCameraOptions {
  inbox: string;
  /** JPEG files, written in this order. */
  photos: string[];
  /** Wait between photos (default 0). */
  intervalMs?: number;
  clock?: () => Date;
  idFactory?: () => string;
  sleep?: (ms: number) => Promise<void>;
  onSaved?: (capture: SimulatedCapture) => void;
}

const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg']);

/** JPEG files in a directory (sorted by name), or the given files as-is. */
export async function listPhotos(input: string): Promise<string[]> {
  if (!(await stat(input)).isDirectory()) return [path.resolve(input)];
  return (await readdir(input))
    .filter((name) => !name.startsWith('.') && JPEG_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.resolve(input, name));
}

async function writeSynced(file: string, content: Uint8Array | string): Promise<void> {
  const handle = await open(file, 'w');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Validate a photo the same way laptop_capture.py validates a camera bundle. */
async function readCameraJpeg(file: string): Promise<{ photo: Buffer; widthPx: number; heightPx: number }> {
  const photo = await readFile(file);
  if (!(photo.byteLength > 0 && photo.byteLength <= MAX_SIMULATED_JPEG_BYTES)) {
    throw new Error(`${file}: a camera JPEG must be 1 byte to 16 MB.`);
  }
  const soi = photo[0] === 0xff && photo[1] === 0xd8;
  const eoi = photo[photo.byteLength - 2] === 0xff && photo[photo.byteLength - 1] === 0xd9;
  if (!soi || !eoi) throw new Error(`${file}: not a complete JPEG (the camera only sends complete JPEGs).`);
  // Stored (pre-EXIF-rotation) dimensions, like uno_q_camera.py jpeg_dimensions().
  const { width, height, format } = await sharp(photo).metadata();
  if (format !== 'jpeg' || !width || !height || width > MAX_DIMENSION_PX || height > MAX_DIMENSION_PX) {
    throw new Error(`${file}: JPEG dimensions must be 1 to ${MAX_DIMENSION_PX} pixels.`);
  }
  return { photo, widthPx: width, heightPx: height };
}

export async function simulateCamera(options: SimulateCameraOptions): Promise<SimulatedCapture[]> {
  const inbox = path.resolve(options.inbox);
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = options.intervalMs ?? 0;
  await mkdir(inbox, { recursive: true });

  const saved: SimulatedCapture[] = [];
  let lastMs = -Infinity;
  for (const [index, sourcePhoto] of options.photos.entries()) {
    if (index > 0 && intervalMs > 0) await sleep(intervalMs);
    const { photo, widthPx, heightPx } = await readCameraJpeg(sourcePhoto);
    const captureId = idFactory();
    // Strictly increasing timestamps keep the bridge's capture order = write order.
    const ms = Math.max(clock().getTime(), lastMs + 1);
    lastMs = ms;
    const metadata: SimulatedCaptureMetadata = {
      protocolVersion: 1,
      captureId,
      capturedAt: new Date(ms).toISOString(),
      timestampBasis: 'board_frame_received',
      captureSource: SIMULATED_CAPTURE_SOURCE,
      device: `simulate-camera:${path.basename(sourcePhoto)}`,
      mimeType: 'image/jpeg',
      widthPx,
      heightPx,
      requestedWidthPx: widthPx,
      requestedHeightPx: heightPx,
      normalized: false,
      byteLength: photo.byteLength,
      sha256: createHash('sha256').update(photo).digest('hex'),
    };

    const destination = path.join(inbox, captureId);
    const exists = await stat(destination).then(
      () => true,
      () => false,
    );
    if (exists) throw new Error(`A capture folder ${captureId} already exists in ${inbox}.`);
    // laptop_capture.py save_capture(): dot-prefixed temp dir, fsync, rename.
    const temporary = await mkdtemp(path.join(inbox, '.receive-'));
    try {
      await writeSynced(path.join(temporary, 'photo.jpg'), photo);
      await writeSynced(path.join(temporary, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    const capture = { captureId, dir: destination, sourcePhoto, metadata };
    saved.push(capture);
    options.onSaved?.(capture);
  }
  return saved;
}
