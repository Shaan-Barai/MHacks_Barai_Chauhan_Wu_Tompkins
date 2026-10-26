/**
 * Re-run captures through the CURRENT pipeline (Gemini classification + SAM 2.1
 * masks + mask_pixel_count measurements), e.g. scans stored by an older
 * pipeline whose 'sam2_mask_pixel_count' rows the dashboard does not count.
 * Each capture gets a NEW analysis attempt on the same event; older attempts
 * and their measurements are kept (nothing is deleted).
 *
 *   node scripts/reanalyze-captures.mjs --legacy [--max-gemini 35] [--dry-run]
 *   node scripts/reanalyze-captures.mjs --event cap_A --event cap_B
 *
 * Needs the same .env as the backend (live GEMINI_API_KEY, the SAM worker).
 * Prints Plates scanned and Pixels wasted per hall (from the dashboard API)
 * before and after, and the Gemini calls used. Stops before the call budget
 * could be exceeded.
 */

import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { values: args } = parseArgs({
  options: {
    legacy: { type: 'boolean', default: false },
    event: { type: 'string', multiple: true, default: [] },
    'max-gemini': { type: 'string', default: '35' },
    'dry-run': { type: 'boolean', default: false },
    start: { type: 'string', default: '2026-09-01' },
    end: { type: 'string', default: '2026-10-31' },
  },
});
const MAX = Number(args['max-gemini']);
/** One capture costs about 2-3 Gemini calls (classify + box passes), more with retries. */
const PER_CAPTURE_HEADROOM = 5;

const { loadConfig } = await import('../dist/backend/src/config.js');
const { buildBackend } = await import('../dist/backend/src/wiring.js');
const { createGeminiGateway } = await import('@scrap/vision');

const config = loadConfig();
if (config.readOnly) {
  console.error('READ_ONLY=1: this site never writes.');
  process.exit(2);
}
const gateway = createGeminiGateway();
if (gateway.mode !== 'live' && !args['dry-run']) {
  console.error('Live Gemini is not configured (GEMINI_API_KEY); nothing would be re-analyzed.');
  process.exit(2);
}
const built = buildBackend({ config, gateway });
const { repo, ingestion } = built;
const server = built.app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function metrics(halls) {
  const out = {};
  for (const hallId of halls) {
    const q = new URLSearchParams({ hallId, start: args.start, end: args.end });
    const impact = await (await fetch(`${base}/api/dashboard/impact?${q}`)).json();
    out[hallId] = {
      platesScanned: impact.totals?.analyzedCaptures ?? null,
      captures: impact.totals?.captures ?? null,
      excluded: impact.totals?.excludedCaptures ?? null,
      pixelsWasted: impact.totals?.pixels ?? null,
    };
  }
  return out;
}

const events = (await repo.listCaptureEvents({ includeHidden: true })).sort((a, b) => a.eventId.localeCompare(b.eventId));
let targets;
if (args.event.length) {
  targets = events.filter((e) => args.event.includes(e.eventId));
} else if (args.legacy) {
  targets = [];
  for (const e of events) {
    const ms = await repo.listMeasurementsByEvent(e.eventId);
    const hasCurrent = ms.some((m) => m.method === 'mask_pixel_count');
    if (!hasCurrent && ms.some((m) => m.method !== 'mask_pixel_count')) targets.push(e);
    else if (!hasCurrent && e.state === 'failed') targets.push(e);
  }
} else {
  console.error('Pass --legacy or --event <id>.');
  process.exit(2);
}
const halls = [...new Set(events.map((e) => e.hallId))].sort();
const before = await metrics(halls);
console.log(`targets (${targets.length}): ${targets.map((e) => `${e.eventId} [${e.hallId}, ${e.state}]`).join(', ')}`);

const results = [];
if (!args['dry-run']) {
  for (const e of targets) {
    if (gateway.callCount + PER_CAPTURE_HEADROOM > MAX) {
      results.push({ eventId: e.eventId, status: 'skipped', reason: `Gemini budget ${MAX} (used ${gateway.callCount})` });
      continue;
    }
    const used = gateway.callCount;
    try {
      const r = await ingestion.reanalyze(e.eventId);
      const px = r.measurements.filter((m) => m.method === 'mask_pixel_count').reduce((s, m) => s + m.remainingAreaPx, 0);
      results.push({ eventId: e.eventId, hallId: e.hallId, state: r.event.state, maskPixels: px, measurements: r.measurements.length, geminiCalls: gateway.callCount - used });
    } catch (err) {
      results.push({ eventId: e.eventId, status: 'error', error: err?.apiError?.code ?? err?.message, geminiCalls: gateway.callCount - used });
    }
    console.log(JSON.stringify(results.at(-1)));
  }
}
const after = await metrics(halls);
server.close();
console.log(JSON.stringify({ geminiCalls: gateway.callCount, budget: MAX, before, after, results }, null, 2));
