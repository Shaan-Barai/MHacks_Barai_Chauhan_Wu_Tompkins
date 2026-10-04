/** Entry point: `npm start` (builds then runs dist). */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildBackend } from './wiring.js';

// Load the repo-root .env (server-side secrets) when present; real env vars win.
const envFile = fileURLToPath(new URL('../../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { app, config, demo } = buildBackend();

app.listen(config.port, () => {
  const persistence = config.spacetime ? `SpacetimeDB ${config.spacetime.module}` : 'in-memory/JSON';
  const vision = process.env.GEMINI_API_KEY
    ? `Gemini classification + SAM 2.1 masks (${config.samWorkerUrl})`
    : 'mock analyzer';
  console.log(
    `[backend] Scrap API listening on port ${config.port} (storage: ${config.objectStorage.provider}, persistence: ${persistence}, vision: ${vision})`,
  );
  // DEMO_SEED=1: fill ~14 days of labeled sample history (skips slots already filled).
  if (config.demoSeed && demo) {
    const endDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit' }).format(new Date());
    demo
      .seedHistory({ hallId: process.env.HALL_ID || 'hall-main', endDate })
      .then((r) => console.log(`[backend] Sample history: ${r.services} services, ${r.captures} sample scans added (remove with npm run demo:clear).`))
      .catch((e) => console.error(`[backend] Sample history failed: ${e instanceof Error ? e.message : String(e)}`));
  }
});
