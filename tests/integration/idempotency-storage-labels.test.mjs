import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectForbiddenByteFields, loadAllScenarios } from './helpers/load.mjs';

describe('idempotent capture retries', () => {
  it('keeps one capture event while preserving multiple analysis attempts', () => {
    const scenario = loadAllScenarios().find((s) => s.id === 'repeated-capture').data;
    const eventIds = scenario.input.resultingCaptureEvents.map((e) => e.eventId);
    assert.equal(new Set(eventIds).size, scenario.expected.uniqueCaptureEventCount);
    assert.equal(scenario.input.resultingAnalysisAttempts.length, scenario.expected.analysisAttemptCount);
    assert.equal(
      new Set(scenario.input.ingestAttempts.map((a) => a.eventId)).size,
      scenario.expected.uniqueCaptureEventCount,
    );
  });
});

describe('simulated attendance stability', () => {
  it('returns the same count for repeated reads of one service and stays in range', () => {
    const scenario = loadAllScenarios().find((s) => s.id === 'attendance-stable').data;
    const { configuredMin, configuredMax } = scenario.input.generator;
    const byService = new Map();
    for (const row of scenario.input.persisted) {
      assert.equal(row.source, 'simulated');
      assert.ok(row.count >= configuredMin && row.count <= configuredMax);
      const key = `${row.hallId}|${row.serviceDate}|${row.serviceId}`;
      if (!byService.has(key)) byService.set(key, row.count);
      else assert.equal(byService.get(key), row.count);
    }
    const lunch = scenario.input.persisted.filter((r) => r.serviceId.endsWith('_lunch'));
    const dinner = scenario.input.persisted.filter((r) => r.serviceId.endsWith('_dinner'));
    assert.equal(lunch[0].count, lunch[1].count);
    assert.notEqual(lunch[0].count, dinner[0].count);
  });
});

describe('storage references only', () => {
  it('rejects image byte fields on SpacetimeDB-shaped rows', () => {
    const scenario = loadAllScenarios().find((s) => s.id === 'storage-refs-only').data;
    const hits = collectForbiddenByteFields(
      scenario.input.spacetimeRows,
      scenario.input.forbiddenFieldsIfPresent,
    );
    assert.deepEqual(hits, []);
    for (const row of scenario.input.spacetimeRows) {
      for (const field of scenario.input.permanentIdentityFields) {
        assert.ok(row[field], `missing identity field ${field}`);
      }
      assert.equal(Object.prototype.hasOwnProperty.call(row, 'readUrl'), false);
    }
    assert.ok(scenario.input.accessResponse.readUrl);
    assert.ok(scenario.input.accessResponse.expiresAt);
    assert.notEqual(scenario.input.accessResponse.readUrl, scenario.input.spacetimeRows[0].objectKey);
  });
});

describe('upload / finalization failure paths', () => {
  it('encodes provider-agnostic failure cases', () => {
    const scenario = loadAllScenarios().find((s) => s.id === 'upload-failures').data;
    assert.equal(scenario.expected.uploadAndDbWriteAreSeparate, true);
    assert.equal(scenario.expected.providerAgnostic, true);

    const byName = Object.fromEntries(scenario.input.cases.map((c) => [c.name, c]));
    assert.equal(byName.upload_failed_before_finalize.mayRegisterCapture, false);
    assert.equal(byName.orphan_uploaded_not_finalized.cleanupEligible, true);
    assert.equal(
      byName.repeated_finalization_idempotent.expectedUniqueFinalizedCount,
      1,
    );
    assert.equal(byName.missing_object_on_read.error.code, 'OBJECT_NOT_FOUND');

    const expired = byName.expired_read_url;
    assert.ok(expired.access.now > expired.access.expiresAt);
    assert.equal(expired.expected.action, 'renew_read_url');
  });
});

describe('dashboard labels', () => {
  it('requires demo/simulated/estimate phrasing and forbids overclaiming units', () => {
    const scenario = loadAllScenarios().find((s) => s.id === 'dashboard-labels').data;
    for (const candidate of scenario.input.dashboardCopyCandidates) {
      assert.ok(candidate.requiredPhrases.length > 0);
    }
    for (const claim of scenario.input.forbiddenClaims) {
      assert.equal(typeof claim, 'string');
      assert.ok(claim.length > 0);
    }
  });
});
