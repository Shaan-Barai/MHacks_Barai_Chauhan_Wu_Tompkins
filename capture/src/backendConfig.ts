/**
 * Which backend the capture scripts talk to, and how they authenticate
 * (IT_4 I11). Shared by ingest-inbox, calibrate, simulate-camera and replay.
 *
 *   SCRAP_API_URL        backend base URL (https in production). Default http://localhost:8787.
 *                        API_URL is still read as a fallback for older shells/scripts.
 *   SCRAP_INGEST_TOKEN   bearer token for mutations. Another variable can be named with
 *                        --token-env NAME. Never logged; describe() only says whether it is set.
 */

export const DEFAULT_API_URL = 'http://localhost:8787';
export const DEFAULT_TOKEN_ENV = 'SCRAP_INGEST_TOKEN';

export interface BackendConfig {
  apiUrl: string;
  /** Bearer token for mutating requests, or undefined (local dev without auth). */
  token: string | undefined;
  tokenEnv: string;
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

export function resolveBackend(
  env: Record<string, string | undefined> = process.env,
  tokenEnv: string = DEFAULT_TOKEN_ENV,
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
  const token = env[tokenEnv]?.trim() || undefined;
  const warnings: string[] = [];
  if (token && parsed.protocol === 'http:' && !isLocalUrl(apiUrl)) {
    warnings.push(`${apiUrl} is plain http: the ingest token would travel unencrypted. Use https.`);
  }
  if (!token && !isLocalUrl(apiUrl)) {
    warnings.push(`${tokenEnv} is not set: a production backend will refuse uploads (401).`);
  }
  return { apiUrl, token, tokenEnv, warnings };
}

/** One line for logs. Says whether a token is set, never what it is. */
export function describeBackend(config: BackendConfig): string {
  return `${config.apiUrl} (${config.token ? `token from ${config.tokenEnv}` : 'no token'})`;
}

/** `Authorization` header for backend requests (empty without a token). */
export function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
