/**
 * Live Gemini smoke test (README "Live smoke test"). Makes real API calls.
 *
 *   cd vision && npm run build
 *   node --env-file=../.env scripts/smoke.mjs [image.jpg] [serviceId]
 *
 * Checks: live mode, generateText, analyzeCapture on a top-down photo against
 * the demo-seed menu + baselines, and that a bad key fails fast with
 * GEMINI_AUTH_FAILED (no retries). Never prints the key.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGeminiGateway, analyzeCapture } from '../dist/src/index.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const image = process.argv[2] ?? here('../../capture/fixtures/replay/images/dinner-1003-salmon-rice.jpg');
const serviceId = process.argv[3] ?? 'svc_hall-main_2026-10-03_dinner';

const seed = JSON.parse(readFileSync(here('../../data/seed/demo-seed.json'), 'utf8'));
const menu = seed.menus.find((m) => m.service.serviceId === serviceId);
if (!menu) throw new Error(`No demo-seed menu for ${serviceId}`);
const itemIds = new Set(menu.items.map((i) => i.itemId));
const baselines = seed.referencePortions.filter((r) => itemIds.has(r.itemId));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const gateway = createGeminiGateway();
check('gateway is live', gateway.mode === 'live', `mode=${gateway.mode} model=${gateway.model}`);

const text = await gateway.generateText('Reply with the word OK.');
check('generateText', /\bOK\b/i.test(text), JSON.stringify(text.slice(0, 40)));

// Suggestions use maxOutputTokens 220; thinking must not eat that budget.
const tip = await gateway.generateText('In two sentences, suggest how a dining hall could reduce leftover rice.', {
  maxOutputTokens: 220,
});
check('short tip not truncated', /[.!?]["')]?\s*$/.test(tip.trim()), JSON.stringify(tip.slice(0, 80)));

const result = await analyzeCapture(gateway, {
  eventId: 'cap_smoke',
  attemptId: 'att_smoke',
  image: { kind: 'bytes', bytes: readFileSync(image), mimeType: 'image/jpeg' },
  geometry: { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1', plateShape: 'round' },
  menu: { menuId: menu.service.menuId, menuVersion: menu.service.menuVersion, items: menu.items },
  baselines,
});
const { attempt, measurements } = result;
check('analyzeCapture status', attempt.status !== 'failed', `${attempt.status}${attempt.error ? ` ${attempt.error.code}` : ''}`);
check('attempt.model matches config', attempt.model === gateway.model, attempt.model);
const names = new Map(menu.items.map((i) => [i.itemId, i.displayName]));
for (const m of measurements) {
  console.log(
    `      ${m.itemId ? names.get(m.itemId) : 'unknown food'}: ${Math.round(m.remainingAreaPx)} px` +
      (m.displayWastePercent !== undefined ? ` (${m.displayWastePercent.toFixed(1)}% of baseline)` : ` (${m.unavailableReason})`) +
      (m.qualityFlags.length ? ` [${m.qualityFlags.join(', ')}]` : ''),
  );
}
check(
  'areas finite and within the 1024x1024 frame',
  measurements.every((m) => Number.isFinite(m.remainingAreaPx) && m.remainingAreaPx >= 0 && m.remainingAreaPx <= 1024 * 1024),
);

const bad = createGeminiGateway({ apiKey: 'invalid-key-for-smoke-test', retryBaseDelayMs: 1 });
try {
  await bad.generateText('Reply with the word OK.');
  check('bad key rejected', false, 'call unexpectedly succeeded');
} catch (err) {
  const code = err?.apiError?.code ?? err?.code;
  check('bad key -> GEMINI_AUTH_FAILED', code === 'GEMINI_AUTH_FAILED', String(code));
  check('bad key not retried', bad.callCount === 1, `calls=${bad.callCount}`);
}

console.log(failures === 0 ? '\nLive smoke test passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
