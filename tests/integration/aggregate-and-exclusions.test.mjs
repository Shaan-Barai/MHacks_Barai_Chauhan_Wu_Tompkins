import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadAllScenarios } from './helpers/load.mjs';
import { aggregateEligibleMeasurements, assertClose, perAttendee } from './helpers/aggregate.mjs';
import { findOverlappingPixelIds } from './helpers/measurement.mjs';

describe('aggregate arithmetic (hand-calculated)', () => {
  it('uses area-weighted overall percent, not a simple average of item percents', () => {
    const scenario = loadAllScenarios().find((s) => s.id === 'aggregate-handcalc').data;
    const byId = Object.fromEntries(scenario.input.foodMeasurements.map((m) => [m.measurementId, m]));

    const equalGroup = scenario.input.groups.equal_item_percents.map((id) => byId[id]);
    const equalAgg = aggregateEligibleMeasurements(equalGroup);
    assertClose(equalAgg.observedRemainingAreaPx, scenario.expected.equal_item_percents.observedRemainingAreaPx);
    assertClose(equalAgg.sumBaselineAreaPx, scenario.expected.equal_item_percents.sumBaselineAreaPx);
    assertClose(equalAgg.overallWastePercent, scenario.expected.equal_item_percents.overallWastePercent);

    const unequalGroup = scenario.input.groups.unequal_item_percents.map((id) => byId[id]);
    const unequalAgg = aggregateEligibleMeasurements(unequalGroup);
    assertClose(unequalAgg.observedRemainingAreaPx, scenario.expected.unequal_item_percents.observedRemainingAreaPx);
    assertClose(unequalAgg.overallWastePercent, scenario.expected.unequal_item_percents.overallWastePercent);

    const simpleAvg = scenario.expected.unequal_item_percents.simpleAverageOfItemPercents;
    assert.notEqual(Math.round(unequalAgg.overallWastePercent * 1e6), Math.round(simpleAvg * 1e6));

    const per = perAttendee(equalAgg.observedRemainingAreaPx, scenario.input.attendance.count);
    assertClose(per, scenario.expected.perAttendeeForEqualGroup);
  });

  it('returns unavailable per-attendee when attendance is missing or zero', () => {
    assert.equal(perAttendee(1000, 0), null);
    assert.equal(perAttendee(1000, null), null);
    assert.equal(perAttendee(null, 500), null);
  });
});

describe('filter isolation', () => {
  it('aggregates only the matching hall/date/service', () => {
    const scenario = loadAllScenarios().find((s) => s.id === 'filter-isolation').data;
    const { filter, captures, foodMeasurements } = scenario.input;
    const matchedIds = new Set(
      captures
        .filter(
          (c) =>
            c.hallId === filter.hallId &&
            c.serviceDate === filter.serviceDate &&
            c.serviceId === filter.serviceId,
        )
        .map((c) => c.eventId),
    );
    assert.deepEqual([...matchedIds].sort(), scenario.expected.matchedEventIds);
    const filtered = foodMeasurements.filter((m) => matchedIds.has(m.eventId));
    const agg = aggregateEligibleMeasurements(filtered);
    assertClose(agg.observedRemainingAreaPx, scenario.expected.aggregates.observedRemainingAreaPx);
    assertClose(agg.overallWastePercent, scenario.expected.aggregates.overallWastePercent);
  });
});

describe('overlapping areas', () => {
  it('detects shared pixel assignments', () => {
    const scenario = loadAllScenarios().find((s) => s.id === 'overlapping-areas').data;
    const overlaps = findOverlappingPixelIds(scenario.input.regionAssignments);
    assert.deepEqual(overlaps, scenario.expected.overlappingPixelIds);
    assert.equal(scenario.input.analysisAttempt.status, 'needs_review');
    assert.equal(scenario.input.analysisAttempt.error.code, 'OVERLAPPING_FOOD_AREAS');
  });
});

describe('invalid / failed analysis exclusion', () => {
  it('does not treat failed observations as zero waste', () => {
    const scenario = loadAllScenarios().find((s) => s.id === 'invalid-analysis').data;
    const failedIds = new Set(scenario.expected.excludedFailedEventIds);
    for (const placeholder of scenario.input.failedObservationPlaceholders) {
      assert.ok(failedIds.has(placeholder.eventId));
      assert.equal(placeholder.note, 'MUST_NOT_ENTER_AGGREGATES');
    }
    const agg = aggregateEligibleMeasurements(scenario.input.foodMeasurements);
    assertClose(agg.overallWastePercent, 30);
    assert.equal(scenario.input.analysisAttempts.length, scenario.expected.exclusionCount);
  });
});
