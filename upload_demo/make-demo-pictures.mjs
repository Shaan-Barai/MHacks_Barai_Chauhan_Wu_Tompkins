/**
 * Writes demo_pictures/: every pipeline stage for the halal chicken + rice bowl
 * (labels: Halal Chicken, Halal Rice), plus results.json.
 *
 *   node upload_demo/make-demo-pictures.mjs [photo]
 *
 * Live: needs GEMINI_API_KEY in .env and the SAM 2.1 worker on SAM_WORKER_URL
 * (default http://localhost:8790). Two Gemini calls per run.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO, createGeminiGateway, createSamWorkerClient, loadFoodDatabase, runSteps } from './pipeline.mjs';

try { process.loadEnvFile(path.join(REPO, '.env')); } catch {}

const PHOTO = process.argv[2] ?? path.join(REPO, 'demo_pictures/0_input_photo.jpg');
const OUT = path.join(REPO, 'demo_pictures');
const LABELS = ['halal-chicken', 'halal-rice'];

const gateway = createGeminiGateway();
if (gateway.mode !== 'live') throw new Error('Set GEMINI_API_KEY in .env: this script makes live Gemini calls.');
const sam = createSamWorkerClient();

const { images, summary } = await runSteps({
  gateway, sam, foods: loadFoodDatabase(), menuKeys: LABELS,
  bytes: readFileSync(PHOTO), sourceLabel: 'Halal chicken + rice bowl (Uno Q camera, 2026-10-04)', eventId: 'demo_halal_bowl',
});

mkdirSync(OUT, { recursive: true });
const files = { original: '1_original.jpg', boxes: '2_gemini_boxes.jpg', masks: '3_sam_segmentation.jpg', final: '4_final_result.jpg' };
for (const [k, name] of Object.entries(files)) {
  if (images[k]) writeFileSync(path.join(OUT, name), images[k]);
  else console.log(`  (no ${k} image: ${summary.error?.code ?? summary.countStatus})`);
}
writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ photo: path.relative(REPO, PHOTO), ...summary }, null, 2) + '\n');

console.log(`${summary.status}/${summary.countStatus} in ${summary.seconds}s, ${summary.geminiCalls} Gemini calls, flags [${summary.qualityFlags.join(', ')}]`);
for (const f of summary.foods) {
  console.log(`  ${f.food.padEnd(18)} ${String(f.pixelsWasted).padStart(8)} px  ${f.boxes} boxes  CO2 pts ${f.points?.co2Points ?? 'n/a'}  water pts ${f.points?.waterPoints ?? 'n/a'}`);
}
console.log(`  dish region rebuilt identically: ${summary.overlayCheck.dishRegionMatchesVision}`);
console.log(`  TOTAL Pixels wasted ${summary.capturePixelsWasted ?? 'unavailable'} px -> ${path.relative(REPO, OUT)}/`);
