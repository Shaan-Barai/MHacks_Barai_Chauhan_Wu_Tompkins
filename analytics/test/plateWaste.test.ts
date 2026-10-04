import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { averagePlateWaste, plateWastePercent } from '../src/plateWaste.js';
import { readableItemName } from '../src/names.js';
import type { CaptureEvent, FoodMeasurement } from '../src/contracts.js';

function capture(eventId: string, state: CaptureEvent['state'] = 'succeeded'): CaptureEvent {
  return {
    eventId, hallId: 'hall-main', serviceId: 'svc_1', capturedAt: '2026-10-03T16:00:00Z',
    imageObjectId: `img_${eventId}`, geometry: { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' },
    source: 'replay', qualityFlags: [], state,
  };
}

function m(eventId: string, itemId: string | null, remaining: number, baseline?: number): FoodMeasurement {
  return {
    measurementId: `meas_${eventId}_${itemId}`, eventId, attemptId: `att_${eventId}`, itemId,
    remainingAreaPx: remaining, method: 'gemini_area_estimate', qualityFlags: ['ai_estimate'],
    ...(baseline === undefined ? {} : { baselineAreaPx: baseline }),
  };
}

describe('plateWastePercent', () => {
  it('weights items on a plate by their full serving', () => {
    // (30 + 0) / (100 + 50) = 20%
    assert.equal(plateWastePercent(capture('a'), [m('a', 'eggs', 30, 100), m('a', 'toast', 0, 50)]), 20);
  });

  it('counts a clean plate (no leftovers) as 0%', () => {
    assert.equal(plateWastePercent(capture('a'), []), 0);
  });

  it('caps an item measured above a full serving at 100%', () => {
    assert.equal(plateWastePercent(capture('a'), [m('a', 'eggs', 150, 100)]), 100);
  });

  it('ignores unknown food and is unavailable when nothing usable is left', () => {
    assert.equal(plateWastePercent(capture('a'), [m('a', null, 40), m('a', 'eggs', 10, 100)]), 10);
    assert.equal(plateWastePercent(capture('a'), [m('a', null, 40)]), null);
  });

  it('is unavailable for plates that did not succeed', () => {
    assert.equal(plateWastePercent(capture('a', 'failed'), []), null);
  });
});

describe('averagePlateWaste', () => {
  it('averages plates and reports the ones without a percent separately', () => {
    assert.deepEqual(averagePlateWaste([0, 50, 100, null]), {
      averagePlateWastePercent: 50, platesCounted: 3, platesWithoutPercent: 1,
    });
    assert.equal(averagePlateWaste([null]).averagePlateWastePercent, null);
  });
});

describe('readableItemName', () => {
  it('turns a stable item ID into a display name', () => {
    assert.equal(readableItemName('item_hall-main_2026-10-03_lunch_margherita-flatbread'), 'Margherita Flatbread');
  });
});
