import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayError } from '../src/errors.js';
import { createGeminiGateway, DEFAULT_MODEL, DEFAULT_TIMEOUT_RETRY_THINKING_BUDGET, DEFAULT_TIMEOUT_MS } from '../src/gateway.js';

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

test('the Gemini timeout defaults to 90 s; GEMINI_TIMEOUT_MS overrides it', () => {
  // 30 s dropped real plate photos on both passes (Run 3); keep the default at 90 s.
  assert.equal(DEFAULT_TIMEOUT_MS, 90_000);
  assert.equal(createGeminiGateway({ env: {} }).timeoutMs, 90_000);
  assert.equal(createGeminiGateway({ env: { GEMINI_TIMEOUT_MS: 'not a number' } }).timeoutMs, 90_000);
  assert.equal(createGeminiGateway({ env: { GEMINI_TIMEOUT_MS: '45000' } }).timeoutMs, 45_000);
  assert.equal(createGeminiGateway({ env: {}, timeoutMs: 1000 }).timeoutMs, 1000);
});

test('structured requests keep the model default thinking; a timed-out one is retried with thinking capped at 1024', async () => {
  const seen: unknown[] = [];
  let n = 0;
  const gw = (env: Record<string, string>, failFirst = false) =>
    createGeminiGateway({
      env, sleep: noSleep, onCall: (c) => seen.push([c.label, c.attempt, c.settings.thinkingBudget, c.ok]),
      mockTransport: () => {
        if (failFirst && n++ === 0) throw Object.assign(new Error('deadline exceeded'), { name: 'AbortError' });
        return '{}';
      },
    });
  assert.equal(DEFAULT_TIMEOUT_RETRY_THINKING_BUDGET, 1024);
  assert.equal(gw({}).structuredThinkingBudget, null);
  assert.equal(gw({ GEMINI_THINKING_BUDGET: '2048' }).structuredThinkingBudget, 2048);
  await gw({}).generateStructured({ parts: [{ text: 'x' }], responseSchema: {}, label: 'localize-pass1' });
  await gw({}, true).generateStructured({ parts: [{ text: 'x' }], responseSchema: {}, label: 'localize-pass2' });
  await gw({}).generateText('hi');
  assert.deepEqual(seen, [
    ['localize-pass1', 0, 'model default', true],
    ['localize-pass2', 0, 'model default', false], // timed out
    ['localize-pass2', 1, 1024, true], // retried with less thinking
    ['text', 0, 0, true],
  ]);
  seen.length = 0;
  n = 0;
  await gw({ GEMINI_TIMEOUT_RETRY_THINKING_BUDGET: 'off' }, true).generateStructured({ parts: [{ text: 'x' }], responseSchema: {}, label: 'p' });
  assert.deepEqual(seen.map((x) => (x as unknown[])[2]), ['model default', 'model default'], '"off" = identical retry');
});

test('onCall reports each attempt with its label, timing and settings, never the key', async () => {
  const calls: import('../src/gateway.js').GatewayCallRecord[] = [];
  let n = 0;
  const gw = createGeminiGateway({
    env: {}, sleep: noSleep, onCall: (c) => calls.push(c),
    mockTransport: () => { if (n++ === 0) throw Object.assign(new Error('deadline'), { name: 'AbortError' }); return '{"ok":1}'; },
  });
  assert.equal(await gw.generateStructured({ parts: [{ text: 'x' }], responseSchema: {}, label: 'localize-pass2' }), '{"ok":1}');
  assert.deepEqual(calls.map((c) => [c.label, c.attempt, c.ok, c.outputChars ?? null]), [['localize-pass2', 0, false, null], ['localize-pass2', 1, true, 8]]);
  assert.ok(calls.every((c) => c.durationMs >= 0 && c.settings.timeoutMs === 90_000));
  assert.ok(!JSON.stringify(calls).toLowerCase().includes('apikey'));
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

test('Google 402 depleted credits normalizes to non-retryable GEMINI_BILLING (seen in the live E2E)', async () => {
  let calls = 0;
  const gw = createGeminiGateway({
    env: {},
    sleep: noSleep,
    mockTransport: () => {
      calls++;
      const err = new Error('{"error":{"code":402,"message":"Your prepayment credits are depleted.","status":"RESOURCE_EXHAUSTED"}}');
      (err as Error & { status: number }).status = 402;
      throw err;
    },
  });
  await assert.rejects(gw.generateText('x'), (err: unknown) => {
    assert.ok(err instanceof GatewayError);
    assert.equal(err.apiError.code, 'GEMINI_BILLING');
    assert.equal(err.apiError.retryable, false);
    return true;
  });
  assert.equal(calls, 1);
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
