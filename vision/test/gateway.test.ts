import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayError } from '../src/errors.js';
import { createGeminiGateway, DEFAULT_MODEL } from '../src/gateway.js';

const noSleep = async () => {};

test('mock mode is automatic when GEMINI_API_KEY is unset', async () => {
  const gw = createGeminiGateway({ env: {} });
  assert.equal(gw.mode, 'mock');
  assert.equal(gw.model, DEFAULT_MODEL);
  const text = await gw.generateText('say hi');
  assert.match(text, /mock-mode/); // never pretends to be a live answer
});

test('model and retry budget come from env', () => {
  const gw = createGeminiGateway({
    env: { GEMINI_MODEL: 'gemini-2.5-pro', GEMINI_MAX_RETRIES: '5', GEMINI_TIMEOUT_MS: '1000' },
  });
  assert.equal(gw.model, 'gemini-2.5-pro');
  assert.equal(gw.mode, 'mock'); // still no key
});

test('generateText passes through the mock transport (Agent 6 interface)', async () => {
  const gw = createGeminiGateway({
    env: {},
    mockTransport: (req) => {
      assert.equal(req.kind, 'text');
      assert.equal(req.parts.length, 1);
      return 'three practical suggestions';
    },
  });
  assert.equal(await gw.generateText('suggest', { temperature: 0.4 }), 'three practical suggestions');
});

test('generateStructured requires a responseSchema', async () => {
  const gw = createGeminiGateway({ env: {} });
  await assert.rejects(
    gw.generateStructured({ parts: [{ text: 'x' }] }),
    (err: unknown) => err instanceof GatewayError && err.apiError.code === 'VISION_INTERNAL',
  );
});

test('retryable failures are retried with backoff and then succeed', async () => {
  let calls = 0;
  const slept: number[] = [];
  const gw = createGeminiGateway({
    env: {},
    maxRetries: 2,
    retryBaseDelayMs: 100,
    sleep: async (ms) => {
      slept.push(ms);
    },
    mockTransport: () => {
      calls++;
      if (calls < 3) {
        const err = new Error('got status: 429 resource exhausted');
        (err as Error & { status: number }).status = 429;
        throw err;
      }
      return 'ok after retries';
    },
  });
  assert.equal(await gw.generateText('x'), 'ok after retries');
  assert.equal(calls, 3);
  assert.deepEqual(slept, [100, 200]); // exponential backoff
});

test('retry-then-fail: bounded retries exhaust and surface a normalized ApiError', async () => {
  let calls = 0;
  const gw = createGeminiGateway({
    env: {},
    maxRetries: 2,
    sleep: noSleep,
    mockTransport: () => {
      calls++;
      const err = new Error('server exploded');
      (err as Error & { status: number }).status = 503;
      throw err;
    },
  });
  await assert.rejects(gw.generateText('x'), (err: unknown) => {
    assert.ok(err instanceof GatewayError);
    assert.equal(err.apiError.code, 'GEMINI_UNAVAILABLE');
    assert.equal(err.apiError.retryable, true);
    return true;
  });
  assert.equal(calls, 3); // 1 attempt + 2 retries, never more
  assert.equal(gw.callCount, 3);
});

test('non-retryable failures (auth) are not retried', async () => {
  let calls = 0;
  const gw = createGeminiGateway({
    env: {},
    maxRetries: 2,
    sleep: noSleep,
    mockTransport: () => {
      calls++;
      const err = new Error('API key not valid');
      (err as Error & { status: number }).status = 403;
      throw err;
    },
  });
  await assert.rejects(gw.generateText('x'), (err: unknown) => {
    assert.ok(err instanceof GatewayError);
    assert.equal(err.apiError.code, 'GEMINI_AUTH_FAILED');
    assert.equal(err.apiError.retryable, false);
    return true;
  });
  assert.equal(calls, 1);
});

test('Google invalid-key 400 normalizes to GEMINI_AUTH_FAILED (seen in the live smoke test)', async () => {
  const gw = createGeminiGateway({
    env: {},
    sleep: noSleep,
    mockTransport: () => {
      const err = new Error('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}');
      (err as Error & { status: number }).status = 400;
      throw err;
    },
  });
  await assert.rejects(gw.generateText('x'), (err: unknown) => {
    assert.ok(err instanceof GatewayError);
    assert.equal(err.apiError.code, 'GEMINI_AUTH_FAILED');
    return true;
  });
});

test('timeout-shaped errors normalize to retryable GEMINI_TIMEOUT', async () => {
  const gw = createGeminiGateway({
    env: {},
    maxRetries: 0,
    sleep: noSleep,
    mockTransport: () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    },
  });
  await assert.rejects(gw.generateText('x'), (err: unknown) => {
    assert.ok(err instanceof GatewayError);
    assert.equal(err.apiError.code, 'GEMINI_TIMEOUT');
    assert.equal(err.apiError.retryable, true);
    return true;
  });
});
