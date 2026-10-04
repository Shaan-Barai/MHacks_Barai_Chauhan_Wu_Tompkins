/** Entry point: `npm start` (builds then runs dist). */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildBackend } from './wiring.js';
import { log } from './log.js';

// Load the repo-root .env (server-side secrets) when present; real env vars win.
const envFile = fileURLToPath(new URL('../../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

let built: ReturnType<typeof buildBackend>;
try {
  built = buildBackend();
} catch (err) {
  log.error('startup refused', { reason: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
const { app, config, security } = built;

const onListen = () => {
  const persistence = config.spacetime ? `SpacetimeDB ${config.spacetime.module}` : 'in-memory/JSON';
  const vision = process.env.GEMINI_API_KEY
    ? `Gemini classification + SAM 2.1 masks (${config.samWorkerUrl})`
    : 'mock analyzer';
  log.info('Scrap API listening', {
    host: config.host ?? '(all interfaces)',
    port: config.port,
    mode: security.production ? 'production' : 'development',
    auth: security.open ? 'open' : 'required for mutations',
    storage: config.objectStorage.provider,
    persistence,
    vision,
    frontend: config.frontendDist ? 'served' : 'not served',
  });
};
if (config.host) app.listen(config.port, config.host, onListen);
else app.listen(config.port, onListen);
