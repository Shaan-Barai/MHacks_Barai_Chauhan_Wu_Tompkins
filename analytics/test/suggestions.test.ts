import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeService } from '../src/aggregates.js';
import {
  InsightCache,
  buildFallbackRecommendation,
  buildInsightMetrics,
  generateInsight,
  type TextGateway,
} from '../src/suggestions.js';
import type { CaptureEvent, FoodMeasurement, MealService } from '../src/contracts.js';

const service: MealService = {
  serviceId: 'svc_hall-main_2026-10-03_lunch',
  hallId: 'hall-main',
  hallTimezone: 'America/Detroit',
  serviceDate: '2026-10-03',
  mealLabel: 'lunch',
  menuId: 'menu_1',
  menuVersion: 1,
};

const capture: CaptureEvent = {
  eventId: 'c1',
  hallId: 'hall-main',
  serviceId: service.serviceId,
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
};

const measurement: FoodMeasurement = {
  measurementId: 'm1',
  eventId: 'c1',
  attemptId: 'a1',
  itemId: 'item_eggs',
  remainingAreaPx: 14880,
  baselineId: 'base_eggs',
  baselineAreaPx: 48000,
  rawWasteFraction: 0.31,
  displayWastePercent: 31,
  method: 'gemini_area_estimate',
  qualityFlags: ['ai_estimate'],
};

const summary = summarizeService({
  service,
  captures: [capture],
  measurements: [measurement],
  attendance: {
    hallId: 'hall-main',
    serviceId: service.serviceId,
    serviceDate: '2026-10-03',
    count: 742,
    source: 'simulated',
    configuredMin: 300,
    configuredMax: 1200,
    seed: 'demo-seed-1',
    generatorVersion: 'attendance-gen-v1',
  },
  menuItems: [{ itemId: 'item_eggs', menuId: 'menu_1', displayName: 'Scrambled Eggs' }],
});

describe('buildInsightMetrics / fallback', () => {
  it('includes top item and coverage facts', () => {
    const metrics = buildInsightMetrics(summary, [
      { itemId: 'item_eggs', menuId: 'menu_1', displayName: 'Scrambled Eggs' },
    ]);
    assert.equal(metrics['topItemName'], 'Scrambled Eggs');
    assert.equal(metrics['topItemWastePercent'], 31);
    assert.equal(metrics['analyzedCaptures'], 1);
    assert.equal(metrics['simulatedAttendance'], 742);
  });

  it('fallback mentions the top item and AI estimates in plain words', () => {
    const metrics = buildInsightMetrics(summary, [
      { itemId: 'item_eggs', menuId: 'menu_1', displayName: 'Scrambled Eggs' },
    ]);
    const text = buildFallbackRecommendation(summary, metrics);
    assert.match(text, /Scrambled Eggs/);
    assert.match(text, /AI estimate/i);
    assert.match(text, /not proof/i);
    assert.doesNotMatch(text, /\u2014|pixel|baseline/i);
  });
});

describe('generateInsight', () => {
  it('uses the gateway when available', async () => {
    const gateway: TextGateway = {
      async generateText() {
        return 'Try a smaller scoop for Scrambled Eggs based on the observed leftover area.';
      },
    };
    const insight = await generateInsight(
      {
        hallId: 'hall-main',
        windowStart: '2026-10-03T00:00:00Z',
        windowEnd: '2026-10-03T23:59:59Z',
        summary,
        menuItems: [{ itemId: 'item_eggs', menuId: 'menu_1', displayName: 'Scrambled Eggs' }],
        now: () => new Date('2026-10-03T17:00:00Z'),
        idFactory: () => 'ins_test',
      },
      { gateway },
    );
    assert.equal(insight.source, 'gemini');
    assert.equal(insight.insightId, 'ins_test');
    assert.match(insight.recommendation, /smaller scoop/);
    assert.equal(insight.generatedAt, '2026-10-03T17:00:00.000Z');
  });

  it('falls back when the gateway throws', async () => {
    const gateway: TextGateway = {
      async generateText() {
        throw new Error('provider down');
      },
    };
    const insight = await generateInsight(
      {
        hallId: 'hall-main',
        windowStart: '2026-10-03T00:00:00Z',
        windowEnd: '2026-10-03T23:59:59Z',
        summary,
        menuItems: [{ itemId: 'item_eggs', menuId: 'menu_1', displayName: 'Scrambled Eggs' }],
        idFactory: () => 'ins_fb',
      },
      { gateway },
    );
    assert.equal(insight.source, 'fallback_rules');
    assert.match(insight.recommendation, /Scrambled Eggs/);
  });

  it('falls back when no gateway is configured', async () => {
    const insight = await generateInsight({
      hallId: 'hall-main',
      windowStart: '2026-10-03T00:00:00Z',
      windowEnd: '2026-10-03T23:59:59Z',
      summary,
      idFactory: () => 'ins_nogw',
    });
    assert.equal(insight.source, 'fallback_rules');
  });
});

describe('InsightCache', () => {
  it('reuses insights for the same dataVersion', async () => {
    const cache = new InsightCache();
    let calls = 0;
    const gateway: TextGateway = {
      async generateText() {
        calls += 1;
        return 'Recommendation A';
      },
    };
    const req = {
      hallId: 'hall-main',
      windowStart: '2026-10-03T00:00:00Z',
      windowEnd: '2026-10-03T23:59:59Z',
      summary,
      idFactory: () => `ins_${calls}`,
    };
    const first = await cache.getOrGenerate(req, { gateway });
    const second = await cache.getOrGenerate(req, { gateway });
    assert.equal(calls, 1);
    assert.equal(first, second);
  });
});
