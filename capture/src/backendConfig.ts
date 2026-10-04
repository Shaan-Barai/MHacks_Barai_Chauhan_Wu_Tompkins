/**
 * Which backend the capture scripts talk to, and how they authenticate
 * (IT_4 I11). Shared by ingest-inbox, calibrate, simulate-camera and replay.
 *
 *   SCRAP_API_URL        backend base URL (https in production). Default http://localhost:8787.
 *                        API_URL is still read as a fallback for older shells/scripts.
 *   SCRAP_INGEST_TOKEN   bearer token for mutations. Another variable can be named with
 *                        --token-env NAME. When it is not in the environment, the scripts read it
 *                        from the repo .env, then deploy/.run/local-secrets.env (written by
 *                        deploy/local.sh). Never logged; describe() only says where it came from.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_API_URL = 'http://localhost:8787';
export const DEFAULT_TOKEN_ENV = 'SCRAP_INGEST_TOKEN';

export interface BackendConfig {
  apiUrl: string;
  /** Bearer token for mutating requests, or undefined (local dev without auth). */
  token: string | undefined;
  tokenEnv: string;
  /** Where the token came from (env var name or file), for logs. Never the value. */
  tokenSource: string | undefined;
  /** Non-fatal configuration problems worth printing once. */
  warnings: string[];
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** One KEY=value from a dotenv-style file, or undefined. Never logged. */
export function readEnvFile(file: string, key: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    if (eq <= 0 || line.slice(0, eq).trim() !== key) continue;
    const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    return value || undefined;
  }
  return undefined;
}

/**
 * Token files the scripts fall back to, in order: the repo `.env`, then the
 * secrets `deploy/local.sh` generates (`deploy/.run/local-secrets.env`).
 */
export function defaultTokenFiles(repoRoot: string): string[] {
  return [path.join(repoRoot, '.env'), path.join(repoRoot, 'deploy', '.run', 'local-secrets.env')];
}

export function resolveBackend(
  env: Record<string, string | undefined> = process.env,
  tokenEnv: string = DEFAULT_TOKEN_ENV,
  tokenFiles: readonly string[] = [],
): BackendConfig {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new Error(`--token-env must name an environment variable, got "${tokenEnv}".`);
  }
  const raw = (env.SCRAP_API_URL || env.API_URL || DEFAULT_API_URL).trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`SCRAP_API_URL is not a URL: "${raw}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SCRAP_API_URL must be http(s), got "${parsed.protocol}".`);
  }
  const apiUrl = raw.replace(/\/+$/, '');
  let token = env[tokenEnv]?.trim() || undefined;
  let tokenSource = token ? tokenEnv : undefined;
  for (const file of tokenFiles) {
    if (token) break;
    token = readEnvFile(file, tokenEnv);
    if (token) tokenSource = `${tokenEnv} in ${path.basename(path.dirname(file)) === '.run' ? 'deploy/.run/' : ''}${path.basename(file)}`;
  }
  const warnings: string[] = [];
  if (token && parsed.protocol === 'http:' && !isLocalUrl(apiUrl)) {
    warnings.push(`${apiUrl} is plain http: the ingest token would travel unencrypted. Use https.`);
  }
  if (!token && !isLocalUrl(apiUrl)) {
    warnings.push(`${tokenEnv} is not set: a production backend will refuse uploads (401).`);
  }
  return { apiUrl, token, tokenEnv, tokenSource, warnings };
}

/** One line for logs. Says whether a token is set, never what it is. */
export function describeBackend(config: BackendConfig): string {
  return `${config.apiUrl} (${config.token ? `token from ${config.tokenSource ?? config.tokenEnv}` : 'no token'})`;
}

/** `Authorization` header for backend requests (empty without a token). */
export function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
