/**
 * Camera calibration client (IT_4 I2/I3, §3).
 *
 * One calibration frame (a flat reference object of known area lying where
 * plates sit) goes through the SAME normalization as every dish
 * (`topdown-normalized-v1`, 1024×1024), so the calibration's widthPx×heightPx
 * matches the captures it applies to. Then the existing upload flow
 * (authorize → PUT → finalize) with association kind `calibration`, then
 * `POST /api/calibrations`. The backend finds and segments the reference
 * object and computes k = cm²/px and the geometric camera height; this module
 * never computes them itself.
 *
 * Idempotent per (frame, hall, camera, area, label): the calibration id and
 * finalized upload are kept in a state file, so a rerun shows the existing
 * calibration instead of creating another. A different known area or label
 * for the same photo makes a new calibration (fixing a typo); a failed one is
 * retried with a new id and upload.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { CameraCalibration, MeasurementSettings } from './contract-types.js';
import { BackendRequestError, type CalibrationApi } from './http.js';
import { type IdFactory, newId } from './ids.js';
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
  /** Mints the calibration id (default `cal_<ULID>`). */
  idFactory?: IdFactory;
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

interface CalibrationAttempt {
  /** The id the client picked; also the upload's association id (backend contract). */
  calibrationId: string;
  objectId?: string;
  widthPx?: number;
  heightPx?: number;
  sourceWidthPx?: number;
  sourceHeightPx?: number;
}

interface CalibrationState {
  /** calibrationKey → the current attempt for that frame/area/label. */
  attempts: Record<string, CalibrationAttempt>;
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
    return { attempts: parsed.attempts ?? {} };
  }
  return { attempts: {} };
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

async function existing(api: CalibrationApi, calibrationId: string): Promise<CameraCalibration | null> {
  try {
    return await api.getCalibration(calibrationId);
  } catch (err) {
    if (err instanceof BackendRequestError && err.status === 404 && err.apiError?.code !== 'ROUTE_NOT_FOUND') return null;
    throw err;
  }
}

/**
 * Backend contract (backend/src/services/calibrationService.ts): the client
 * picks the calibration id, uploads the photo with association
 * { kind: 'calibration', id: calibrationId }, and POST /api/calibrations is
 * idempotent per upload. So each attempt is one id + one upload; a failed
 * attempt is retried with a fresh id and upload, and a different known area
 * or label is a different attempt.
 */
export async function calibrateFromFrame(options: CalibrateOptions): Promise<CalibrateResult> {
  validateCalibrationInput(options);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const idFactory = options.idFactory ?? newId;
  const state = loadState(options.stateFile);
  const key = calibrationKey(options);

  let attempt = state.attempts[key];
  if (attempt?.objectId) {
    const known = await existing(options.api, attempt.calibrationId);
    if (known && known.status !== 'failed') return result(known, attempt, true);
    if (known?.status === 'failed') attempt = undefined; // new id + upload
  }
  if (!attempt) {
    attempt = { calibrationId: idFactory('cal') };
    state.attempts[key] = attempt;
    saveState(options.stateFile, state);
  }

  if (!attempt.objectId) {
    const normalized = await normalizeImage(await readFile(options.imagePath), {}, { frameId: options.frameId });
    const auth = await options.uploader.authorizeUpload({
      mimeType: normalized.mimeType,
      sizeBytes: normalized.bytes.byteLength,
      widthPx: normalized.geometry.widthPx,
      heightPx: normalized.geometry.heightPx,
      association: { kind: 'calibration', id: attempt.calibrationId },
    });
    await options.uploader.uploadBytes(auth, normalized.bytes);
    const { objectId } = await options.uploader.finalizeUpload(auth);
    Object.assign(attempt, {
      objectId,
      widthPx: normalized.geometry.widthPx,
      heightPx: normalized.geometry.heightPx,
      sourceWidthPx: normalized.sourceWidthPx,
      sourceHeightPx: normalized.sourceHeightPx,
    });
    saveState(options.stateFile, state);
  }

  let calibration = await options.api.createCalibration({
    hallId: options.hallId,
    cameraId: options.cameraId,
    imageObjectId: attempt.objectId!,
    knownAreaCm2: options.knownAreaCm2,
    referenceLabel: options.referenceLabel.trim(),
  });
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  while (calibration.status === 'processing') {
    if (Date.now() > deadline) {
      throw new Error(`Calibration ${calibration.calibrationId} is still processing. Check it later with GET /api/calibrations/${calibration.calibrationId}.`);
    }
    await sleep(options.pollIntervalMs ?? 2000);
    calibration = await options.api.getCalibration(calibration.calibrationId);
  }
  return result(calibration, attempt, false);
}

function result(calibration: CameraCalibration, a: CalibrationAttempt, reused: boolean): CalibrateResult {
  return {
    calibration,
    imageObjectId: a.objectId!,
    reused,
    widthPx: a.widthPx ?? calibration.widthPx,
    heightPx: a.heightPx ?? calibration.heightPx,
    sourceWidthPx: a.sourceWidthPx ?? null,
    sourceHeightPx: a.sourceHeightPx ?? null,
  };
}

/** Make a calibration the hall's active one (IT_4 I9). */
export async function activateCalibration(
  api: CalibrationApi,
  hallId: string,
  calibrationId: string,
): Promise<MeasurementSettings> {
  return api.putSettings({ hallId, activeCalibrationId: calibrationId });
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
      `camera height (f·√k): ${fmt(c.cameraHeightCmGeometric, 1)} cm  ` +
        `[fx ${fmt(c.intrinsics?.fxPx, 1)} px, ${c.intrinsics?.source ?? '?'}]`,
    );
  }
  lines.push(`flags: ${c.flags?.length ? c.flags.join(', ') : 'none'}`);
  return lines;
}
