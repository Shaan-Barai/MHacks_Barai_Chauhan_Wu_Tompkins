import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildVocabulary,
  findVocabulary,
  isAllowedClassification,
  parseMenuUpload,
  UNKNOWN_RESULT,
} from '../src/index.js';

const bundles = parseMenuUpload({
  hallId: 'hall-main',
  hallTimezone: 'America/Detroit',
  days: [
    {
      date: '2026-10-03',
      lunch: [
        { name: 'Tomato Soup', category: 'soup', description: 'Creamy tomato soup' },
        'Garden Salad',
      ],
      dinner: ['Baked Ziti'],
    },
  ],
});

test('vocabulary: resolves exactly the menu items for one hall/date/service', () => {
  const lookup = findVocabulary(bundles, 'hall-main', '2026-10-03', 'lunch');
  assert.ok(lookup.found);
  const vocab = lookup.vocabulary;
  assert.equal(vocab.serviceId, 'svc_hall-main_2026-10-03_lunch');
  assert.equal(vocab.menuVersion, 1);
  assert.deepEqual(
    vocab.items.map((item) => item.itemId),
    [
      'item_hall-main_2026-10-03_lunch_tomato-soup',
      'item_hall-main_2026-10-03_lunch_garden-salad',
    ],
  );
  // names/descriptions travel with the IDs for the classifier prompt
  assert.equal(vocab.items[0]!.description, 'Creamy tomato soup');
  // dinner items are NOT in the lunch vocabulary
  assert.ok(!vocab.items.some((item) => item.itemId.includes('baked-ziti')));
});

test('vocabulary: unknown/non-menu is a separate result, never an invented item', () => {
  const vocab = buildVocabulary(bundles[0]!);
  assert.equal(vocab.unknown, UNKNOWN_RESULT);
  assert.equal(vocab.unknown.itemId, null);
  // the unknown result is not one of the classifiable menu items
  assert.ok(!vocab.items.some((item) => item.itemId === null || item.displayName === vocab.unknown.label));

  assert.equal(isAllowedClassification(vocab, null), true);
  assert.equal(isAllowedClassification(vocab, vocab.items[0]!.itemId), true);
  assert.equal(isAllowedClassification(vocab, 'item_hall-main_2026-10-03_lunch_invented-dish'), false);
});

test('vocabulary: a missing menu is an explicit absence, not an empty vocabulary', () => {
  const lookup = findVocabulary(bundles, 'hall-main', '2026-10-04', 'lunch');
  assert.equal(lookup.found, false);
  assert.ok(!lookup.found && lookup.reason.includes('No menu is saved'));
  assert.ok(!lookup.found && lookup.serviceId === 'svc_hall-main_2026-10-04_lunch');
});
