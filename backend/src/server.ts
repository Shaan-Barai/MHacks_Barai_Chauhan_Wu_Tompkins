/** Entry point: `npm start` (builds then runs dist). */

import { buildBackend } from './wiring.js';

const { app, config } = buildBackend();

app.listen(config.port, () => {
  console.log(`[backend] Scrap API listening on port ${config.port} (storage: local-dev)`);
});
