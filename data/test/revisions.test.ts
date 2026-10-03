import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DataValidationError,
  parseMenuUpload,
  planMenuRevision,
  type MenuBundle,
} from '../src/index.js';

function bundleWith(items: string[]): MenuBundle {
  return parseMenuUpload({
    hallId: 'hall-main',
    hallTimezone: 'America/Detroit',
    days: [{ date: '2026-10-03', lunch: items }],
  })[0]!;
}

test('revision: first upload creates at version 1', () => {
  const plan = planMenuRevision(undefined, bundleWith(['Soup', 'Salad']));
  assert.equal(plan.action, 'create');
  assert.equal(plan.bundle.service.menuVersion, 1);
});

test('revision: identical re-upload is a no-op, even with reordered items', () => {
  const stored = bundleWith(['Soup', 'Salad']);
  const reordered = bundleWith(['Salad', 'Soup']);
  const plan = planMenuRevision(stored, reordered);
  assert.equal(plan.action, 'unchanged');
  assert.equal(plan.bundle, stored); // keeps the stored bundle and its version
});

test('revision: changed items bump menuVersion on the same service — never a silent rewrite', () => {
  const stored = { ...bundleWith(['Soup', 'Salad']) };
  stored.service = { ...stored.service, menuVersion: 3 };
  const incoming = bundleWith(['Soup', 'Grilled Cheese']);

  const plan = planMenuRevision(stored, incoming);
  assert.equal(plan.action, 'revise');
  assert.equal(plan.action === 'revise' && plan.previousVersion, 3);
  assert.equal(plan.bundle.service.menuVersion, 4);
  assert.equal(plan.bundle.service.serviceId, stored.service.serviceId);
  assert.equal(plan.bundle.service.menuId, stored.service.menuId);
  // the incoming parse result itself was not mutated
  assert.equal(incoming.service.menuVersion, 1);
});

test('revision: a changed description is a revision too', () => {
  const stored = bundleWith(['Soup']);
  const incoming = bundleWith(['Soup']);
  incoming.items[0] = { ...incoming.items[0]!, description: 'Now with basil' };
  assert.equal(planMenuRevision(stored, incoming).action, 'revise');
});

test('revision: a different service is rejected, not treated as a revision', () => {
  const stored = bundleWith(['Soup']);
  const otherDay = parseMenuUpload({
    hallId: 'hall-main',
    hallTimezone: 'America/Detroit',
    days: [{ date: '2026-10-04', lunch: ['Soup'] }],
  })[0]!;
  assert.throws(
    () => planMenuRevision(stored, otherDay),
    (err: unknown) =>
      err instanceof DataValidationError && err.apiError.code === 'SERVICE_MISMATCH',
  );
});
