/**
 * Re-run analysis for captures whose analysis failed (e.g. Gemini billing
 * ran out mid-run). Re-submits each failed event with the SAME eventId, so the
 * backend appends a new analysis attempt to the existing capture; it never
 * creates a second capture (ingestionService idempotency).
 *
 *   node scripts/retry-failed.mjs --start 2026-10-04 --end 2026-10-04 [--hall hall-main] [--dry-run]
 *   API_URL=http://localhost:8787 (default)
 */

import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    start: { type: 'string' },
    end: { type: 'string' },
    hall: { type: 'string', default: 'hall-main' },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!args.start || !args.end) {
  console.error('usage: retry-failed.mjs --start YYYY-MM-DD --end YYYY-MM-DD [--hall hall-main] [--dry-run]');
  process.exit(2);
}
const api = (process.env.API_URL ?? 'http://localhost:8787').replace(/\/$/, '');

async function getJson(path, init) {
  const res = await fetch(`${api}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${body?.error?.code ?? ''}`);
  return body;
}

const q = new URLSearchParams({ start: args.start, end: args.end, hallId: args.hall, limit: '200' });
const list = await getJson(`/api/captures?${q}`);
const captures = Array.isArray(list) ? list : list.captures ?? [];
const failed = captures.filter((c) => c.state === 'failed' || c.state === 'needs_review');
console.log(`${failed.length} of ${captures.length} captures need a retry (${args.start}..${args.end}, ${args.hall}).`);

let ok = 0;
for (const c of failed) {
  const { event } = await getJson(`/api/captures/${encodeURIComponent(c.eventId)}`);
  if (args['dry-run']) {
    console.log(`  would retry ${event.eventId} (${event.state})`);
    continue;
  }
  const submission = {
    eventId: event.eventId,
    hallId: event.hallId,
    serviceId: event.serviceId,
    capturedAt: event.capturedAt,
    imageObjectId: event.imageObjectId,
    geometry: event.geometry,
    source: event.source,
    qualityFlags: event.qualityFlags,
  };
  try {
    const result = await getJson('/api/captures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submission),
    });
    const err = result.attempt?.error?.code;
    console.log(`  ${event.eventId} -> ${result.event.state}${err ? ` (${err})` : ''}`);
    if (result.event.state === 'succeeded') ok++;
  } catch (e) {
    console.log(`  ${event.eventId} -> request failed: ${e.message}`);
  }
}
if (!args['dry-run']) console.log(`Done: ${ok} of ${failed.length} now succeeded.`);
