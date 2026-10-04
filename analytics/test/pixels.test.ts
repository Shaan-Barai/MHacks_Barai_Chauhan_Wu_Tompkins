import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizePixels, computePixelDataVersion } from '../src/pixels.js';
import { generatePixelInsight } from '../src/pixelSuggestions.js';
import type { AnalysisAttempt, CaptureEvent, FoodMeasurement, MealService, SegmentationResult } from '../src/contracts.js';

const service: MealService = {
  serviceId: 'svc_h_2026-10-03_lunch',
  hallId: 'h',
  hallTimezone: 'America/Detroit',
  serviceDate: '2026-10-03',
  mealLabel: 'lunch',
  menuId: 'm',
  menuVersion: 1,
};
const G = { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' as const };

function capture(id: string, state: CaptureEvent['state'] = 'succeeded', geometry = G): CaptureEvent {
  return { eventId: id, hallId: 'h', serviceId: service.serviceId, capturedAt: '2026-10-03T16:00:00Z', imageObjectId: `img_${id}`, geometry, source: 'replay', qualityFlags: [], state };
}
function attempt(id: string, seg?: Partial<SegmentationResult>, status: AnalysisAttempt['status'] = 'succeeded'): AnalysisAttempt {
  return {
    eventId: id,
    attemptId: `att_${id}`,
    menuId: 'm',
    menuVersion: 1,
    baselineVersions: {},
    model: 'gemini',
    promptVersion: 'p',
    status,
    qualityFlags: ['ai_estimate'],
    createdAt: '2026-10-03T16:00:05Z',
    ...(seg
      ? {
          segmentation: {
            model: 'sam2.1-hiera-small',
            checkpoint: 'c',
            codeRevision: 'r',
            promptSource: 'gemini_box',
            settingsVersion: 's',
            countingRuleVersion: 'smallest-first-v1',
            status: 'succeeded',
            countStatus: 'complete',
            widthPx: 1024,
            heightPx: 1024,
            regions: [],
            ...seg,
          } as SegmentationResult,
        }
      : {}),
  };
}
function m(id: string, itemId: string | null, px: number, method: FoodMeasurement['method'] = 'mask_pixel_count'): FoodMeasurement {
  return { measurementId: `${id}_${itemId}`, eventId: id, attemptId: `att_${id}`, itemId, remainingAreaPx: px, unavailableReason: 'x', method, qualityFlags: ['ai_estimate'] };
}

test('hand-calculated Pixels wasted: only complete and empty captures count; exclusions by reason', () => {
  const captures = [
    capture('a'), // complete: burger 200 + fries 300 + unclassified 100 = 600
    capture('b'), // complete: fries 150 = 150
    capture('e'), // explicit empty plate: 0, still counted
    capture('p', 'needs_review'), // partial segmentation
    capture('f', 'failed'),
    capture('l'), // legacy Gemini area estimate (no segmentation)
    capture('g', 'succeeded', { ...G, widthPx: 512, heightPx: 512 }), // other geometry
    capture('w', 'processing'),
  ];
  const counted = new Map([
    ['a', attempt('a', { capturePixelsWasted: 600 })],
    ['b', attempt('b', { capturePixelsWasted: 150 })],
    ['e', attempt('e', { countStatus: 'empty', status: 'skipped', capturePixelsWasted: 0 })],
    ['l', attempt('l')],
    ['g', attempt('g', { capturePixelsWasted: 999, widthPx: 512, heightPx: 512 })],
  ]);
  const latest = new Map([['p', attempt('p', { countStatus: 'partial', status: 'partial', capturePixelsWasted: 40 }, 'needs_review')]]);
  const s = summarizePixels({
    service,
    captures,
    countedAttempts: counted,
    latestAttempts: latest,
    measurements: [m('a', 'burger', 200), m('a', 'fries', 300), m('a', null, 100), m('b', 'fries', 150), m('l', 'burger', 5000, 'gemini_area_estimate'), m('g', 'burger', 999)],
    attendance: { hallId: 'h', serviceId: service.serviceId, serviceDate: '2026-10-03', count: 500, source: 'simulated', configuredMin: 300, configuredMax: 1200, generatorVersion: 'v' },
    menuItems: [{ itemId: 'fries', menuId: 'm', displayName: 'Fries' }],
  });
  assert.equal(s.pixelsWasted, 750);
  assert.equal(s.countedCaptureCount, 3);
  assert.equal(s.emptyPlateCount, 1);
  assert.equal(s.excludedCaptureCount, 5);
  assert.deepEqual(s.exclusionReasons, {
    not_analyzed: 1,
    analysis_failed: 1,
    needs_review: 0,
    partial_segmentation: 1,
    count_unavailable: 0,
    legacy_estimate: 1,
    incompatible_geometry: 1,
  });
  assert.equal(s.unclassifiedPixels, 100);
  assert.deepEqual(
    s.items.map((i) => [i.itemId, i.pixelsWasted, i.captures, i.shareOfMealPixelsPercent]),
    [
      ['fries', 450, 2, 60],
      ['burger', 200, 1, (100 * 200) / 750],
    ],
  );
  assert.equal(s.items[0]!.displayName, 'Fries');
  assert.equal(s.pixelsPerSimulatedAttendee, 750 / 500);
  assert.equal(s.geometryKey, '1024x1024 topdown-normalized-v1');
});

test('no counted plates: zero total but null shares and per-attendee, never a fake zero waste rate', () => {
  const s = summarizePixels({ service, captures: [capture('f', 'failed')], countedAttempts: new Map(), measurements: [] });
  assert.equal(s.pixelsWasted, 0);
  assert.equal(s.countedCaptureCount, 0);
  assert.equal(s.pixelsPerSimulatedAttendee, null);
  assert.equal(s.exclusionReasons.analysis_failed, 1);
});

test('pixel insight cites measured pixels; fallback is labeled and data-versioned', async () => {
  const s = summarizePixels({
    service,
    captures: [capture('a')],
    countedAttempts: new Map([['a', attempt('a', { capturePixelsWasted: 600 })]]),
    measurements: [m('a', 'fries', 450), m('a', null, 150)],
    menuItems: [{ itemId: 'fries', menuId: 'm', displayName: 'Fries' }],
  });
  const ins = await generatePixelInsight({ hallId: 'h', windowStart: 'a', windowEnd: 'b', summary: s, idFactory: () => 'ins1' });
  assert.equal(ins.source, 'fallback_rules');
  assert.match(ins.recommendation, /Fries made up 75% of lunch's wasted pixels \(450 of 600\)/);
  assert.equal(ins.dataVersion, computePixelDataVersion(s));
  const live = await generatePixelInsight(
    { hallId: 'h', windowStart: 'a', windowEnd: 'b', summary: s },
    { gateway: { generateText: async () => '  Review the fries scoop.  ' } },
  );
  assert.deepEqual([live.source, live.recommendation], ['gemini', 'Review the fries scoop.']);
});
