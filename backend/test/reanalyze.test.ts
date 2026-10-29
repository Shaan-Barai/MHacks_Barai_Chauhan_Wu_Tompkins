/** Re-analysis of an existing capture: a new attempt on the same event; nothing is duplicated or deleted. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASELINES, MENU, startTestServer } from './helpers.js';

test('reanalyze appends an attempt to a succeeded capture; a plain resubmit stays a replay', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  await s.api('POST', '/api/menus', MENU);
  for (const b of BASELINES) await s.api('POST', '/api/reference-portions', b);
  const item = MENU.items[0]!.itemId;
  s.fixtures['ev1'] = { measurements: [{ itemId: item, remainingAreaPx: 4000 }] };
  const img = await s.uploadImage('ev1');
  assert.ok((await s.submitCapture('ev1', img)).status < 300);

  const replay = await s.submitCapture('ev1', img);
  assert.equal(replay.json.deduplicated, true, 'a resubmit never re-analyzes');
  assert.equal((await s.repo.listAnalysisAttempts('ev1')).length, 1);

  s.fixtures['ev1'] = { measurements: [{ itemId: item, remainingAreaPx: 2500 }] };
  const re = await s.api('POST', '/api/captures/ev1/reanalyze');
  assert.equal(re.status, 200, JSON.stringify(re.json));
  const attempts = await s.repo.listAnalysisAttempts('ev1');
  assert.equal(attempts.length, 2, 'appended, not replaced');
  assert.equal((await s.repo.listCaptureEvents()).length, 1, 'still one capture');
  assert.equal((await s.repo.listMeasurementsByEvent('ev1')).length, 2, 'the first attempt’s measurements are kept');
  assert.deepEqual(re.json.measurements.map((m: { remainingAreaPx: number }) => m.remainingAreaPx), [2500], 'the newest attempt is the one counted');
  assert.equal((await s.api('POST', '/api/captures/nope/reanalyze')).status, 404);
});
