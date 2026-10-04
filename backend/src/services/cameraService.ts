/**
 * Dashboard "Take photo" button: runs the same one-command capture
 * (capture/scripts/take-photo.mjs --json) the terminal uses, so the button and
 * the CLI share one path (SSH trigger → transfer → ingestPhoto → analysis).
 * One capture at a time; the camera settings stay server-side in .env.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpError, apiError } from '../errors.js';

export interface TakePhotoResult {
  ok: true;
  eventId: string;
  serviceId: string;
  state: string;
  triggeredAt: string;
  receivedAt: string;
}

export type ScriptRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const SCRIPT = fileURLToPath(new URL('../../../../../capture/scripts/take-photo.mjs', import.meta.url));
const TIMEOUT_MS = 150_000;

const nodeRunner: ScriptRunner = (args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

export class CameraService {
  private busy = false;

  constructor(
    /** This backend's own URL, so the script submits to the same server. */
    private readonly apiUrl: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly run: ScriptRunner = nodeRunner,
    private readonly scriptExists: () => boolean = () => existsSync(SCRIPT),
  ) {}

  /** Whether the camera is configured (CAMERA_HOST + CAMERA_USER), for the button's state. */
  status(): { configured: boolean; host?: string; busy: boolean } {
    const host = this.env.CAMERA_HOST?.trim();
    const configured = Boolean(host && this.env.CAMERA_USER?.trim());
    return { configured, ...(configured ? { host } : {}), busy: this.busy };
  }

  async takePhoto(body: { serviceId?: unknown; hallId?: unknown }): Promise<TakePhotoResult> {
    if (!this.status().configured) {
      throw new HttpError(503, apiError('CAMERA_NOT_CONFIGURED', 'Set CAMERA_HOST and CAMERA_USER in .env to use the camera.', false));
    }
    if (!this.scriptExists()) {
      throw new HttpError(503, apiError('CAMERA_SCRIPT_MISSING', 'Build the capture package first (cd capture && npm run build).', false));
    }
    if (this.busy) throw new HttpError(409, apiError('CAMERA_BUSY', 'A photo is already being taken. Try again in a moment.', true));
    const args = ['--json'];
    if (typeof body.serviceId === 'string' && body.serviceId) args.push('--service', body.serviceId);
    if (typeof body.hallId === 'string' && body.hallId) args.push('--hall', body.hallId);
    this.busy = true;
    try {
      const { code, stdout, stderr } = await this.run(args, { ...this.env, SCRAP_API_URL: this.apiUrl, API_URL: this.apiUrl });
      const line = stdout.trim().split('\n').at(-1) ?? '';
      let result: { ok?: boolean; stage?: string; error?: string } & Partial<TakePhotoResult>;
      try {
        result = JSON.parse(line);
      } catch {
        throw new HttpError(502, apiError('CAMERA_FAILED', `The capture script failed: ${(stderr || line).trim().slice(-300) || `exit ${code}`}`, true));
      }
      if (!result.ok) {
        const stage = result.stage ?? 'camera';
        const status = stage === 'service' ? 400 : stage === 'backend' ? 502 : 503;
        throw new HttpError(status, apiError('CAMERA_FAILED', result.error ?? 'The photo could not be taken.', stage !== 'service', { stage }));
      }
      return result as TakePhotoResult;
    } finally {
      this.busy = false;
    }
  }
}
