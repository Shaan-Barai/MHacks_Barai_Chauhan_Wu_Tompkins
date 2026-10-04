/**
 * Replay labeled capture manifests into a running backend:
 *   normalize → upload → finalize → POST /api/captures (analysis runs there).
 *
 *   npm run replay                         # every fixtures/replay/demo-*.json
 *   npm run replay -- path/to/manifest.json [more.json …]
 *   SCRAP_API_URL=https://host npm run replay   (API_URL still works)
 *   SCRAP_INGEST_TOKEN=…  bearer token for the uploads (or --token-env NAME); never printed
 *
 * Event IDs are kept in .replay-state.json, so running it again re-submits
 * the same dishes (deduplicated by the backend) instead of adding new ones.
 * Delete that file only together with a fresh database.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  HttpIngestionSink,
  HttpUploader,
  ReplayCaptureAdapter,
  describeBackend,
  resolveBackend,
} from '../dist/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'token-env': { type: 'string' } },
});
let backend;
try {
  backend = resolveBackend(process.env, options['token-env']);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
for (const warning of backend.warnings) console.error(`! ${warning}`);
const api = backend.apiUrl;
const client = { token: backend.token };

let manifests = positionals;
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

console.log(`Backend: ${describeBackend(backend)}`);
const sink = new HttpIngestionSink(api, client);
const adapter = new ReplayCaptureAdapter(new HttpUploader(api, client), sink, {
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
