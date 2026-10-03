/** Entry point: `npm start` (builds then runs dist). */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildBackend } from './wiring.js';

// Load the repo-root .env (server-side secrets) when present; real env vars win.
const envFile = fileURLToPath(new URL('../../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { app, config } = buildBackend();

app.listen(config.port, () => {
  const persistence = config.spacetime ? `SpacetimeDB ${config.spacetime.module}` : 'in-memory/JSON';
  const vision = process.env.GEMINI_API_KEY ? 'live Gemini' : 'mock analyzer';
  console.log(
    `[backend] Scrap API listening on port ${config.port} (storage: ${config.objectStorage.provider}, persistence: ${persistence}, vision: ${vision})`,
  );
});
