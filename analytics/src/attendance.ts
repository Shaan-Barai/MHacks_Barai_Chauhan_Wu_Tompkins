/**
 * Simulated attendance (AGENTS.md 6.2–6.3).
 *
 * Pure, reproducible generator. Caller (Agent 5) must persist the result and
 * never re-roll on each dashboard request. Every value is labeled `simulated`.
 */

import type { Attendance } from './contracts.js';

export const ATTENDANCE_GENERATOR_VERSION = 'attendance-gen-v1';
export const DEFAULT_ATTENDANCE_MIN = 300;
export const DEFAULT_ATTENDANCE_MAX = 1200;

export interface AttendanceConfig {
  hallId: string;
  serviceId: string;
  serviceDate: string;
  /** Inclusive lower bound. Defaults to ATTENDANCE_MIN env or 300. */
  min?: number;
  /** Inclusive upper bound. Defaults to ATTENDANCE_MAX env or 1200. */
  max?: number;
  /**
   * Optional explicit seed. When omitted, a deterministic key is derived from
   * hallId + serviceId + serviceDate so fixtures stay reproducible.
   */
  seed?: string;
  /** Injectable env for tests. */
  env?: Record<string, string | undefined>;
}

/** FNV-1a 32-bit hash — small, dependency-free, stable across Node versions. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG — deterministic given a 32-bit seed. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function parseBound(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function resolveBounds(
  min: number | undefined,
  max: number | undefined,
  env: Record<string, string | undefined>,
): { min: number; max: number } {
  const resolvedMin = min ?? parseBound(env['ATTENDANCE_MIN'], DEFAULT_ATTENDANCE_MIN);
  const resolvedMax = max ?? parseBound(env['ATTENDANCE_MAX'], DEFAULT_ATTENDANCE_MAX);
  if (!Number.isInteger(resolvedMin) || !Number.isInteger(resolvedMax)) {
    throw new Error('Attendance bounds must be integers.');
  }
  if (resolvedMin < 0 || resolvedMax < 0) {
    throw new Error('Attendance bounds must be non-negative.');
  }
  if (resolvedMin > resolvedMax) {
    throw new Error(`Attendance min (${resolvedMin}) exceeds max (${resolvedMax}).`);
  }
  return { min: resolvedMin, max: resolvedMax };
}

/**
 * Configured seed stored on the Attendance record (fixture/env label).
 * Empty/omitted means "derive from hall+service+date only".
 */
export function resolveAttendanceSeed(
  cfg: Pick<AttendanceConfig, 'hallId' | 'serviceId' | 'serviceDate' | 'seed' | 'env'>,
): string {
  const env = cfg.env ?? process.env;
  if (cfg.seed !== undefined && cfg.seed !== '') {
    return cfg.seed;
  }
  const envSeed = env['ATTENDANCE_SEED'];
  if (envSeed !== undefined && envSeed !== '') {
    return envSeed;
  }
  return `${cfg.hallId}|${cfg.serviceId}|${cfg.serviceDate}`;
}

/**
 * PRNG material always includes hall/service/date so one demo seed still
 * yields a distinct (but reproducible) count per service.
 */
export function attendanceEntropyKey(
  cfg: Pick<AttendanceConfig, 'hallId' | 'serviceId' | 'serviceDate' | 'seed' | 'env'>,
): string {
  const configured = resolveAttendanceSeed(cfg);
  const serviceKey = `${cfg.hallId}|${cfg.serviceId}|${cfg.serviceDate}`;
  // When the configured seed is already the bare service key, do not double it.
  if (configured === serviceKey) return `${ATTENDANCE_GENERATOR_VERSION}|${serviceKey}`;
  return `${ATTENDANCE_GENERATOR_VERSION}|${configured}|${serviceKey}`;
}

/**
 * Generate one simulated attendance value for a hall/date/service.
 * Same inputs always produce the same count.
 */
export function generateAttendance(cfg: AttendanceConfig): Attendance {
  const env = cfg.env ?? process.env;
  const { min, max } = resolveBounds(cfg.min, cfg.max, env);
  const seed = resolveAttendanceSeed(cfg);
  const span = max - min + 1;
  const rng = mulberry32(hashString(attendanceEntropyKey(cfg)));
  const count = min + Math.floor(rng() * span);

  const result: Attendance = {
    hallId: cfg.hallId,
    serviceId: cfg.serviceId,
    serviceDate: cfg.serviceDate,
    count,
    source: 'simulated',
    configuredMin: min,
    configuredMax: max,
    seed,
    generatorVersion: ATTENDANCE_GENERATOR_VERSION,
  };
  return result;
}

/**
 * In-memory cache so callers that forget to persist still avoid re-rolling
 * within a process. Prefer Agent 5 persistence over this helper for demos.
 */
export class AttendanceCache {
  private readonly store = new Map<string, Attendance>();

  private key(hallId: string, serviceId: string, serviceDate: string): string {
    return `${hallId}|${serviceId}|${serviceDate}`;
  }

  get(hallId: string, serviceId: string, serviceDate: string): Attendance | undefined {
    return this.store.get(this.key(hallId, serviceId, serviceDate));
  }

  /** Return existing value or generate+store one. Never regenerates. */
  getOrCreate(cfg: AttendanceConfig): Attendance {
    const k = this.key(cfg.hallId, cfg.serviceId, cfg.serviceDate);
    const existing = this.store.get(k);
    if (existing !== undefined) return existing;
    const created = generateAttendance(cfg);
    this.store.set(k, created);
    return created;
  }

  put(attendance: Attendance): void {
    this.store.set(this.key(attendance.hallId, attendance.serviceId, attendance.serviceDate), attendance);
  }

  clear(): void {
    this.store.clear();
  }
}
