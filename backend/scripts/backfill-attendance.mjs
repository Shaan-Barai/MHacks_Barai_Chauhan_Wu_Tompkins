/**
 * Seed step: give every meal service without simulated attendance its one
 * persisted value (AGENTS.md 6.2/6.3; ATTENDANCE_MIN/MAX/SEED). Dashboard GETs
 * never create attendance, so run this after loading menus if you want the
 * per-attendee statistics. Writes only missing rows; safe to re-run.
 *
 *   node scripts/backfill-attendance.mjs [--dry-run]
 *   (uses the same .env/database settings as the backend; refuses READ_ONLY=1)
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const dryRun = process.argv.includes('--dry-run');
const { loadConfig } = await import('../dist/backend/src/config.js');
const { buildBackend } = await import('../dist/backend/src/wiring.js');
const { backfillAttendance } = await import('../dist/backend/src/services/dashboardService.js');

const config = loadConfig();
if (config.readOnly) {
  console.error('READ_ONLY=1: this site never writes. Run the backfill against the writable database.');
  process.exit(2);
}
const { repo, dashboard } = buildBackend({ config });
const missing = [];
for (const s of await repo.listServices()) if (!(await repo.getAttendance(s.serviceId))) missing.push(s.serviceId);
console.log(`${missing.length} service(s) without simulated attendance${missing.length ? `: ${missing.join(', ')}` : ''}`);
if (!dryRun && missing.length) console.log(`created ${await backfillAttendance(repo, dashboard)} (labeled simulated)`);
