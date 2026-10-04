/**
 * Uno Q camera access from the computer (take-photo, camera tests).
 *
 * - Settings come from the environment (.env): CAMERA_HOST, CAMERA_USER,
 *   CAMERA_SSH_KEY, never from code. The board's IP can change when it
 *   rejoins Wi-Fi, so only .env needs editing.
 * - SSH is key-only: BatchMode=yes (never a password prompt), IdentitiesOnly,
 *   and a connect timeout, so a missing key fails fast instead of hanging.
 * - The C920 shows up as several /dev/video nodes; the capture node is picked
 *   by name from `v4l2-ctl --list-devices` (the first node listed under the
 *   camera's name is its capture node).
 * - The photo itself is transferred by the existing laptop_capture.py
 *   (one SSH call; the board sends the JPEG with its SHA-256, verified here).
 *   The scan time is this computer's clock at the trigger.
 *
 * Every external command runs through an injectable `CommandRunner`, so the
 * whole flow is testable without the board.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface CameraConfig {
  host: string;
  user: string;
  /** Private key for key-only SSH. */
  keyPath: string;
  /** Substring of the camera's name in `v4l2-ctl --list-devices` (default 'C920'). */
  deviceName: string;
  /** Explicit /dev/video node; skips detection when set (CAMERA_DEVICE). */
  device?: string;
  widthPx: number;
  heightPx: number;
  /** Seconds the board discards frames so auto-exposure settles (2 s ≈ 60 frames at 30 fps). */
  warmupSeconds: number;
  /** Recorded on every scan (CAMERA_DEVICE_ID, default 'uno-q-c920'). */
  deviceId: string;
  /** SSH connect timeout in seconds. */
  connectTimeoutS: number;
  /** Board-side capture script (deployed by capture/uno-q/README.md step 4). */
  remoteScript: string;
}

export class CameraConfigError extends Error {}

function positive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new CameraConfigError(`${name} must be a positive number.`);
  return n;
}

/** Reads CAMERA_* settings. Throws CameraConfigError naming what is missing. */
export function loadCameraConfig(env: NodeJS.ProcessEnv = process.env): CameraConfig {
  const host = env.CAMERA_HOST?.trim() ?? '';
  const user = env.CAMERA_USER?.trim() ?? '';
  const missing = [!host && 'CAMERA_HOST', !user && 'CAMERA_USER'].filter(Boolean);
  if (missing.length > 0) {
    throw new CameraConfigError(`Set ${missing.join(' and ')} in .env (see .env.example).`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(host) || !/^[A-Za-z0-9_.-]+$/.test(user)) {
    throw new CameraConfigError('CAMERA_HOST and CAMERA_USER may contain only letters, digits, ".", "-" and "_".');
  }
  const keyRaw = env.CAMERA_SSH_KEY?.trim() || '~/.ssh/scrap_unoq';
  const device = env.CAMERA_DEVICE?.trim();
  if (device && !/^\/dev\/[A-Za-z0-9_./-]+$/.test(device)) throw new CameraConfigError('CAMERA_DEVICE must be a /dev path.');
  return {
    host,
    user,
    keyPath: keyRaw.startsWith('~/') ? path.join(os.homedir(), keyRaw.slice(2)) : keyRaw,
    deviceName: env.CAMERA_DEVICE_NAME?.trim() || 'C920',
    ...(device ? { device } : {}),
    widthPx: positive(env.CAMERA_WIDTH, 1920, 'CAMERA_WIDTH'),
    heightPx: positive(env.CAMERA_HEIGHT, 1080, 'CAMERA_HEIGHT'),
    warmupSeconds: positive(env.CAMERA_WARMUP_SECONDS, 2, 'CAMERA_WARMUP_SECONDS'),
    deviceId: env.CAMERA_DEVICE_ID?.trim() || 'uno-q-c920',
    connectTimeoutS: positive(env.CAMERA_CONNECT_TIMEOUT_S, 5, 'CAMERA_CONNECT_TIMEOUT_S'),
    remoteScript: env.CAMERA_REMOTE_SCRIPT?.trim() || 'scrap-camera/uno_q_camera.py',
  };
}

export function sshTarget(config: CameraConfig): string {
  return `${config.user}@${config.host}`;
}

/** Key-only, non-interactive SSH options shared by every board command. */
export function sshOptions(config: CameraConfig): string[] {
  return [
    '-i', config.keyPath,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', `ConnectTimeout=${Math.ceil(config.connectTimeoutS)}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
  ];
}

export function sshArgs(config: CameraConfig, remoteCommand: string): string[] {
  return ['-T', ...sshOptions(config), sshTarget(config), remoteCommand];
}

export interface CommandResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** True when the runner killed the command at its timeout. */
  timedOut: boolean;
}

export type CommandRunner = (command: string, args: string[], options: { timeoutMs: number; cwd?: string }) => Promise<CommandResult>;

/** Real runner: no shell, no stdin (so nothing can prompt), killed at the timeout. */
export const spawnRunner: CommandRunner = (command, args, { timeoutMs, cwd }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err, timedOut });
    });
  });

export interface VideoDevice {
  name: string;
  /** /dev/video* nodes listed under this device, in order. */
  nodes: string[];
}

/** Parse `v4l2-ctl --list-devices` (a name line, then indented /dev paths). */
export function parseV4l2Devices(text: string): VideoDevice[] {
  const devices: VideoDevice[] = [];
  let current: VideoDevice | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (/^\s/.test(line)) {
      const node = line.trim();
      if (current && /^\/dev\/video\d+$/.test(node)) current.nodes.push(node);
    } else {
      current = { name: line.trim().replace(/:$/, ''), nodes: [] };
      devices.push(current);
    }
  }
  return devices;
}

/**
 * The capture node for the camera whose name contains `deviceName`: the
 * first /dev/video node under that name (the others are metadata nodes).
 */
export function pickCameraNode(devices: VideoDevice[], deviceName: string): string | undefined {
  const needle = deviceName.toLowerCase();
  return devices.find((d) => d.name.toLowerCase().includes(needle) && d.nodes.length > 0)?.nodes[0];
}

export class CameraError extends Error {
  constructor(
    readonly stage: 'ssh' | 'device' | 'capture' | 'transfer',
    message: string,
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

/** Plain-language reason for a failed SSH command (exit 255 = SSH itself failed). */
export function explainSshFailure(result: CommandResult, config: CameraConfig): string {
  const stderr = result.stderr.trim();
  if (result.timedOut) return `SSH to ${sshTarget(config)} timed out.`;
  if (/Permission denied/i.test(stderr)) {
    return `Key login to ${sshTarget(config)} was refused. Set up the key once with: ssh-copy-id -i ${config.keyPath}.pub ${sshTarget(config)}`;
  }
  if (/timed out|No route to host|Could not resolve|Connection refused|Network is unreachable/i.test(stderr)) {
    return `Cannot reach ${config.host} on port 22 (${stderr.split('\n').at(-1)}). Is the board on and on the same network, and is CAMERA_HOST current?`;
  }
  return `SSH command failed (exit ${result.code}): ${stderr.slice(-500) || 'no error output'}`;
}

/** Runs one command on the board over key-only SSH. */
export async function runOnBoard(
  run: CommandRunner,
  config: CameraConfig,
  remoteCommand: string,
  timeoutMs = 20_000,
): Promise<CommandResult> {
  return run('ssh', sshArgs(config, remoteCommand), { timeoutMs });
}

/** Finds the camera's capture node by name (or returns CAMERA_DEVICE). */
export async function findCameraDevice(run: CommandRunner, config: CameraConfig): Promise<string> {
  if (config.device) return config.device;
  const result = await runOnBoard(run, config, 'v4l2-ctl --list-devices');
  if (result.code === 255 || result.timedOut) throw new CameraError('ssh', explainSshFailure(result, config));
  const devices = parseV4l2Devices(result.stdout.toString('utf8'));
  const node = pickCameraNode(devices, config.deviceName);
  if (!node) {
    const seen = devices.map((d) => d.name).join('; ') || 'none';
    throw new CameraError(
      'device',
      `No camera named "${config.deviceName}" on the board (found: ${seen}). The C920 may need more power: use a powered USB-C hub.`,
    );
  }
  return node;
}

export interface TakenPhoto {
  photoPath: string;
  /** The Uno Q capture UUID (folder name). */
  captureId: string;
  /** This computer's clock right before the trigger: the scan time. */
  triggeredAt: string;
  receivedAt: string;
  device: string;
  sha256: string;
  widthPx: number;
  heightPx: number;
  /** Board-side timestamp, kept only for diagnostics (never the scan time). */
  boardCapturedAt?: string;
}

export interface TakePhotoOptions {
  config: CameraConfig;
  /** Where laptop_capture.py saves the capture (not the --auto inbox). */
  outDir: string;
  /** capture/uno-q/laptop_capture.py */
  laptopCaptureScript: string;
  run?: CommandRunner;
  clock?: () => Date;
  python?: string;
}

/** Triggers one photo on the board and brings it to this computer, verified. */
export async function takePhoto(options: TakePhotoOptions): Promise<TakenPhoto> {
  const run = options.run ?? spawnRunner;
  const clock = options.clock ?? (() => new Date());
  const { config } = options;
  const device = await findCameraDevice(run, config);

  const triggeredAt = clock().toISOString();
  const result = await run(
    options.python ?? 'python3',
    [
      options.laptopCaptureScript,
      '--target', sshTarget(config),
      '--identity', config.keyPath,
      '--once',
      '--device', device,
      '--width', String(config.widthPx),
      '--height', String(config.heightPx),
      '--warmup', String(config.warmupSeconds),
      '--remote-script', config.remoteScript,
      '--out', options.outDir,
    ],
    { timeoutMs: 90_000 },
  );
  const stdout = result.stdout.toString('utf8');
  if (result.code !== 0 || result.timedOut) {
    const detail = `${result.stderr}\n${stdout}`.trim().split('\n').slice(-4).join(' ');
    if (/Permission denied/i.test(detail)) throw new CameraError('ssh', explainSshFailure({ ...result, stderr: detail }, config));
    throw new CameraError('capture', `The board did not return a photo: ${detail || `exit ${result.code}`}`);
  }
  const saved = /^Saved: (.+)$/m.exec(stdout)?.[1]?.trim();
  if (!saved) throw new CameraError('transfer', 'laptop_capture.py finished without saving a photo.');
  const receivedAt = clock().toISOString();

  const photoPath = path.resolve(saved);
  const dir = path.dirname(photoPath);
  const metadata = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8')) as Record<string, unknown>;
  const photo = await readFile(photoPath);
  const sha256 = createHash('sha256').update(photo).digest('hex');
  if (sha256 !== metadata.sha256 || photo.byteLength !== metadata.byteLength) {
    throw new CameraError('transfer', 'The received photo does not match the SHA-256 the board computed.');
  }
  return {
    photoPath,
    captureId: path.basename(dir),
    triggeredAt,
    receivedAt,
    device,
    sha256,
    widthPx: Number(metadata.widthPx),
    heightPx: Number(metadata.heightPx),
    ...(typeof metadata.capturedAt === 'string' ? { boardCapturedAt: metadata.capturedAt } : {}),
  };
}
