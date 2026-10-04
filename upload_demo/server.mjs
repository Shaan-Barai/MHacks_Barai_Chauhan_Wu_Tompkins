/**
 * Upload demo website: anyone can upload a food photo and see every pipeline
 * stage (original → Gemini boxes → SAM 2.1 masks → Pixels wasted) plus the
 * carbon / water / nutrition factors from the food database.
 *
 *   node upload_demo/server.mjs            # http://localhost:8795
 *   HOST=0.0.0.0 node upload_demo/server.mjs   # reachable from phones on the LAN
 *
 * Needs GEMINI_API_KEY in .env and the SAM 2.1 worker (vision/sam/worker.py).
 * Uploads are analysed in memory only: nothing is written to R2 or
 * SpacetimeDB, so demo uploads never mix into the dining hall's dashboard.
 */

import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { REPO, createGeminiGateway, createSamWorkerClient, loadFoodDatabase, runSteps } from './pipeline.mjs';

try { process.loadEnvFile(path.join(REPO, '.env')); } catch {}

const PORT = Number(process.env.UPLOAD_DEMO_PORT ?? 8795);
const HOST = process.env.HOST ?? '127.0.0.1';
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const SAMPLE = path.join(REPO, 'demo_pictures/0_input_photo.jpg');
const MENUS = { all: null, halal: ['halal-chicken', 'halal-rice'] };

const foods = loadFoodDatabase();
const gateway = createGeminiGateway();
const sam = createSamWorkerClient();
if (gateway.mode !== 'live') console.warn('GEMINI_API_KEY is not set: analysis requests will fail.');

// One analysis at a time: the SAM worker is a single local GPU process.
let queue = Promise.resolve();
const serialize = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}
const apiError = (res, status, code, message) => send(res, status, { error: { code, message } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) { reject(Object.assign(new Error('too large'), { code: 'PAYLOAD_TOO_LARGE' })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const dataUrl = (jpeg) => (jpeg ? `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}` : null);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, readFileSync(new URL('./index.html', import.meta.url)), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/sample.jpg') return send(res, 200, readFileSync(SAMPLE), 'image/jpeg');
    if (req.method === 'GET' && url.pathname === '/api/foods') return send(res, 200, { foods });
    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      const menuKey = url.searchParams.get('menu') ?? 'all';
      if (!(menuKey in MENUS)) return apiError(res, 400, 'BAD_MENU', `menu must be one of: ${Object.keys(MENUS).join(', ')}`);
      if (!/^image\//.test(req.headers['content-type'] ?? '')) return apiError(res, 415, 'NOT_AN_IMAGE', 'Upload a JPEG, PNG or WebP photo.');
      const bytes = await readBody(req);
      if (!bytes.length) return apiError(res, 400, 'EMPTY_UPLOAD', 'The upload was empty.');
      const { images, summary } = await serialize(() => runSteps({
        gateway, sam, foods, bytes, menuKeys: MENUS[menuKey],
        sourceLabel: url.searchParams.get('name')?.slice(0, 80) || 'uploaded photo',
      }));
      return send(res, 200, {
        summary,
        images: { original: dataUrl(images.original), boxes: dataUrl(images.boxes), masks: dataUrl(images.masks), final: dataUrl(images.final) },
      });
    }
    return apiError(res, 404, 'NOT_FOUND', 'Not found');
  } catch (err) {
    if (err.code === 'PAYLOAD_TOO_LARGE') return apiError(res, 413, err.code, 'Photos must be under 20 MB.');
    if (/unsupported image format|Input buffer/i.test(err.message)) return apiError(res, 415, 'UNREADABLE_IMAGE', 'That file could not be read as an image.');
    console.error(err);
    return apiError(res, 502, 'ANALYSIS_FAILED', err.message.includes('fetch failed') ? 'The SAM 2.1 worker is not reachable. Start it (vision/sam/worker.py) and try again.' : 'Analysis failed. Try again or use another photo.');
  }
});

server.listen(PORT, HOST, () => console.log(`Upload demo on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (${foods.length} foods in the database)`));
