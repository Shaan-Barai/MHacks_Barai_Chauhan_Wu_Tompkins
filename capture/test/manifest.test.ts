import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CaptureError, CaptureErrorCodes } from '../src/errors.js';
import { validateManifest } from '../src/manifest.js';
import { HALL, SERVICE } from './helpers.js';

const base = {
  manifestVersion: 1,
  hallId: HALL,
  serviceId: SERVICE,
};

function expectInvalid(raw: unknown, messagePart: string) {
  assert.throws(
    () => validateManifest(raw, 'test-manifest'),
    (err: unknown) =>
      err instanceof CaptureError &&
      err.apiError.code === CaptureErrorCodes.MANIFEST_INVALID &&
      err.apiError.message.includes(messagePart),
  );
}

test('valid manifest passes and deduplicates declared flags', () => {
  const manifest = validateManifest(
    {
      ...base,
      entries: [
        { entryId: 'd1', imagePath: 'a.jpg', declaredFlags: ['blurred', 'blurred', 'no_plate'] },
      ],
    },
    'test-manifest',
  );
  assert.deepEqual(manifest.entries[0]?.declaredFlags, ['blurred', 'no_plate']);
});

test('duplicate entry IDs are rejected', () => {
  expectInvalid(
    {
      ...base,
      entries: [
        { entryId: 'd1', imagePath: 'a.jpg' },
        { entryId: 'd1', imagePath: 'b.jpg' },
      ],
    },
    'appears more than once',
  );
});

test('unknown declared flags are rejected with the allowed list', () => {
  expectInvalid(
    { ...base, entries: [{ entryId: 'd1', imagePath: 'a.jpg', declaredFlags: ['ai_estimate'] }] },
    'unknown quality flag',
  );
});

test('missing context or entries are rejected', () => {
  expectInvalid({ ...base, entries: [] }, 'non-empty "entries"');
  expectInvalid({ manifestVersion: 1, serviceId: SERVICE, entries: [] }, 'hallId');
  expectInvalid({ ...base, hallId: HALL, manifestVersion: 2, entries: [] }, 'manifestVersion');
  expectInvalid(
    { ...base, entries: [{ entryId: 'd1', imagePath: 'a.jpg', capturedAt: 'not-a-date' }] },
    'capturedAt',
  );
});
