/**
 * POST /api/dish-match (BRIDGE.md §4.3): validates transient thumbnails,
 * refuses with 503 when Gemini is not configured, and returns the verdict.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createGeminiGateway } from '@scrap/vision';
import { buildBackend } from '../src/wiring.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { DishMatchService, MAX_THUMBNAIL_BYTES } from '../src/services/dishMatchService.js';

const THUMB = { mimeType: 'image/jpeg', base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64') };

async function serve(dishMatch: DishMatchService) {
  const deps = buildBackend({ config: loadConfig({}) });
  const server = createApp({ ...deps, dishMatch }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown) => {
    const res = await fetch(`${base}/api/dish-match`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { post, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function answering(answer: unknown) {
  return createGeminiGateway({ env: {}, sleep: async () => {}, mockTransport: () => JSON.stringify(answer) });
}

test('without a Gemini key the endpoint refuses instead of guessing', async (t) => {
  const s = await serve(new DishMatchService(undefined));
  t.after(() => s.close());
  const res = await s.post({ reference: THUMB, candidate: THUMB });
  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, 'DISH_MATCH_UNAVAILABLE');
  assert.equal(res.json.error.retryable, true);
});

test('returns the validated verdict with provenance', async (t) => {
  const s = await serve(new DishMatchService(answering({ plateVisible: true, sameDish: 'different', reason: 'New plate.' })));
  t.after(() => s.close());
  const res = await s.post({ reference: THUMB, candidate: THUMB });
  assert.equal(res.status, 200);
  assert.equal(res.json.plateVisible, true);
  assert.equal(res.json.sameDish, 'different');
  assert.equal(res.json.promptVersion, 'dish-match-v1');
});

test('a no-plate verdict carries no sameDish field', async (t) => {
  const s = await serve(new DishMatchService(answering({ plateVisible: false, sameDish: 'not_applicable', reason: '' })));
  t.after(() => s.close());
  const res = await s.post({ reference: THUMB, candidate: THUMB });
  assert.equal(res.status, 200);
  assert.equal(res.json.plateVisible, false);
  assert.equal('sameDish' in res.json, false);
});

test('a malformed model answer is a retryable 502, not a verdict', async (t) => {
  const s = await serve(new DishMatchService(answering({ plateVisible: true, sameDish: 'maybe' })));
  t.after(() => s.close());
  const res = await s.post({ reference: THUMB, candidate: THUMB });
  assert.equal(res.status, 502);
  assert.equal(res.json.error.code, 'VISION_INVALID_RESPONSE');
  assert.equal(res.json.error.retryable, true);
});

test('bad thumbnails are rejected before any model call', async (t) => {
  const s = await serve(new DishMatchService(answering({ plateVisible: true, sameDish: 'same', reason: '' })));
  t.after(() => s.close());
  assert.equal((await s.post({ reference: THUMB })).json.error.code, 'INVALID_DISH_MATCH');
  assert.equal((await s.post({ reference: THUMB, candidate: { mimeType: 'image/gif', base64: 'AA==' } })).status, 400);
  assert.equal((await s.post({ reference: THUMB, candidate: { mimeType: 'image/jpeg', base64: 'not base64!' } })).status, 400);
  const big = { mimeType: 'image/jpeg', base64: Buffer.alloc(MAX_THUMBNAIL_BYTES + 1).toString('base64') };
  const tooBig = await s.post({ reference: THUMB, candidate: big });
  assert.equal(tooBig.status, 400);
  assert.equal(tooBig.json.error.code, 'DISH_MATCH_IMAGE_TOO_LARGE');
});
