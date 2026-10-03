import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadAllScenarios,
  loadContractSamples,
  loadManifest,
  listScenarioFiles,
} from './helpers/load.mjs';
import { computeWasteParts, hasFlag } from './helpers/measurement.mjs';
import { aggregateEligibleMeasurements, assertClose, perAttendee } from './helpers/aggregate.mjs';

describe('fixture manifest', () => {
  it('registers every scenario file exactly once', () => {
    const manifest = loadManifest();
    const filesOnDisk = listScenarioFiles();
    const filesInManifest = manifest.scenarios.map((s) => s.file.replace(/^scenarios\//, '')).sort();
    assert.deepEqual(filesInManifest, filesOnDisk);
    const ids = manifest.scenarios.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('loads contract samples with required entities', () => {
    const samples = loadContractSamples();
    for (const key of [
      'mealService',
      'menuItem',
      'referencePortion',
      'imageObject',
      'captureEvent',
      'analysisAttempt',
      'foodMeasurement',
      'attendance',
      'insight',
      'apiError',
    ]) {
      assert.ok(samples[key], `missing sample ${key}`);
    }
    assert.equal(samples.imageObject.state, 'finalized');
    assert.equal(samples.attendance.source, 'simulated');
    assert.ok(samples.foodMeasurement.qualityFlags.includes('ai_estimate'));
  });
});

describe('scenario: vertical-slice', () => {
  it('matches hand-calculated aggregates and labels', () => {
    const scenario = loadAllScenarios().find((s) => s.id === 'vertical-slice').data;
    const agg = aggregateEligibleMeasurements(scenario.input.foodMeasurements);
    assertClose(agg.observedRemainingAreaPx, scenario.expected.aggregates.observedRemainingAreaPx);
    assertClose(agg.overallWastePercent, scenario.expected.aggregates.overallWastePercent);
    assert.equal(agg.eligibleMeasurementCount, 1);
    const per = perAttendee(agg.observedRemainingAreaPx, scenario.input.attendance.count);
    assertClose(per, scenario.expected.aggregates.observedRemainingAreaPxPerAttendee);
    for (const label of scenario.expected.requiredLabels) {
      const blob = JSON.stringify(scenario.input);
      assert.ok(blob.includes(label) || scenario.input.attendance.source === label || scenario.input.captureEvent.source === label);
    }
    assert.equal(scenario.input.imageObject.objectKey.includes('http'), false);
  });
});

describe('scenario: unknown-food', () => {
  it('excludes unknown items from menu aggregates but keeps their area on the record', () => {
    const scenario = loadAllScenarios().find((s) => s.id === 'unknown-food').data;
    const unknown = scenario.input.foodMeasurements.find((m) => m.itemId == null);
    assert.equal(unknown.remainingAreaPx, 12000);
    const agg = aggregateEligibleMeasurements(scenario.input.foodMeasurements);
    assert.equal(agg.eligibleMeasurementCount, scenario.expected.aggregates.eligibleMeasurementCount);
    assert.equal(agg.excludedMeasurementCount, scenario.expected.aggregates.excludedMeasurementCount);
    assertClose(agg.overallWastePercent, scenario.expected.aggregates.overallWastePercent);
  });
});

describe('scenario: missing-baseline', () => {
  it('never guesses zero waste when baseline is missing or invalid', () => {
    const scenario = loadAllScenarios().find((s) => s.id === 'missing-baseline').data;
    for (const m of scenario.input.foodMeasurements) {
      const parts = computeWasteParts(m.remainingAreaPx, m.baselineAreaPx);
      assert.equal(parts.displayWastePercent, undefined);
      assert.ok(parts.unavailableReason);
      assert.notEqual(parts.displayWastePercent, 0);
    }
    const agg = aggregateEligibleMeasurements(scenario.input.foodMeasurements);
    assert.equal(agg.overallWastePercent, null);
    assert.equal(agg.eligibleMeasurementCount, 0);
  });
});

describe('scenario: empty-plate', () => {
  it('allows zero leftover for an assessed serving with a valid baseline', () => {
    const scenario = loadAllScenarios().find((s) => s.id === 'empty-plate').data;
    assert.ok(scenario.input.captureEvent.qualityFlags.includes('empty_plate'));
    const agg = aggregateEligibleMeasurements(scenario.input.foodMeasurements);
    assertClose(agg.observedRemainingAreaPx, 0);
    assertClose(agg.overallWastePercent, 0);
  });
});

describe('scenario: above-baseline', () => {
  it('flags above-baseline and excludes it from ordinary aggregates', () => {
    const scenario = loadAllScenarios().find((s) => s.id === 'above-baseline').data;
    const above = scenario.input.foodMeasurements.find((m) => m.rawWasteFraction > 1);
    assert.ok(hasFlag(above, 'above_baseline'));
    assert.equal(above.displayWastePercent, 100);
    const agg = aggregateEligibleMeasurements(scenario.input.foodMeasurements);
    assert.equal(agg.eligibleMeasurementCount, 1);
    assertClose(agg.overallWastePercent, 50);
  });
});
