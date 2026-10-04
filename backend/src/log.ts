/**
 * Structured JSON-line logs (IT_4 I11). One object per line on stdout/stderr:
 * { ts, level, msg, ...fields }. Never pass secrets, tokens, signed URLs or
 * image bytes; `scrub` strips query strings and signature-like values as a
 * second line of defence.
 */

type Level = 'info' | 'warn' | 'error';

const SECRETISH = /([?&](?:X-Amz-[A-Za-z-]+|token|signature|sig|key)=)[^&\s"']+/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

/** Remove anything that looks like a signature/token from a string. */
export function scrub(text: string): string {
  return text.replace(SECRETISH, '$1[redacted]').replace(BEARER, '$1[redacted]');
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  // SCRAP_LOG_LEVEL=warn (tests) drops info lines; =error keeps errors only; =silent drops everything.
  const min = process.env.SCRAP_LOG_LEVEL;
  if (min === 'silent' || (min === 'warn' && level === 'info') || (min === 'error' && level !== 'error')) return;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) clean[k] = typeof v === 'string' ? scrub(v) : v;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: scrub(msg), ...clean });
  if (level === 'info') console.log(line);
  else console.error(line);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
