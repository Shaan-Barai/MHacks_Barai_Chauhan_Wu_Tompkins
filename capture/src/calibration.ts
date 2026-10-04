/**
 * Camera calibration client (IT_4 I2/I3, §3).
 *
 * One calibration frame (a flat reference object of known area lying where
 * plates sit) goes through the SAME normalization as every dish
 * (`topdown-normalized-v1`, 1024×1024), so the calibration's widthPx×heightPx
 * matches the captures it applies to. Then the existing upload flow
 * (authorize → PUT → finalize) with association kind `calibration`, then
 * `POST /api/calibrations`. The backend finds and segments the reference
 * object and computes k = cm²/px, camera heights and depth scale; this module
 * never computes them itself.
 *
 * Idempotent per frame: the finalized objectId and the calibrationId for a
 * (frame, camera, area, label) are kept in a state file, so a rerun shows the
 * existing calibration instead of creating another. A different known area or
 * label for the same photo makes a new calibration (fixing a typo).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { CameraCalibration, MeasurementSettings } from './contract-types.js';
import type { CalibrationApi } from './http.js';
import { normalizeImage } from './normalize.js';
import type { Uploader } from './uploader.js';

/** Credit card ID-1: 85.60 × 53.98 mm (IT_4 I2 default). */
export const CREDIT_CARD_AREA_CM2 = 46.21;
export const DEFAULT_REFERENCE_LABEL = 'credit card';
export const DEFAULT_CAMERA_ID = 'uno-q-c920s-1';
const MAX_KNOWN_AREA_CM2 = 10_000;

export interface CalibrateOptions {
  imagePath: string;
  /** Inbox captureId (or fixture name) of the calibration frame; the retry key. */
  frameId: string;
  hallId: string;
  cameraId: string;
  knownAreaCm2: number;
  referenceLabel: string;
  uploader: Uploader;
  api: CalibrationApi;
  /** JSON file that remembers uploads/calibrations across runs. */
  stateFile?: string;
  /** Polling while the backend reports status 'processing'. */
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CalibrateResult {
  calibration: CameraCalibration;
  imageObjectId: string;
  /** True when this frame/area/label was already calibrated (no new upload or POST). */
  reused: boolean;
  /** Size of the uploaded (normalized) image and of the original frame. */
  widthPx: number;
  heightPx: number;
  sourceWidthPx: number | null;
  sourceHeightPx: number | null;
}

interface CalibrationState {
  uploads: Record<string, { objectId: string; widthPx: number; heightPx: number; sourceWidthPx: number; sourceHeightPx: number }>;
  calibrations: Record<string, string>;
}

/** Throws a plain-language Error for bad user input. */
export function validateCalibrationInput(input: {
  hallId: string;
  cameraId: string;
  knownAreaCm2: number;
  referenceLabel: string;
}): void {
  if (!(Number.isFinite(input.knownAreaCm2) && input.knownAreaCm2 > 0 && input.knownAreaCm2 <= MAX_KNOWN_AREA_CM2)) {
    throw new Error(
      `--known-area-cm2 must be a number above 0 and at most ${MAX_KNOWN_AREA_CM2} (a credit card is ${CREDIT_CARD_AREA_CM2}).`,
    );
  }
  const label = input.referenceLabel.trim();
  if (!label || label.length > 80) throw new Error('--reference-label must be 1 to 80 characters, e.g. "credit card".');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.cameraId)) {
    throw new Error('--camera-id must be 1-64 letters, digits, ".", "_" or "-", e.g. uno-q-c920s-1.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.hallId)) throw new Error(`Invalid hall ID "${input.hallId}".`);
}

function loadState(file: string | undefined): CalibrationState {
  if (file && existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CalibrationState>;
    return { uploads: parsed.uploads ?? {}, calibrations: parsed.calibrations ?? {} };
  }
  return { uploads: {}, calibrations: {} };
}

function saveState(file: string | undefined, state: CalibrationState): void {
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function calibrationKey(o: Pick<CalibrateOptions, 'frameId' | 'hallId' | 'cameraId' | 'knownAreaCm2' | 'referenceLabel'>): string {
  return [o.frameId, o.hallId, o.cameraId, o.knownAreaCm2, o.referenceLabel.trim()].join('|');
}

export async function calibrateFromFrame(options: CalibrateOptions): Promise<CalibrateResult> {
  validateCalibrationInput(options);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const state = loadState(options.stateFile);
  const key = calibrationKey(options);

  let upload = state.uploads[options.frameId];
  const known = state.calibrations[key];
  if (known && upload) {
    const calibration = await options.api.getCalibration(known);
    // A failed calibration is retried with the same uploaded photo.
    if (calibration.status !== 'failed') {
      return { calibration, imageObjectId: upload.objectId, reused: true, ...upload };
    }
  }

  if (!upload) {
    const normalized = await normalizeImage(await readFile(options.imagePath), {}, { frameId: options.frameId });
    const auth = await options.uploader.authorizeUpload({
      mimeType: normalized.mimeType,
      sizeBytes: normalized.bytes.byteLength,
      widthPx: normalized.geometry.widthPx,
      heightPx: normalized.geometry.heightPx,
      association: { kind: 'calibration', id: options.frameId },
    });
    await options.uploader.uploadBytes(auth, normalized.bytes);
    const { objectId } = await options.uploader.finalizeUpload(auth);
    upload = {
      objectId,
      widthPx: normalized.geometry.widthPx,
      heightPx: normalized.geometry.heightPx,
      sourceWidthPx: normalized.sourceWidthPx,
      sourceHeightPx: normalized.sourceHeightPx,
    };
    state.uploads[options.frameId] = upload;
    saveState(options.stateFile, state);
  }

  let calibration = await options.api.createCalibration({
    hallId: options.hallId,
    cameraId: options.cameraId,
    imageObjectId: upload.objectId,
    knownAreaCm2: options.knownAreaCm2,
    referenceLabel: options.referenceLabel.trim(),
  });
  state.calibrations[key] = calibration.calibrationId;
  saveState(options.stateFile, state);

  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  while (calibration.status === 'processing') {
    if (Date.now() > deadline) {
      throw new Error(`Calibration ${calibration.calibrationId} is still processing. Check it later with GET /api/calibrations/${calibration.calibrationId}.`);
    }
    await sleep(options.pollIntervalMs ?? 2000);
    calibration = await options.api.getCalibration(calibration.calibrationId);
  }
  return { calibration, imageObjectId: upload.objectId, reused: false, ...upload };
}

/**
 * Make a calibration the hall's active one (IT_4 I9), keeping the other
 * settings. `depthEnabled` undefined keeps the current toggle (default off).
 */
export async function activateCalibration(
  api: CalibrationApi,
  hallId: string,
  calibrationId: string,
  depthEnabled?: boolean,
): Promise<MeasurementSettings> {
  const current = await api.getSettings(hallId);
  return api.putSettings({
    hallId,
    activeCalibrationId: calibrationId,
    depthEnabled: depthEnabled ?? current?.depthEnabled ?? false,
    ...(current?.plateThicknessCm !== undefined ? { plateThicknessCm: current.plateThicknessCm } : {}),
  });
}

const fmt = (n: number | null | undefined, digits: number) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';

/** Human-readable summary lines (no URLs, no tokens). */
export function describeCalibration(c: CameraCalibration): string[] {
  const lines = [`calibrationId: ${c.calibrationId}  (status ${c.status}, camera ${c.cameraId}, hall ${c.hallId})`];
  if (c.status === 'failed') {
    lines.push(`error: ${c.error?.code ?? 'CALIBRATION_FAILED'} — ${c.error?.message ?? 'no detail'}`);
  }
  if (c.status === 'succeeded') {
    const side = Number.isFinite(c.cm2PerPx) && c.cm2PerPx > 0 ? Math.sqrt(c.cm2PerPx) * 10 : NaN;
    lines.push(
      `reference: "${c.referenceLabel}" ${fmt(c.knownAreaCm2, 2)} cm² = ${fmt(c.referencePixels, 0)} px in a ${c.widthPx}×${c.heightPx} image`,
      `k = ${fmt(c.cm2PerPx, 6)} cm² per pixel  (one pixel ≈ ${fmt(side, 2)} mm on the tray)`,
      `camera height, geometric (f·√k): ${fmt(c.cameraHeightCmGeometric, 1)} cm  ` +
        `[fx ${fmt(c.intrinsics?.fxPx, 1)} px, ${c.intrinsics?.source ?? '?'}]`,
    );
    if (c.depth) {
      lines.push(
        `camera height, Depth Anything V2: ${fmt(c.depth.cameraHeightCmDepth, 1)} cm  ` +
          `(scale ${fmt(c.depth.scale, 3)}, raw median ${fmt(c.depth.rawReferenceMedianM, 3)} m)`,
      );
    } else {
      lines.push('camera height, Depth Anything V2: not measured (depth worker off or unavailable); area method only');
    }
  }
  lines.push(`flags: ${c.flags?.length ? c.flags.join(', ') : 'none'}`);
  return lines;
}
