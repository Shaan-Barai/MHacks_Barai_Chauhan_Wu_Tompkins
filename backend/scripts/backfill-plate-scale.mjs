/**
 * plate-scale-v1 for scans analyzed before it existed (Run 4, Task 4). For each
 * visible, succeeded capture of a hall whose counted attempt has no
 * plate_scale_estimate row, it re-runs ONLY Gemini pass 1 (the unchanged base
 * localize prompt, with the attempt's own menu version, on the same stored
 * photo) and measures the plate from its dish box (vision measureTargetPlate).
 * The row is attached to the counted attempt with box_source 'backfill-pass1'.
 * No new analysis attempt, no SAM, no measurement changes: Pixels wasted stays
 * exactly as it was. One Gemini call per scan; stops at --max-gemini.
 *
 *   node scripts/backfill-plate-scale.mjs [--hall hall-main] [--max-gemini 10] [--dry-run]
 *   (uses the same .env/database settings as the backend; refuses READ_ONLY=1)
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const dryRun = process.argv.includes('--dry-run');
const hallId = arg('hall', 'hall-main');
const maxGemini = Number(arg('max-gemini', 10));
const { loadConfig } = await import('../dist/backend/src/config.js');
const { buildBackend } = await import('../dist/backend/src/wiring.js');
const { createGeminiGateway, measureTargetPlate } = await import('@scrap/vision');

const config = loadConfig();
if (config.readOnly) {
  console.error('READ_ONLY=1: this site never writes. Run the backfill against the writable database.');
  process.exit(2);
}
const { repo, images, ingestion } = buildBackend({ config });
if (!repo.recordPlateScale || !repo.listPlateScales) {
  console.error('This repository cannot store plate scales (use DATABASE_PROVIDER=supabase).');
  process.exit(2);
}
const gateway = createGeminiGateway();
if (!dryRun && gateway.mode !== 'live') {
  console.error('GEMINI_API_KEY is not set: nothing to measure with.');
  process.exit(2);
}

const captures = (await repo.listCaptureEvents({ hallId })).filter((e) => e.state === 'succeeded'); // hidden captures excluded
const stored = await repo.listPlateScales(captures.map((e) => e.eventId));
const rows = [];
for (const event of captures) {
  const counted = await ingestion.countedAttempt(event.eventId);
  const row = { eventId: event.eventId, attemptId: counted?.attemptId ?? null };
  rows.push(row);
  if (!counted) { row.result = 'skipped: no succeeded attempt'; continue; }
  if (stored.some((p) => p.attemptId === counted.attemptId)) { row.result = 'skipped: already has a plate scale'; continue; }
  const menu = await repo.getMenuByService(event.serviceId);
  if (!menu || menu.service.menuVersion !== counted.menuVersion) {
    row.result = `skipped: menu version ${counted.menuVersion} is no longer the stored one`;
    continue;
  }
  if (dryRun) { row.result = 'would measure (1 Gemini call)'; continue; }
  if (gateway.callCount + 1 > maxGemini) { row.result = `skipped: Gemini cap ${maxGemini} reached`; continue; }
  try {
    const image = await images.readImageBytes(event.imageObjectId);
    const r = await measureTargetPlate(gateway, {
      image: { bytes: new Uint8Array(image.bytes), mimeType: image.mimeType },
      geometry: event.geometry,
      menu: { menuId: menu.service.menuId, menuVersion: menu.service.menuVersion, items: menu.items },
    });
    const p = r.plate;
    await repo.recordPlateScale({
      attemptId: counted.attemptId,
      eventId: event.eventId,
      method: 'plate-scale-v1',
      dishType: p.ok ? 'plate' : (r.dish.dishType ?? null),
      fullyVisible: p.ok ? true : (r.dish.fullyVisible ?? null),
      plateDiameterPx: p.ok ? p.diameterPx : null,
      boxWidthPx: p.ok ? p.boxWidthPx : null,
      boxHeightPx: p.ok ? p.boxHeightPx : null,
      assumedPlateDiameterCm: config.plateDiameterCm ?? 26.7,
      unavailableReason: p.ok ? null : p.reason,
      boxSource: 'backfill-pass1',
      createdAt: new Date().toISOString(),
    });
    Object.assign(row, { result: p.ok ? 'recorded' : `recorded: no usable plate (${p.reason})`, dish: r.dish.dishType ?? 'none',
      fullyVisible: r.dish.fullyVisible ?? null, diameterPx: p.ok ? p.diameterPx : null });
  } catch (err) {
    row.result = `failed: ${err?.apiError?.code ?? err?.message ?? String(err)}`; // nothing recorded
  }
}
console.table(rows);
console.log(`Gemini calls: ${gateway.callCount} (cap ${maxGemini})${dryRun ? ' · dry run: nothing written' : ''}`);
