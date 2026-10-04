/**
 * Environment configuration (see root .env.example). Server-side only;
 * no credential ever reaches a client or a commit.
 */

export interface BackendConfig {
  port: number;
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
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  return {
    port: int('PORT', 8787),
    objectStorage: {
      provider: env.OBJECT_STORAGE_PROVIDER ?? 'local-dev',
      container: env.OBJECT_STORAGE_CONTAINER ?? 'scrap-images',
      localDir: env.OBJECT_STORAGE_LOCAL_DIR ?? '.local-storage',
      keyPrefix: keyPrefix(env.R2_KEY_PREFIX),
      allowedMimeTypes: (env.UPLOAD_ALLOWED_MIME_TYPES ?? 'image/jpeg,image/png,image/webp')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      maxUploadBytes: int('UPLOAD_MAX_BYTES', 10 * 1024 * 1024),
      uploadUrlTtlMs: int('UPLOAD_URL_TTL_SECONDS', 15 * 60) * 1000,
      readUrlTtlMs: int('READ_URL_TTL_SECONDS', 10 * 60) * 1000,
      orphanMaxAgeMs: int('ORPHAN_MAX_AGE_SECONDS', 60 * 60) * 1000,
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
      min: int('ATTENDANCE_MIN', 300),
      max: int('ATTENDANCE_MAX', 1200),
      seed: env.ATTENDANCE_SEED || undefined,
    },
  };
}
