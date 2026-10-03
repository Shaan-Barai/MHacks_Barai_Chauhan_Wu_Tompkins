import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyMeasurement,
  classifyCapture,
  emptyExclusionCounts,
} from '../src/eligibility.js';
import type { CaptureEvent, FoodMeasurement } from '../src/contracts.js';

function measurement(overrides: Partial<FoodMeasurement> = {}): FoodMeasurement {
  return {
    measurementId: 'meas_1',
    eventId: 'cap_1',
    attemptId: 'att_1',
    itemId: 'item_eggs',
    remainingAreaPx: 10000,
    baselineId: 'base_eggs',
    baselineAreaPx: 40000,
    rawWasteFraction: 0.25,
    displayWastePercent: 25,
    method: 'gemini_area_estimate',
    qualityFlags: ['ai_estimate'],
    ...overrides,
  };
}

function capture(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    eventId: 'cap_1',
    hallId: 'hall-main',
    serviceId: 'svc_1',
    capturedAt: '2026-10-03T16:00:00Z',
    imageObjectId: 'img_1',
    geometry: {
      widthPx: 1024,
      heightPx: 1024,
      coordinateSpace: 'topdown-normalized-v1',
    },
    source: 'replay',
    qualityFlags: [],
    state: 'succeeded',
    ...overrides,
  };
}

describe('classifyMeasurement', () => {
  it('accepts a valid known-item measurement', () => {
    assert.deepEqual(classifyMeasurement(measurement()), { eligible: true });
  });

  it('rejects unknown items', () => {
    assert.deepEqual(classifyMeasurement(measurement({ itemId: null })), {
      eligible: false,
      reason: 'unknown_item',
    });
  });

  it('rejects missing baselines', () => {
    const m = measurement();
    delete m.baselineAreaPx;
    assert.deepEqual(classifyMeasurement(m), {
      eligible: false,
      reason: 'missing_baseline',
    });
  });

  it('rejects zero/invalid baselines', () => {
    assert.equal(classifyMeasurement(measurement({ baselineAreaPx: 0 })).reason, 'invalid_baseline');
    assert.equal(
      classifyMeasurement(measurement({ baselineAreaPx: Number.NaN })).reason,
      'invalid_baseline',
    );
  });

  it('rejects above-baseline via flag or raw fraction', () => {
    assert.equal(
      classifyMeasurement(measurement({ qualityFlags: ['ai_estimate', 'above_baseline'] })).reason,
      'above_baseline',
    );
    assert.equal(
      classifyMeasurement(measurement({ rawWasteFraction: 1.2, displayWastePercent: 100 })).reason,
      'above_baseline',
    );
  });

  it('rejects invalid remaining area', () => {
    assert.equal(
      classifyMeasurement(measurement({ remainingAreaPx: -1 })).reason,
      'invalid_remaining',
    );
  });
});

describe('classifyCapture', () => {
  it('accepts succeeded captures', () => {
    assert.deepEqual(classifyCapture(capture()), { eligible: true });
  });

  it('rejects failed and needs_review', () => {
    assert.equal(classifyCapture(capture({ state: 'failed' })).reason, 'capture_not_succeeded');
    assert.equal(classifyCapture(capture({ state: 'needs_review' })).reason, 'capture_not_succeeded');
  });
});

describe('emptyExclusionCounts', () => {
  it('starts every reason at zero', () => {
    const counts = emptyExclusionCounts();
    for (const v of Object.values(counts)) assert.equal(v, 0);
  });
});
