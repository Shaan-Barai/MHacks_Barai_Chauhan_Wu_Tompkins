import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Environment configuration (see root .env.example). Server-side only;
 * no credential ever reaches a client or a commit.
 */

export interface SecurityConfig {
  /** NODE_ENV === 'production': secrets are mandatory, cookies Secure, HSTS on. */
  production: boolean;
  /** Bearer token for the camera bridge and scripts (SCRAP_INGEST_TOKEN). */
  ingestToken?: string;
  /** Admin passcode for the dashboard login (SCRAP_ADMIN_PASSCODE). */
  adminPasscode?: string;
  /** HMAC-SHA256 key for admin session cookies (SESSION_SECRET). */
  sessionSecret?: string;
  sessionTtlMs: number;
  /** Secure attribute on the session cookie (default: production). */
  cookieSecure: boolean;
  /** Express 'trust proxy' (TRUST_PROXY): hop count, or false. */
  trustProxy: number | false;
  /** Per-IP login attempts per 15 minutes. */
  loginRateLimit: number;
  /** Per-IP calls per minute to Gemini-cost endpoints (captures, dish-match, recommendation, calibrations). */
  geminiRateLimit: number;
  jsonBodyLimit: string;
}

export interface BackendConfig {
  port: number;
  /** Bind address (HOST); unset = all interfaces. */
  host?: string;
  security?: SecurityConfig;
  /** SERVE_FRONTEND=1: serve the built dashboard (absolute path) with SPA fallback. */
  frontendDist?: string;
  /** Shared secret sent as X-Worker-Token to the SAM worker (WORKER_TOKEN). */
  workerToken?: string;
  objectStorage: {
    provider: string; // 'r2' (Cloudflare R2) or 'local-dev' (offline filesystem)
    container: string;
    localDir: string; // local-dev adapter root; gitignored (.local-storage/)
    allowedMimeTypes: string[];
    maxUploadBytes: number;
    uploadUrlTtlMs: number;
    readUrlTtlMs: number;
    /** Uploads never finalized after this long count as orphans. */
    orphanMaxAgeMs: number;
    /**
     * Prepended to every object key (env R2_KEY_PREFIX), e.g. 'test/' so
     * tests write under one prefix they can delete afterwards. '' in normal use.
     */
    keyPrefix?: string;
    /** Cloudflare R2 credentials (provider 'r2'); server-side only. */
    r2?: { accountId: string; accessKeyId: string; secretAccessKey: string; endpoint?: string };
  };
  /** Optional JSON persistence file for the offline/test repository. */
  dataFile?: string;
  /** SAM 2.1 segmentation worker (vision/sam/worker.py). */
  samWorkerUrl: string;
  /** SpacetimeDB persistence; when unset the JSON/in-memory repository is used. */
  spacetime?: { uri: string; module: string; token?: string };
  attendance: { min: number; max: number; seed?: string };
  /** DEMO_SEED=1: fill ~14 days of labeled sample history at startup (idempotent). */
  demoSeed?: boolean;
  /**
   * READ_ONLY=1: the public offsite site (docs/deploy-server.md). Only reads are
   * served; every mutation, Try an Image and the camera answer 403 READ_ONLY,
   * and Gemini/SAM are never called. Auth secrets are not required.
   */
  readOnly?: boolean;
}

function int(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid integer for env var ${name}`);
  }
  return Math.floor(n);
}

/** '' or one or more `segment/` parts of letters, digits, '-' or '_' (e.g. 'test/'). */
export function keyPrefix(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') return '';
  const withSlash = value.endsWith('/') ? value : `${value}/`;
  if (!/^([A-Za-z0-9_-]+\/)+$/.test(withSlash)) {
    throw new Error("R2_KEY_PREFIX must look like 'test/' (letters, digits, '-', '_', separated by '/').");
  }
  return withSlash;
}

/** The backend package root (…/backend/), from dist/backend/src/config.js or src/config.ts. */
function backendRoot(): string {
  const here = fileURLToPath(import.meta.url);
  const marker = `${sep}backend${sep}`;
  const at = here.lastIndexOf(`${sep}dist${marker}`);
  return at >= 0 ? here.slice(0, at + 1) : resolve(dirname(here), '..');
}

export function loadSecurity(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const production = env.NODE_ENV === 'production';
  const trust = env.TRUST_PROXY;
  return {
    production,
    ingestToken: env.SCRAP_INGEST_TOKEN || undefined,
    adminPasscode: env.SCRAP_ADMIN_PASSCODE || undefined,
    sessionSecret: env.SESSION_SECRET || undefined,
    sessionTtlMs: int('SESSION_TTL_HOURS', 12, env) * 3600 * 1000,
    cookieSecure: env.SESSION_COOKIE_SECURE ? env.SESSION_COOKIE_SECURE !== '0' && env.SESSION_COOKIE_SECURE !== 'false' : production,
    trustProxy: trust === undefined || trust === '' || trust === 'false' || trust === '0' ? false : Number.isFinite(Number(trust)) ? Number(trust) : 1,
    loginRateLimit: int('RATE_LIMIT_LOGIN_PER_15MIN', 10, env),
    geminiRateLimit: int('RATE_LIMIT_GEMINI_PER_MIN', 30, env),
    jsonBodyLimit: env.JSON_BODY_LIMIT || '1mb',
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const serveFrontend = env.SERVE_FRONTEND === '1' || env.SERVE_FRONTEND === 'true';
  return {
    port: int('PORT', 8787, env),
    host: env.HOST || undefined,
    security: loadSecurity(env),
    frontendDist: serveFrontend
      ? env.FRONTEND_DIST
        ? resolve(process.cwd(), env.FRONTEND_DIST)
        : resolve(backendRoot(), '../frontend/dist')
      : undefined,
    workerToken: env.WORKER_TOKEN || undefined,
    objectStorage: {
      provider: env.OBJECT_STORAGE_PROVIDER ?? 'local-dev',
      container: env.OBJECT_STORAGE_CONTAINER ?? 'scrap-images',
      localDir: env.OBJECT_STORAGE_LOCAL_DIR ?? '.local-storage',
      keyPrefix: keyPrefix(env.R2_KEY_PREFIX),
      allowedMimeTypes: (env.UPLOAD_ALLOWED_MIME_TYPES ?? 'image/jpeg,image/png,image/webp')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      maxUploadBytes: int('UPLOAD_MAX_BYTES', 10 * 1024 * 1024, env),
      uploadUrlTtlMs: int('UPLOAD_URL_TTL_SECONDS', 15 * 60, env) * 1000,
      readUrlTtlMs: int('READ_URL_TTL_SECONDS', 10 * 60, env) * 1000,
      orphanMaxAgeMs: int('ORPHAN_MAX_AGE_SECONDS', 60 * 60, env) * 1000,
      r2:
        env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
          ? {
              accountId: env.R2_ACCOUNT_ID,
              accessKeyId: env.R2_ACCESS_KEY_ID,
              secretAccessKey: env.R2_SECRET_ACCESS_KEY,
              endpoint: env.R2_ENDPOINT || undefined,
            }
          : undefined,
    },
    dataFile: env.BACKEND_DATA_FILE || undefined,
    samWorkerUrl: env.SAM_WORKER_URL || 'http://127.0.0.1:8790',
    spacetime: env.SPACETIMEDB_URI
      ? {
          uri: env.SPACETIMEDB_URI,
          module: env.SPACETIMEDB_MODULE || 'scrap',
          token: env.SPACETIMEDB_TOKEN || undefined,
        }
      : undefined,
    attendance: {
      min: int('ATTENDANCE_MIN', 300, env),
      max: int('ATTENDANCE_MAX', 1200, env),
      seed: env.ATTENDANCE_SEED || undefined,
    },
    demoSeed: env.DEMO_SEED === '1' || env.DEMO_SEED === 'true',
    readOnly: env.READ_ONLY === '1' || env.READ_ONLY === 'true',
  };
}
