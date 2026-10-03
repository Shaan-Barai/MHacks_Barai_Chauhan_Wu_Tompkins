import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DataValidationError,
  parseMenuUpload,
  type MenuUpload,
} from '../src/index.js';

const upload = (): MenuUpload => ({
  hallId: 'hall-main',
  hallTimezone: 'America/Detroit',
  days: [
    {
      date: '2026-10-03',
      breakfast: ['Scrambled Eggs', { name: 'Hash Browns', category: 'side' }],
      lunch: [
        {
          name: 'Grilled Chicken Sandwich',
          category: 'entree',
          description: 'Grilled chicken breast on a brioche bun',
        },
      ],
    },
    { date: '2026-10-04', dinner: ['Baked Ziti'] },
  ],
});

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof DataValidationError, `expected DataValidationError, got ${err}`);
    assert.equal(err.apiError.retryable, false);
    assert.ok(err.apiError.message.length > 0);
    return err.apiError.code;
  }
  assert.fail('expected a DataValidationError');
}

test('typed upload: parses multiple days into contract-exact bundles', () => {
  const bundles = parseMenuUpload(upload());
  assert.equal(bundles.length, 3); // breakfast + lunch on day 1, dinner on day 2

  const breakfast = bundles[0]!;
  assert.deepEqual(breakfast.service, {
    serviceId: 'svc_hall-main_2026-10-03_breakfast',
    hallId: 'hall-main',
    hallTimezone: 'America/Detroit',
    serviceDate: '2026-10-03',
    mealLabel: 'breakfast',
    menuId: 'menu_hall-main_2026-10-03_breakfast',
    menuVersion: 1,
  });
  assert.deepEqual(breakfast.items[0], {
    itemId: 'item_hall-main_2026-10-03_breakfast_scrambled-eggs',
    menuId: 'menu_hall-main_2026-10-03_breakfast',
    displayName: 'Scrambled Eggs',
  });
  assert.equal(breakfast.items[1]!.category, 'side');

  const lunch = bundles[1]!;
  assert.equal(lunch.service.mealLabel, 'lunch');
  assert.equal(lunch.items[0]!.description, 'Grilled chicken breast on a brioche bun');

  const dinner = bundles[2]!;
  assert.equal(dinner.service.serviceId, 'svc_hall-main_2026-10-04_dinner');
});

test('typed upload: IDs are deterministic and independent of item order', () => {
  const a = parseMenuUpload(upload());
  const b = parseMenuUpload(upload());
  assert.deepEqual(a, b);

  const reordered = upload();
  reordered.days[0]!.breakfast!.reverse();
  const c = parseMenuUpload(reordered);
  const idsOf = (bundles: typeof a) => bundles[0]!.items.map((item) => item.itemId).sort();
  assert.deepEqual(idsOf(c), idsOf(a));
});

test('typed upload: rejections carry stable codes and plain messages', () => {
  assert.equal(code(() => parseMenuUpload(null)), 'INVALID_MENU_UPLOAD');
  assert.equal(code(() => parseMenuUpload({ ...upload(), hallId: 'Hall Main' })), 'INVALID_HALL_ID');
  assert.equal(
    code(() => parseMenuUpload({ ...upload(), hallTimezone: 'Mars/Olympus' })),
    'INVALID_TIMEZONE',
  );
  assert.equal(code(() => parseMenuUpload({ ...upload(), days: [] })), 'INVALID_MENU_UPLOAD');

  const badDate = upload();
  badDate.days[0]!.date = '2026-02-30';
  assert.equal(code(() => parseMenuUpload(badDate)), 'INVALID_DATE');

  const emptyDay = upload();
  emptyDay.days[1] = { date: '2026-10-04' };
  assert.equal(code(() => parseMenuUpload(emptyDay)), 'EMPTY_DAY');

  const emptyMeal = upload();
  emptyMeal.days[1]!.dinner = [];
  assert.equal(code(() => parseMenuUpload(emptyMeal)), 'EMPTY_MEAL');

  const duplicateDate = upload();
  duplicateDate.days.push({ date: '2026-10-03', lunch: ['Soup'] });
  assert.equal(code(() => parseMenuUpload(duplicateDate)), 'DUPLICATE_DATE');

  const duplicateItem = upload();
  duplicateItem.days[0]!.breakfast!.push('Scrambled  EGGS!'); // same slug
  assert.equal(code(() => parseMenuUpload(duplicateItem)), 'DUPLICATE_MENU_ITEM');

  const blankName = upload();
  blankName.days[0]!.breakfast!.push('   ');
  assert.equal(code(() => parseMenuUpload(blankName)), 'INVALID_MENU_ITEM');
});
