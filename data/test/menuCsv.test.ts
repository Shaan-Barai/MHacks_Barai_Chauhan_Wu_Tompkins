import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DataValidationError, parseMenuCsv } from '../src/index.js';

const HALL = { hallId: 'hall-main', hallTimezone: 'America/Detroit' };

function failure(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof DataValidationError, `expected DataValidationError, got ${err}`);
    return { code: err.apiError.code, message: err.apiError.message };
  }
  assert.fail('expected a DataValidationError');
}

test('csv: happy path with quoting, CRLF, blank lines, and case-insensitive meals', () => {
  const csv = [
    'date,meal,item_name,category,description',
    '2026-10-01,Breakfast,Scrambled Eggs,entree,"Plain scrambled eggs, standard scoop"',
    '2026-10-01,breakfast,Hash Browns,side,',
    '',
    '2026-10-01,LUNCH,"Mac ""n"" Cheese",entree,Baked macaroni',
    '2026-10-02,dinner,Baked Ziti,,',
  ].join('\r\n');

  const bundles = parseMenuCsv(csv, HALL);
  assert.equal(bundles.length, 3);

  const breakfast = bundles[0]!;
  assert.equal(breakfast.service.serviceId, 'svc_hall-main_2026-10-01_breakfast');
  assert.equal(breakfast.service.menuVersion, 1);
  assert.equal(breakfast.items.length, 2);
  assert.equal(breakfast.items[0]!.description, 'Plain scrambled eggs, standard scoop');
  assert.equal(breakfast.items[1]!.description, undefined);

  const lunch = bundles[1]!;
  assert.equal(lunch.items[0]!.displayName, 'Mac "n" Cheese');
  assert.equal(lunch.items[0]!.itemId, 'item_hall-main_2026-10-01_lunch_mac-n-cheese');

  const dinner = bundles[2]!;
  assert.equal(dinner.service.serviceDate, '2026-10-02');
  assert.equal(dinner.items[0]!.category, undefined);
});

test('csv: columns are located by header name, order-independent and optional-column-free', () => {
  const csv = ['meal,item_name,date', 'lunch,Garden Salad,2026-10-01'].join('\n');
  const bundles = parseMenuCsv(csv, HALL);
  assert.equal(bundles[0]!.items[0]!.itemId, 'item_hall-main_2026-10-01_lunch_garden-salad');
});

test('csv: identical input parses to identical output (deterministic IDs)', () => {
  const csv = 'date,meal,item_name\n2026-10-01,lunch,Tomato Soup\n';
  assert.deepEqual(parseMenuCsv(csv, HALL), parseMenuCsv(csv, HALL));
});

test('csv: malformed rows are rejected with their line number', () => {
  const badMeal = failure(() =>
    parseMenuCsv('date,meal,item_name\n2026-10-01,lunch,Soup\n2026-10-01,brunch,Eggs', HALL),
  );
  assert.equal(badMeal.code, 'INVALID_MEAL');
  assert.match(badMeal.message, /Line 3/);

  const badDate = failure(() => parseMenuCsv('date,meal,item_name\n10/01/2026,lunch,Soup', HALL));
  assert.equal(badDate.code, 'INVALID_DATE');
  assert.match(badDate.message, /Line 2/);

  const blankName = failure(() => parseMenuCsv('date,meal,item_name\n2026-10-01,lunch,  ', HALL));
  assert.equal(blankName.code, 'INVALID_MENU_ITEM');
  assert.match(blankName.message, /Line 2/);
});

test('csv: structural problems are rejected with clear errors', () => {
  assert.equal(failure(() => parseMenuCsv('', HALL)).code, 'EMPTY_CSV');
  assert.equal(failure(() => parseMenuCsv('date,meal,item_name\n', HALL)).code, 'EMPTY_CSV');

  const missing = failure(() => parseMenuCsv('date,item_name\n2026-10-01,Soup', HALL));
  assert.equal(missing.code, 'MISSING_CSV_COLUMN');
  assert.match(missing.message, /meal/);

  const unclosed = failure(() =>
    parseMenuCsv('date,meal,item_name\n2026-10-01,lunch,"Soup', HALL),
  );
  assert.equal(unclosed.code, 'MALFORMED_CSV');

  const duplicateColumn = failure(() =>
    parseMenuCsv('date,meal,item_name,meal\n2026-10-01,lunch,Soup,lunch', HALL),
  );
  assert.equal(duplicateColumn.code, 'MALFORMED_CSV');
});
