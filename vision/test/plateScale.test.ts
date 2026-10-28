/** Run 3 plate-scale-v1: the plate's pixel diameter from the target-dish box, only for a fully visible round plate. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measurePlate, PLATE_SCALE_VERSION } from '../src/index.js';

const box = (x0: number, y0: number, x1: number, y1: number) => ({ pixelXyxy: [x0, y0, x1, y1] as [number, number, number, number] });

test('a fully visible round plate: diameter = mean of box width and height', () => {
  const r = measurePlate({ dishType: 'plate', fullyVisible: true, box: box(100, 120, 980, 1020) }); // 880 × 900
  assert.deepEqual(r, { ok: true, version: PLATE_SCALE_VERSION, diameterPx: 890, boxWidthPx: 880, boxHeightPx: 900 });
});

test('no scale for bowls, cut-off or oval plates, tiny boxes, or no dish', () => {
  assert.equal(measurePlate(null).ok, false);
  const reason = (d: Parameters<typeof measurePlate>[0]) => {
    const r = measurePlate(d);
    return r.ok ? 'ok' : r.reason;
  };
  assert.equal(reason({ dishType: 'bowl', fullyVisible: true, box: box(0, 0, 500, 500) }), 'not_a_plate');
  assert.equal(reason({ dishType: 'plate', fullyVisible: false, box: box(0, 0, 500, 500) }), 'not_fully_visible');
  assert.equal(reason({ dishType: 'plate', box: box(0, 0, 500, 500) }), 'not_fully_visible');
  assert.equal(reason({ dishType: 'plate', fullyVisible: true, box: box(0, 0, 700, 500) }), 'not_round'); // 1.4 > 1.25
  assert.equal(reason({ dishType: 'plate', fullyVisible: true, box: box(0, 0, 40, 40) }), 'too_small');
  assert.equal(reason({ dishType: 'plate', fullyVisible: true }), 'no_dish');
});
