import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../frontend/dist');
const port = Number(process.env.PORT || 4173);
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']], ['/main.js', ['main.js', 'text/javascript; charset=utf-8']], ['/main.css', ['main.css', 'text/css; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/demo-data.json', ['demo-data.json', 'application/json; charset=utf-8']]]);

createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end('Method not allowed'); return; }
  let path;
  try { path = new URL(request.url, 'http://preview.invalid').pathname; } catch { response.writeHead(400); response.end('Bad request'); return; }
  const asset = assets.get(path);
  if (!asset) { response.writeHead(404); response.end('Not found'); return; }
  try {
    const body = await readFile(resolve(root, asset[0]));
    response.writeHead(200, { 'Content-Type': asset[1] });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(503); response.end('Build the preview with npm run build:ui first.');
  }
}).listen(port, '0.0.0.0', () => console.log(`Scrap Saver is ready on port ${port}. Only built preview assets are served.`));
