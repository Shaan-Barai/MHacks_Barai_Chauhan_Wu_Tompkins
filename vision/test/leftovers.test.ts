import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiGateway } from '../src/gateway.js';
import { assessLeftovers, validateLeftoverText } from '../src/leftovers.js';
import type { GatewayRequest } from '../src/gateway.js';

const IMAGE = { kind: 'bytes' as const, bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' };
const LABELS = ['burger', 'fries'];

function gatewayAnswering(answer: unknown, seen: GatewayRequest[] = []) {
  return createGeminiGateway({
    env: {},
    mockTransport: (req) => {
      seen.push(req);
      return JSON.stringify(answer);
    },
  });
}

test('countable food gets a count, uncountable food gets a percent remaining', async () => {
  const result = await assessLeftovers(
    gatewayAnswering({
      items: [
        { label: 'fries', countable: true, count: 12, confidence: 0.8 },
        { label: 'burger', countable: false, percentRemaining: 55, confidence: 0.7 },
      ],
    }),
    { image: IMAGE, labels: LABELS },
  );
  assert.ok(result.ok);
  assert.deepEqual(result.items, [
    { label: 'fries', countable: true, count: 12, confidence: 0.8 },
    { label: 'burger', countable: false, percentRemaining: 55, confidence: 0.7 },
  ]);
});

test('the model sees only the image and the allowed labels', async () => {
  const seen: GatewayRequest[] = [];
  await assessLeftovers(gatewayAnswering({ items: [] }, seen), { image: IMAGE, labels: LABELS });
  const [req] = seen;
  assert.ok(req);
  const texts = req.parts.filter((p): p is { text: string } => 'text' in p).map((p) => p.text);
  assert.deepEqual(texts, ['Allowed labels: ["burger","fries"]. Assess the leftovers in this image.']);
  assert.equal(req.parts.filter((p) => 'inlineData' in p).length, 1);
});

test('mixing count and percent, or unknown labels, is rejected as an unusable answer', () => {
  const bad = [
    [{ label: 'fries', countable: true, count: 3, percentRemaining: 40 }, 'percent_on_countable'],
    [{ label: 'burger', countable: false, percentRemaining: 50, count: 1 }, 'count_on_uncountable'],
    [{ label: 'fries', countable: true, count: 2.5 }, 'invalid_count'],
    [{ label: 'burger', countable: false, percentRemaining: 140 }, 'invalid_percent'],
    [{ label: 'pizza', countable: false, percentRemaining: 10 }, 'label_not_allowed'],
    [{ label: 'burger', percentRemaining: 10 }, 'missing_countable'],
  ] as const;
  for (const [item, reason] of bad) {
    assert.deepEqual(validateLeftoverText(JSON.stringify({ items: [item] }), LABELS), { ok: false, reason });
  }
  assert.deepEqual(validateLeftoverText('not json', LABELS), { ok: false, reason: 'invalid_json' });
});

test('an invalid answer becomes a retryable VISION_INVALID_RESPONSE, never a guessed zero', async () => {
  const result = await assessLeftovers(gatewayAnswering({ items: [{ label: 'fries', countable: true }] }), {
    image: IMAGE,
    labels: LABELS,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'VISION_INVALID_RESPONSE');
});
