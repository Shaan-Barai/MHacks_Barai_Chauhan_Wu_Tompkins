import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiGateway } from '../src/gateway.js';
import { judgeSameDish, validateDishMatchText } from '../src/dishMatch.js';
import type { GatewayRequest } from '../src/gateway.js';

const IMAGE = { kind: 'bytes' as const, bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' };

function gatewayAnswering(answer: unknown, seen: GatewayRequest[] = []) {
  return createGeminiGateway({
    env: {},
    sleep: async () => {},
    mockTransport: (req) => {
      seen.push(req);
      return typeof answer === 'string' ? answer : JSON.stringify(answer);
    },
  });
}

test('a same-dish answer is returned with its reason and provenance', async () => {
  const seen: GatewayRequest[] = [];
  const result = await judgeSameDish(
    gatewayAnswering({ plateVisible: true, sameDish: 'same', reason: 'Same rim and rice.' }, seen),
    { reference: IMAGE, candidate: IMAGE },
  );
  assert.ok(result.ok);
  assert.equal(result.plateVisible, true);
  assert.equal(result.plateVisible && result.sameDish, 'same');
  assert.equal(result.reason, 'Same rim and rice.');
  assert.equal(result.promptVersion, 'dish-match-v1');
  // Both images go to the model, reference first.
  assert.equal(seen[0]!.parts.filter((p) => 'inlineData' in p).length, 2);
});

test('no plate in the candidate is a verdict of its own', async () => {
  const result = await judgeSameDish(
    gatewayAnswering({ plateVisible: false, sameDish: 'not_applicable', reason: 'Empty belt.' }),
    { reference: IMAGE, candidate: IMAGE },
  );
  assert.ok(result.ok);
  assert.equal(result.plateVisible, false);
});

test('inconsistent or malformed answers are rejected, never read as "different"', () => {
  const bad = [
    [{ plateVisible: false, sameDish: 'different' }, 'verdict_without_plate'],
    [{ plateVisible: true, sameDish: 'not_applicable' }, 'invalid_same_dish'],
    [{ plateVisible: true, sameDish: 'maybe' }, 'invalid_same_dish'],
    [{ sameDish: 'same' }, 'missing_plate_visible'],
    [[], 'missing_plate_visible'],
  ] as const;
  for (const [answer, reason] of bad) {
    assert.deepEqual(validateDishMatchText(JSON.stringify(answer)), { ok: false, reason });
  }
  assert.deepEqual(validateDishMatchText('nope'), { ok: false, reason: 'invalid_json' });
});

test('an unusable answer becomes a retryable VISION_INVALID_RESPONSE', async () => {
  const result = await judgeSameDish(gatewayAnswering('not json'), { reference: IMAGE, candidate: IMAGE });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'VISION_INVALID_RESPONSE');
  assert.equal(!result.ok && result.error.retryable, true);
});
