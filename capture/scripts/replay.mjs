/**
 * Replay labeled capture manifests into a running backend:
 *   normalize → upload → finalize → POST /api/captures (analysis runs there).
 *
 *   npm run replay                         # every fixtures/replay/demo-*.json
 *   npm run replay -- path/to/manifest.json [more.json …]
 *   API_URL=http://host:port npm run replay
 *
 * Event IDs are kept in .replay-state.json, so running it again re-submits
 * the same dishes (deduplicated by the backend) instead of adding new ones.
 * Delete that file only together with a fresh database.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpIngestionSink, HttpUploader, ReplayCaptureAdapter } from '../dist/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const api = (process.env.API_URL ?? 'http://localhost:8787').replace(/\/$/, '');

let manifests = process.argv.slice(2);
if (manifests.length === 0) {
  const dir = path.join(root, 'fixtures/replay');
  manifests = readdirSync(dir)
    .filter((f) => /^demo-.*\.json$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

try {
  await fetch(`${api}/api/health`);
} catch {
  console.error(`No backend at ${api}. Start it first (cd backend && npm start).`);
  process.exit(1);
}

const sink = new HttpIngestionSink(api);
const adapter = new ReplayCaptureAdapter(new HttpUploader(api), sink, {
  stateFile: path.join(root, '.replay-state.json'),
});

let failed = 0;
for (const manifest of manifests) {
  console.log(`\n${path.relative(process.cwd(), manifest)}`);
  for (const result of await adapter.ingestManifestFile(manifest)) {
    if (!result.ok) {
      failed++;
      console.log(`  ✗ ${result.entryId}: ${result.error.code} — ${result.error.message}`);
      continue;
    }
    const outcome = sink.outcomes.get(result.event.eventId);
    const state = result.alreadyIngested ? 'already ingested' : outcome?.deduplicated ? 'deduplicated' : outcome?.state;
    console.log(`  ✓ ${result.entryId} → ${result.event.eventId} (${state})`);
  }
}
process.exit(failed === 0 ? 0 : 1);
