/**
 * CSV menu upload parsing (UI.md setup step 2: "type item names or upload a
 * CSV", several days at once).
 *
 * Column format (documented in data/README.md; header row required):
 *
 *   date,meal,item_name,category,description
 *   2026-10-01,breakfast,Scrambled Eggs,entree,"Plain scrambled eggs, standard scoop"
 *
 * - `date` (YYYY-MM-DD), `meal` (Breakfast/Lunch/Dinner, any case), and
 *   `item_name` are required; `category` and `description` are optional
 *   columns and may be omitted entirely or left empty per row.
 * - Columns are located by header name, so column order is flexible.
 * - RFC-4180-style quoting: fields with commas/quotes/newlines are wrapped in
 *   double quotes; literal quotes are doubled (""). LF and CRLF both accepted.
 * - Blank lines are skipped. Any malformed row fails the whole upload with
 *   its line number — a partial menu is worse than a clear error.
 *
 * The CSV carries no hall information; the caller supplies HallContext.
 */

import { invalid } from './errors.js';
import { buildMenuBundle, MAX_ITEMS_PER_MEAL } from './menuBundle.js';
import { validateHallId, validateMealLabel, validateServiceDate, validateTimezone } from './ids.js';
import type { HallContext, MealLabel, MenuBundle, MenuUploadItem } from './types.js';

const REQUIRED_COLUMNS = ['date', 'meal', 'item_name'] as const;
const OPTIONAL_COLUMNS = ['category', 'description'] as const;
const MAX_CSV_BYTES = 1_000_000;

interface CsvRow {
  /** 1-based line number of the first line of the record, for error messages. */
  line: number;
  fields: string[];
}

/** Minimal RFC-4180 reader: quoted fields, doubled quotes, CRLF/LF. */
export function readCsvRecords(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;
  let sawAnything = false;

  const pushField = () => {
    fields.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // Skip rows that are entirely empty (blank lines).
    if (fields.length > 1 || (fields[0] ?? '').trim() !== '') {
      rows.push({ line: recordStartLine, fields });
    }
    fields = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    sawAnything = true;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (c === '\n') line++;
        field += c;
      }
    } else if (c === '"') {
      if (field.trim() !== '') {
        invalid('MALFORMED_CSV', `Line ${line}: quotes may only wrap a whole field.`, { line });
      }
      field = ''; // discard pre-quote whitespace
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      pushRow();
      line++;
      recordStartLine = line;
    } else {
      field += c;
    }
  }
  if (inQuotes) {
    invalid('MALFORMED_CSV', `Line ${recordStartLine}: a quoted field is never closed.`, {
      line: recordStartLine,
    });
  }
  if (sawAnything && (fields.length > 0 || field !== '')) pushRow();
  return rows;
}

/**
 * Parses a menu CSV into contract-exact MenuBundle records — one per
 * hall/date/meal present in the file. Throws DataValidationError with the
 * offending line number on any malformed row.
 */
export function parseMenuCsv(csvText: string, hall: HallContext): MenuBundle[] {
  const hallId = validateHallId(hall.hallId);
  const hallTimezone = validateTimezone(hall.hallTimezone);
  if (typeof csvText !== 'string' || csvText.trim() === '') {
    invalid('EMPTY_CSV', 'The CSV file is empty. Add a header row and menu rows.');
  }
  if (Buffer.byteLength(csvText, 'utf8') > MAX_CSV_BYTES) {
    invalid('CSV_TOO_LARGE', 'The CSV file is too large (max 1 MB).');
  }

  const records = readCsvRecords(csvText.replace(/^﻿/, ''));
  if (records.length === 0) {
    invalid('EMPTY_CSV', 'The CSV file has no rows.');
  }

  const header = records[0]!;
  const columnIndex = new Map<string, number>();
  header.fields.forEach((name, i) => {
    const key = name.trim().toLowerCase();
    if (key === '') return;
    if (columnIndex.has(key)) {
      invalid('MALFORMED_CSV', `Line ${header.line}: duplicate column "${key}".`, {
        line: header.line,
        column: key,
      });
    }
    columnIndex.set(key, i);
  });
  for (const required of REQUIRED_COLUMNS) {
    if (!columnIndex.has(required)) {
      invalid(
        'MISSING_CSV_COLUMN',
        `The CSV header must include "${required}". Expected columns: date, meal, item_name` +
          `, and optionally ${OPTIONAL_COLUMNS.join(', ')}.`,
        { line: header.line, missing: required, found: header.fields },
      );
    }
  }

  const dataRows = records.slice(1);
  if (dataRows.length === 0) {
    invalid('EMPTY_CSV', 'The CSV has a header but no menu rows.');
  }

  // Group rows by date+meal, preserving first-seen order.
  const groups = new Map<string, { date: string; meal: MealLabel; items: MenuUploadItem[] }>();
  const get = (row: CsvRow, column: string): string =>
    (row.fields[columnIndex.get(column)!] ?? '').trim();

  for (const row of dataRows) {
    const context = { line: row.line };
    const wrap = (fn: () => string): string => {
      try {
        return fn();
      } catch (err) {
        if (err instanceof Error && 'apiError' in err) {
          const api = (err as { apiError: { code: string; message: string } }).apiError;
          invalid(api.code, `Line ${row.line}: ${api.message}`, context);
        }
        throw err;
      }
    };

    const date = wrap(() => validateServiceDate(get(row, 'date')));
    const meal = wrap(() => validateMealLabel(get(row, 'meal'))) as MealLabel;
    const name = get(row, 'item_name');
    if (name === '') {
      invalid('INVALID_MENU_ITEM', `Line ${row.line}: item_name is empty.`, context);
    }
    const category = columnIndex.has('category') ? get(row, 'category') : '';
    const description = columnIndex.has('description') ? get(row, 'description') : '';

    const key = `${date}|${meal}`;
    let group = groups.get(key);
    if (!group) {
      group = { date, meal, items: [] };
      groups.set(key, group);
    }
    if (group.items.length >= MAX_ITEMS_PER_MEAL) {
      invalid('TOO_MANY_ITEMS', `Line ${row.line}: more than ${MAX_ITEMS_PER_MEAL} items for ${meal} on ${date}.`, context);
    }
    group.items.push({
      name,
      ...(category !== '' ? { category } : {}),
      ...(description !== '' ? { description } : {}),
    });
  }

  return Array.from(groups.values()).map((group) =>
    buildMenuBundle(hallId, hallTimezone, group.date, group.meal, group.items),
  );
}
