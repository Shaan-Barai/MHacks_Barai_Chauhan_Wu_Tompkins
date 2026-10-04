/**
 * Production hardening (IT_4 I11): auth for mutations, admin sessions,
 * per-IP rate limits, and security headers. No new dependencies: the cookie
 * is HMAC-SHA256 signed with node:crypto and the headers are a small
 * helmet-equivalent set.
 *
 * Auth model:
 *  - Reads (GET/HEAD/OPTIONS) are public (the live demo).
 *  - Every other /api request needs `Authorization: Bearer $SCRAP_INGEST_TOKEN`
 *    (camera bridge, scripts) or a valid admin session cookie (dashboard).
 *  - Exempt: login/logout, and the local-dev upload PUT (already authorized by
 *    its single-use upload token, like an R2 presigned URL).
 *  - Dev (`NODE_ENV !== 'production'`) with neither token nor passcode set:
 *    open, with a startup warning. Production without the three secrets
 *    refuses to start (assertSecurity).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { apiError } from '../errors.js';
import { log } from '../log.js';
import type { SecurityConfig } from '../config.js';

export const SESSION_COOKIE = 'scrap_session';
const SESSION_VERSION = 'v1';

export type Principal = 'ingest' | 'admin' | 'open' | null;

/** Constant-time string equality (hash first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

let warnedOpen = false;

/** The effective security settings, with dev defaults filled in. */
export interface ResolvedSecurity extends SecurityConfig {
  /** No secrets configured in dev: mutations are open. */
  open: boolean;
  sessionSecret: string;
}

/**
 * Validate and resolve. Production requires SCRAP_INGEST_TOKEN,
 * SCRAP_ADMIN_PASSCODE and SESSION_SECRET (≥ 16 chars) and throws otherwise.
 */
export function assertSecurity(sec: SecurityConfig | undefined): ResolvedSecurity {
  const s: SecurityConfig = sec ?? {
    production: false,
    sessionTtlMs: 12 * 3600 * 1000,
    cookieSecure: false,
    trustProxy: false,
    loginRateLimit: 10,
    geminiRateLimit: 30,
    jsonBodyLimit: '1mb',
  };
  if (s.production) {
    const missing = [
      !s.ingestToken && 'SCRAP_INGEST_TOKEN',
      !s.adminPasscode && 'SCRAP_ADMIN_PASSCODE',
      (!s.sessionSecret || s.sessionSecret.length < 16) && 'SESSION_SECRET (at least 16 characters)',
    ].filter(Boolean);
    if (missing.length) {
      throw new Error(`NODE_ENV=production requires ${missing.join(', ')}. Refusing to start without auth.`);
    }
  }
  const open = !s.production && !s.ingestToken && !s.adminPasscode;
  let sessionSecret = s.sessionSecret;
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString('hex');
    if (s.adminPasscode) log.warn('SESSION_SECRET is not set; admin sessions use a per-process key and end on restart.');
  }
  if (open && !warnedOpen) {
    warnedOpen = true;
    log.warn('Auth is OPEN (development, no SCRAP_INGEST_TOKEN or SCRAP_ADMIN_PASSCODE set): anyone can call mutations.');
  }
  return { ...s, open, sessionSecret };
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueSession(sec: ResolvedSecurity, nowMs: number): { value: string; expiresAt: number } {
  const expiresAt = nowMs + sec.sessionTtlMs;
  const payload = `${SESSION_VERSION}.${expiresAt}.${randomBytes(12).toString('base64url')}`;
  return { value: `${payload}.${sign(sec.sessionSecret, payload)}`, expiresAt };
}

export function verifySession(sec: ResolvedSecurity, value: string | undefined, nowMs: number, revoked: Set<string>): boolean {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return false;
  const payload = parts.slice(0, 3).join('.');
  if (!safeEqual(sign(sec.sessionSecret, payload), parts[3]!)) return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp <= nowMs) return false;
  return !revoked.has(parts[2]!);
}

export function sessionNonce(value: string | undefined): string | undefined {
  return value?.split('.')[2];
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function sessionCookie(sec: ResolvedSecurity, value: string, maxAgeMs: number): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
    ...(sec.cookieSecure ? ['Secure'] : []),
  ].join('; ');
}

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Who is calling (independent of whether this route needs auth). */
export function principalOf(sec: ResolvedSecurity, req: Request, nowMs: number, revoked: Set<string>): Principal {
  const token = bearer(req);
  if (token && sec.ingestToken && safeEqual(token, sec.ingestToken)) return 'ingest';
  if (verifySession(sec, readCookie(req, SESSION_COOKIE), nowMs, revoked)) return 'admin';
  if (sec.open) return 'open';
  return null;
}

/** Exact mutation routes that never need auth. */
function isExempt(req: Request): boolean {
  if (req.path === '/api/auth/login' || req.path === '/api/auth/logout') return true;
  // Public 'Try an Image' upload: capped by rate limits and a global hourly cap, never stored.
  if (req.method === 'POST' && req.path === '/api/try-image') return true;
  // local-dev stand-in for a presigned PUT: authorized by its own upload token.
  return req.method === 'PUT' && req.path.startsWith('/api/storage/upload/');
}

/**
 * Gate every /api mutation. A cookie-authenticated request whose Origin is a
 * different host is refused (defence in depth on top of SameSite=Strict).
 */
export function authGate(sec: ResolvedSecurity, now: () => number, revoked: Set<string>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const principal = principalOf(sec, req, now(), revoked);
    res.locals.principal = principal;
    if (!req.path.startsWith('/api/') || SAFE_METHODS.has(req.method) || isExempt(req)) return next();
    if (principal === null) {
      res.status(401).json({
        error: apiError('AUTH_REQUIRED', 'Sign in as an admin (or send the ingest token) to make changes.', false),
      });
      return;
    }
    if (principal === 'admin') {
      const origin = req.headers.origin;
      if (typeof origin === 'string' && origin !== 'null') {
        let host: string | undefined;
        try {
          host = new URL(origin).host;
        } catch {
          host = undefined;
        }
        if (host !== req.headers.host) {
          res.status(403).json({ error: apiError('ORIGIN_MISMATCH', 'This request came from another site.', false) });
          return;
        }
      }
    }
    next();
  };
}

/** Fixed-window in-memory counter keyed by client + bucket. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Returns 0 when allowed, else the seconds to wait. */
  take(key: string, limit: number, windowMs: number): number {
    const t = this.now();
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + windowMs });
      return 0;
    }
    if (entry.count >= limit) return Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
    entry.count += 1;
    return 0;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function rateLimit(
  limiter: RateLimiter,
  bucket: string,
  limit: (req: Request, res: Response) => number,
  windowMs: number,
): RequestHandler {
  return (req, res, next) => {
    const max = limit(req, res);
    if (max <= 0) return next();
    const wait = limiter.take(`${bucket}|${clientIp(req)}`, max, windowMs);
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      res.status(429).json({
        error: apiError('RATE_LIMITED', 'Too many requests. Please wait a moment and try again.', true, {
          retryAfterSeconds: wait,
        }),
      });
      return;
    }
    next();
  };
}

/**
 * helmet-equivalent headers. The CSP allows the dashboard's own origin plus
 * the object-storage origin(s) the browser talks to directly (presigned R2
 * GET for images, presigned PUT for uploads).
 */
export function securityHeaders(opts: { production: boolean; storageOrigins: string[] }): RequestHandler {
  const storage = opts.storageOrigins.join(' ');
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${storage}`.trim(),
    `connect-src 'self' ${storage}`.trim(),
    "font-src 'self' data:",
  ].join('; ');
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (opts.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}
