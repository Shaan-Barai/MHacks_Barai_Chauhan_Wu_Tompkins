/**
 * Sample history for the dashboard (DEMO_SEED), against a running backend.
 *
 *   npm run demo:seed     # ~14 days of labeled sample scans (needs DEMO_SEED=1 in .env)
 *   npm run demo:clear    # remove every sample row; real scans are untouched
 *   API_URL=http://host:port npm run demo:clear
 */

const action = process.argv[2];
const api = (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, '');
if (action !== 'seed' && action !== 'clear') {
  console.error('Usage: node scripts/demo.mjs seed|clear');
  process.exit(2);
}

let res;
try {
  res = await fetch(`${api}/api/demo/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action === 'seed' ? { hallId: process.env.HALL_ID || 'hall-main', days: Number(process.argv[3] ?? 14) } : {}),
  });
} catch {
  console.error(`No backend at ${api}. Start it first (cd backend && npm start).`);
  process.exit(1);
}
const body = await res.json();
if (!res.ok) {
  console.error(`${body.error?.code}: ${body.error?.message}`);
  process.exit(1);
}
if (action === 'seed') {
  console.log(`Sample history: ${body.services} services, ${body.captures} sample scans, ${body.measurements} sample measurements.`);
  if (body.skippedSlots.length > 0) console.log(`Skipped ${body.skippedSlots.length} meal(s) that already have a real menu or earlier sample data.`);
} else {
  console.log(`Removed ${body.removedRows} sample rows. Real scans, menus and portions were not touched.`);
}
