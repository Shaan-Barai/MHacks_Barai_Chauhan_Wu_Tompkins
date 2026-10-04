/**
 * IT_4 I7/I8: estimated grams, kg CO2e and litres of water. Every expected
 * value below is hand-calculated in the comment next to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImpactDashboard,
  captureItemPhysical,
  computePhysicalAmounts,
  computeWasteImpact,
  fallbackRecommendation,
  formatCo2e,
  formatGrams,
  formatPhysicalLabel,
  formatWaterLitres,
  generateRecommendation,
  parseRecommendationOutput,
  physicalImpactCoverage,
  recommendationFacts,
  recommendationInputVersion,
  selectImpactMeasurements,
  sumImpacts,
  UNKNOWN_FOOD_LABEL,
  type ImpactDashboardInput,
  type ImpactMeasurementInput,
} from '../src/index.js';
import type {
  CaptureEvent,
  FoodMeasurement,
  MealService,
  MenuItem,
  PhysicalEstimate,
  PortionsServed,
  WasteFactor,
} from '../src/contracts.js';

// Rows from menu_waste_factors.csv (waste-factors-v3).
const STEAK: WasteFactor = {
  factorKey: 'ancho-flank-steak', food: 'Ancho Flank Steak', station: 'Halal',
  weightGPerCm2: 1.2, kgCo2ePerKg: 131.69, waterM3PerKg: 1.925, impactUsdPerKg: 27.91, largestFactor: 'carbon', densityGPerCm3: 0.7,
};
const RICE: WasteFactor = {
  factorKey: 'sticky-rice', food: 'Sticky Rice', station: 'Halal',
  weightGPerCm2: 1.6, kgCo2ePerKg: 1.78, waterM3PerKg: 0.899, impactUsdPerKg: 1.69, largestFactor: 'water', densityGPerCm3: 0.73,
};
const PIZZA: WasteFactor = {
  factorKey: 'pepperoni-pizza', food: 'Pepperoni Pizza', station: 'Pizziti',
  weightGPerCm2: 1.0, kgCo2ePerKg: 16.06, waterM3PerKg: 1.94, impactUsdPerKg: 5.96, largestFactor: 'carbon', densityGPerCm3: null,
};
const SOUP: WasteFactor = {
  factorKey: 'broccoli-cheddar-soup', food: 'Broccoli Cheddar Soup', station: 'Soup',
  weightGPerCm2: 1.5, kgCo2ePerKg: 4.9, waterM3PerKg: 1.07, impactUsdPerKg: 2.54, largestFactor: 'water', densityGPerCm3: 1.05,
};

const close = (actual: number | null | undefined, expected: number, eps = 1e-9) =>
  assert.ok(actual != null && Math.abs(actual - expected) <= eps, `${actual} !== ${expected}`);

const area = (areaCm2: number): PhysicalEstimate => ({
  calibrationId: 'cal-1', method: 'area-calibrated-v1', areaCm2, volumeCm3: null, meanHeightMm: null, maxHeightMm: null, flags: [],
});
const volume = (volumeCm3: number, areaCm2: number, flags: PhysicalEstimate['flags'] = []): PhysicalEstimate => ({
  calibrationId: 'cal-1', method: 'volume-dav2-v1', areaCm2, volumeCm3, meanHeightMm: 20, maxHeightMm: 35,
  depthSettingsVersion: 'dav2-metric-small-v1', plateReference: 'dish-ring-fit', flags,
});

test('area method: grams = areaCm2 × weight_g_per_cm2; kg CO2e = g/1000 × C; L water = g × W', () => {
  const p = computePhysicalAmounts({ physical: area(20), factor: STEAK });
  close(p.grams, 24); // 20 cm² × 1.2 g/cm²
  close(p.kgCo2e, 3.16056); // 24 / 1000 × 131.69
  close(p.waterLitres, 46.2); // 24 × 1.925 (m³/kg ⇒ g/1000 × W × 1000 L)
  assert.equal(p.physicalMethod, 'area-calibrated-v1');
  assert.equal(p.physicalUnavailableReason, undefined);
  assert.ok(!('physicalUnavailableReason' in p));

  // Points are unchanged by calibration; nutrition never enters CO2/water.
  const withPhys = computeWasteImpact(5000, STEAK, { factorKey: 'ancho-flank-steak', nutrientDaysPerKg: 1.05, kcalPerKg: 1600 }, { physical: area(20) });
  const without = computeWasteImpact(5000, STEAK, null, { physical: area(20) });
  close(withPhys.impactPoints, 6 * 27.91);
  assert.equal(withPhys.kgCo2e, without.kgCo2e);
  assert.equal(withPhys.waterLitres, without.waterLitres);
  close(withPhys.grams, 24);
});

test('volume method: grams = volumeCm3 × density_g_per_cm3', () => {
  const p = computePhysicalAmounts({ physical: volume(50, 40), factor: RICE });
  close(p.grams, 36.5); // 50 cm³ × 0.73 g/cm³ (not 40 cm² × 1.6 = 64)
  close(p.kgCo2e, 0.06497); // 36.5 / 1000 × 1.78
  close(p.waterLitres, 32.8135); // 36.5 × 0.899
  assert.equal(p.physicalMethod, 'volume-dav2-v1');

  const item = captureItemPhysical({ physical: volume(50, 40), factor: RICE });
  assert.deepEqual([item.volumeCm3, item.areaCm2, item.physicalMethod], [50, 40, 'volume-dav2-v1']);
  close(item.grams, 36.5);
});

test('volume method without a density falls back to the area method (reported as area-calibrated-v1)', () => {
  const p = computePhysicalAmounts({ physical: volume(40, 30), factor: PIZZA });
  close(p.grams, 30); // density null ⇒ 30 cm² × 1.0 g/cm²
  close(p.kgCo2e, 0.4818); // 30 / 1000 × 16.06
  close(p.waterLitres, 58.2); // 30 × 1.94
  assert.equal(p.physicalMethod, 'area-calibrated-v1');
  // The volume was a measurement; it is still shown in the gallery.
  assert.equal(captureItemPhysical({ physical: volume(40, 30), factor: PIZZA }).volumeCm3, 40);

  // Neither volume+density nor area+weight works ⇒ no_density, never 0.
  const noWeight = computePhysicalAmounts({ physical: volume(40, 30), factor: { ...PIZZA, weightGPerCm2: NaN } });
  assert.deepEqual([noWeight.grams, noWeight.kgCo2e, noWeight.waterLitres, noWeight.physicalMethod, noWeight.physicalUnavailableReason], [null, null, null, null, 'no_density']);
});

test('bowl_volume_unreliable (and invalid depth) ⇒ area method, volume not shown', () => {
  for (const flag of ['bowl_volume_unreliable', 'depth_invalid', 'depth_unavailable'] as const) {
    const p = computePhysicalAmounts({ physical: volume(200, 80, [flag]), factor: SOUP });
    close(p.grams, 120); // 80 cm² × 1.5 g/cm², not 200 cm³ × 1.05 = 210
    close(p.kgCo2e, 0.588); // 120 / 1000 × 4.9
    close(p.waterLitres, 128.4); // 120 × 1.07
    assert.equal(p.physicalMethod, 'area-calibrated-v1', flag);
    assert.equal(captureItemPhysical({ physical: volume(200, 80, [flag]), factor: SOUP }).volumeCm3, null);
  }
  // Other flags keep the volume.
  close(computePhysicalAmounts({ physical: volume(200, 80, ['plate_plane_from_calibration']), factor: SOUP }).grams, 210);
});

test('missing factor, unknown item, no calibration, incompatible geometry: null + reason, never 0', () => {
  const reasonOf = (p: ReturnType<typeof computePhysicalAmounts>) => [p.grams, p.kgCo2e, p.waterLitres, p.physicalMethod, p.physicalUnavailableReason];
  assert.deepEqual(reasonOf(computePhysicalAmounts({ physical: area(20), factor: null })), [null, null, null, null, 'no_factor']);
  assert.deepEqual(reasonOf(computePhysicalAmounts({ physical: area(20), factor: { ...STEAK, kgCo2ePerKg: NaN } })), [null, null, null, null, 'no_factor']);
  assert.deepEqual(reasonOf(computePhysicalAmounts({ physical: area(20), factor: STEAK, unknownItem: true })), [null, null, null, null, 'unknown_item']);
  assert.deepEqual(reasonOf(computePhysicalAmounts({ factor: STEAK })), [null, null, null, null, 'no_calibration']);
  assert.deepEqual(reasonOf(computePhysicalAmounts({ physical: null, factor: STEAK, captureReason: 'incompatible_geometry' })), [null, null, null, null, 'incompatible_geometry']);
  // An invalid stored estimate is treated as absent.
  assert.deepEqual(reasonOf(computePhysicalAmounts({ physical: area(NaN), factor: STEAK })), [null, null, null, null, 'no_calibration']);
  assert.deepEqual(reasonOf(computePhysicalAmounts({ physical: volume(-1, 10), factor: STEAK })), [null, null, null, null, 'no_calibration']);

  // Unknown food keeps its measured area in the gallery, but gets no grams.
  const unk = captureItemPhysical({ physical: area(5), factor: null, unknownItem: true });
  assert.deepEqual([unk.areaCm2, unk.volumeCm3, unk.grams, unk.physicalUnavailableReason], [5, null, null, 'unknown_item']);

  // computeWasteImpact: unknown / no factor carry both reasons.
  const u = computeWasteImpact(1000, STEAK, null, { unknownItem: true, physical: area(5) });
  assert.deepEqual([u.unavailableReason, u.grams, u.physicalUnavailableReason], ['unknown_item', null, 'unknown_item']);
  const nf = computeWasteImpact(1000, null, null, { physical: area(5) });
  assert.deepEqual([nf.unavailableReason, nf.grams, nf.physicalUnavailableReason], ['no_factor', null, 'no_factor']);

  // A measured clean mask is a real zero.
  const zero = computePhysicalAmounts({ physical: area(0), factor: STEAK });
  assert.deepEqual([zero.grams, zero.kgCo2e, zero.waterLitres, zero.physicalMethod], [0, 0, 0, 'area-calibrated-v1']);
});

test('sumImpacts: grams sum calibrated inputs only; method mixed; reason and coverage', () => {
  const a = computeWasteImpact(5000, STEAK, null, { physical: area(20) }); // 24 g
  const v = computeWasteImpact(4000, RICE, null, { physical: volume(50, 40) }); // 36.5 g
  const n = computeWasteImpact(3000, STEAK, null); // uncalibrated
  const s = sumImpacts([a, v, n]);
  close(s.grams, 60.5); // 24 + 36.5
  close(s.kgCo2e, 3.22553); // 3.16056 + 0.06497
  close(s.waterLitres, 79.0135); // 46.2 + 32.8135
  assert.equal(s.physicalMethod, 'mixed');
  assert.equal(s.physicalUnavailableReason, 'no_calibration');
  assert.equal(sumImpacts([a, a]).physicalMethod, 'area-calibrated-v1');
  assert.equal(sumImpacts([v]).physicalMethod, 'volume-dav2-v1');
  assert.equal(sumImpacts([s, a]).physicalMethod, 'mixed');
  const none = sumImpacts([n]);
  assert.deepEqual([none.grams, none.kgCo2e, none.waterLitres, none.physicalMethod, none.physicalUnavailableReason], [null, null, null, null, 'no_calibration']);
  const empty = sumImpacts([]);
  assert.deepEqual([empty.grams, empty.kgCo2e, empty.waterLitres, empty.physicalMethod], [null, null, null, null]);
  const u = computeWasteImpact(1000, null, null, { unknownItem: true, physical: area(5) });
  assert.deepEqual(physicalImpactCoverage([a, v, n, u]), {
    withGrams: 2,
    unavailable: { no_calibration: 1, incompatible_geometry: 0, unknown_item: 1, no_factor: 0, no_density: 0 },
  });
  assert.equal(sumImpacts([n, u]).physicalUnavailableReason, 'no_calibration'); // tie ⇒ capture-level reason first
  assert.equal(sumImpacts([n, u, u]).physicalUnavailableReason, 'unknown_item');
});

// ---- dashboard: mixed calibrated / uncalibrated captures -----------------

const SVC = 'svc_h_2026-10-04_dinner';
const itemId = (slug: string) => `item_h_2026-10-04_dinner_${slug}`;
const factorTable = new Map<string, WasteFactor>([['ancho flank steak', STEAK], ['sticky rice', RICE]]);
const lookups = {
  findWasteFactor: (n: string) => factorTable.get(n.trim().toLowerCase()) ?? null,
  findNutritionFactor: () => null,
};
const mi = (eventId: string, slug: string | null, displayName: string, pixels: number, physical?: PhysicalEstimate): ImpactMeasurementInput => ({
  eventId, serviceId: SVC, menuVersion: 1, itemId: slug === null ? null : itemId(slug), displayName, pixels, ...(physical ? { physical } : {}),
});
const MIXED: ImpactMeasurementInput[] = [
  mi('e1', 'ancho-flank-steak', 'Ancho Flank Steak', 5000, area(20)), // area: 24 g
  mi('e2', 'sticky-rice', 'Sticky Rice', 4000, volume(50, 40)), // volume: 36.5 g
  mi('e2', null, UNKNOWN_FOOD_LABEL, 1000, area(5)), // unknown: no grams
  mi('e3', 'ancho-flank-steak', 'Ancho Flank Steak', 3000), // uncalibrated
];
const portion = (slug: string, count: number): PortionsServed => ({
  recordId: slug, hallId: 'h', serviceId: SVC, serviceDate: '2026-10-04', menuId: 'menu_h', menuVersion: 1,
  itemId: itemId(slug), count, source: 'demo', updatedAt: '2026-10-04T23:00:00.000Z',
});
const mixedInput = (over: Partial<ImpactDashboardInput> = {}): ImpactDashboardInput => ({
  window: { start: '2026-10-04', end: '2026-10-04', hallId: 'h' },
  measurements: MIXED,
  captures: { captures: 3, analyzed: 3, excluded: 0 },
  menuItems: [],
  portions: [portion('ancho-flank-steak', 4), portion('sticky-rice', 5)],
  factors: lookups,
  ...over,
});

test('dashboard: totals sum only calibrated captures, method mixed, physical coverage', () => {
  const d = buildImpactDashboard(mixedInput());
  close(d.totals.grams, 60.5); // 24 + 36.5 (e3's steak and the unknown food are not counted)
  close(d.totals.kgCo2e, 3.22553);
  close(d.totals.waterLitres, 79.0135);
  assert.equal(d.totals.physicalMethod, 'mixed');
  assert.equal(d.totals.physicalUnavailableReason, 'no_calibration');
  assert.deepEqual(d.totals.physicalCoverage, { calibratedCaptures: 2, volumeCaptures: 1, analyzedCaptures: 3 });
  assert.equal(d.totals.pixels, 13_000); // pixels still count everything

  const steak = d.mostWasted.find((r) => r.factorKey === 'ancho-flank-steak')!;
  close(steak.impact.grams, 24); // partial: e1 only
  assert.equal(steak.impact.physicalMethod, 'area-calibrated-v1');
  assert.equal(steak.impact.physicalUnavailableReason, 'no_calibration');
  // per portion: e3 is uncalibrated, so 24 g ÷ 4 portions would understate ⇒ null
  assert.equal(steak.perPortion!.pixels, 2000); // 8000 px ÷ 4
  assert.equal(steak.perPortion!.grams, null);

  const rice = d.mostWasted.find((r) => r.factorKey === 'sticky-rice')!;
  close(rice.perPortion!.grams, 7.3); // 36.5 g ÷ 5 portions (every rice measurement calibrated)
  assert.equal(rice.impact.physicalMethod, 'volume-dav2-v1');

  const unknown = d.mostWasted.find((r) => r.itemId === null)!;
  assert.deepEqual([unknown.impact.grams, unknown.impact.physicalUnavailableReason], [null, 'unknown_item']);
});

test('dashboard: per-portion grams sum-then-divide across calibrated services', () => {
  const svc2 = 'svc_h_2026-10-05_dinner';
  const d = buildImpactDashboard(
    mixedInput({
      measurements: [
        mi('e1', 'sticky-rice', 'Sticky Rice', 4000, volume(50, 40)), // 36.5 g
        { ...mi('e9', 'sticky-rice', 'Sticky Rice', 2000, area(10)), serviceId: svc2 }, // 10 × 1.6 = 16 g
      ],
      portions: [portion('sticky-rice', 5), { ...portion('sticky-rice', 2), recordId: 'b', serviceId: svc2 }],
      captures: { captures: 2, analyzed: 2, excluded: 0 },
    }),
  );
  const rice = d.targets[0]!;
  close(rice.impact.grams, 52.5); // 36.5 + 16
  assert.equal(rice.portionsServed, 7);
  close(rice.perPortion!.grams, 7.5); // 52.5 ÷ 7, not the mean of 7.3 and 8
  assert.equal(rice.impact.physicalMethod, 'mixed');
});

test('dashboard: uncalibrated window has null physical totals; calibrated clean plates are a measured 0', () => {
  const plain = buildImpactDashboard(mixedInput({ measurements: MIXED.map(({ physical: _p, ...m }) => m) }));
  assert.deepEqual([plain.totals.grams, plain.totals.kgCo2e, plain.totals.waterLitres, plain.totals.physicalMethod], [null, null, null, null]);
  assert.equal(plain.totals.physicalUnavailableReason, 'no_calibration');
  assert.deepEqual(plain.totals.physicalCoverage, { calibratedCaptures: 0, volumeCaptures: 0, analyzedCaptures: 3 });

  const clean = buildImpactDashboard(
    mixedInput({ measurements: [], captures: { captures: 2, analyzed: 2, excluded: 0 }, physicalCoverage: { calibratedCaptures: 1, volumeCaptures: 0 } }),
  );
  assert.deepEqual([clean.totals.grams, clean.totals.kgCo2e, clean.totals.waterLitres, clean.totals.physicalMethod], [0, 0, 0, 'area-calibrated-v1']);
  assert.equal(clean.totals.physicalUnavailableReason, undefined);
  assert.deepEqual(clean.totals.physicalCoverage, { calibratedCaptures: 1, volumeCaptures: 0, analyzedCaptures: 2 });

  // Calibrated plate with only unknown food: no grams, not zero.
  const unknownOnly = buildImpactDashboard(
    mixedInput({ measurements: [mi('e2', null, UNKNOWN_FOOD_LABEL, 1000, area(5))], captures: { captures: 1, analyzed: 1, excluded: 0 } }),
  );
  assert.equal(unknownOnly.totals.grams, null);
  assert.equal(unknownOnly.totals.physicalUnavailableReason, 'unknown_item');
});

test('selectImpactMeasurements: carries physical, honors the attempt snapshot, counts calibrated clean plates', () => {
  const service: MealService = { serviceId: SVC, hallId: 'h', hallTimezone: 'America/Detroit', serviceDate: '2026-10-04', mealLabel: 'dinner', menuId: 'menu_h', menuVersion: 1 };
  const menuItems: MenuItem[] = [{ itemId: itemId('sticky-rice'), menuId: 'menu_h', displayName: 'Sticky Rice' }];
  const geometry = { widthPx: 1920, heightPx: 1080, coordinateSpace: 'topdown-normalized-v1' as const };
  const capture = (eventId: string): CaptureEvent => ({
    eventId, hallId: 'h', serviceId: SVC, capturedAt: '2026-10-04T23:00:00Z', imageObjectId: `img-${eventId}`, geometry, source: 'camera', qualityFlags: [], state: 'succeeded',
  });
  const fm = (eventId: string, px: number, physical?: PhysicalEstimate): FoodMeasurement => ({
    measurementId: `${eventId}-m`, eventId, attemptId: `att-${eventId}`, itemId: itemId('sticky-rice'), remainingAreaPx: px, method: 'mask_pixel_count', qualityFlags: [],
    maskCount: { pixelsWasted: px, maskObjectId: 'mask', geometry, menuId: 'menu_h', menuVersion: 1, classificationVersion: 'c', segmentationVersion: 's', processingVersion: 'p', assignment: 'exclusive', validated: true },
    ...(physical ? { physical } : {}),
  });
  const r = selectImpactMeasurements({
    services: [service],
    captures: [capture('vol'), capture('area'), capture('mismatch'), capture('clean'), capture('plain')],
    measurements: [fm('vol', 4000, volume(50, 40)), fm('area', 2000, area(10)), fm('mismatch', 3000, area(15)), fm('plain', 1000)],
    menuItems,
    capturePhysical: new Map([
      ['mismatch', { physicalMethod: null, unavailableReason: 'incompatible_geometry' as const }],
      ['clean', { physicalMethod: 'volume-dav2-v1' as const }],
    ]),
  });
  assert.deepEqual(r.captures, { captures: 5, analyzed: 5, excluded: 0 });
  // vol, area (derived from measurements) and clean (attempt snapshot) are calibrated; vol + clean used volume.
  assert.deepEqual(r.physicalCoverage, { calibratedCaptures: 3, volumeCaptures: 2, analyzedCaptures: 5 });
  const byEvent = new Map(r.measurements.map((m) => [m.eventId, m]));
  assert.deepEqual(byEvent.get('vol')!.physical, volume(50, 40));
  assert.equal(byEvent.get('mismatch')!.physical, undefined);
  assert.equal(byEvent.get('mismatch')!.physicalUnavailableReason, 'incompatible_geometry');
  assert.ok(!('physical' in byEvent.get('plain')!));

  const d = buildImpactDashboard({
    window: { start: '2026-10-04', end: '2026-10-04' }, measurements: r.measurements, captures: r.captures, menuItems,
    portions: [], factors: lookups, physicalCoverage: r.physicalCoverage,
  });
  close(d.totals.grams, 52.5); // vol 50 × 0.73 = 36.5 + area 10 × 1.6 = 16
  assert.deepEqual(d.totals.physicalCoverage, { calibratedCaptures: 3, volumeCaptures: 2, analyzedCaptures: 5 });
  // mismatch (incompatible_geometry) and plain (no_calibration) tie 1:1 ⇒ no_calibration first
  assert.equal(d.totals.physicalUnavailableReason, 'no_calibration');
  const mismatch = d.mostWasted[0]!; // all rice: one row
  assert.equal(mismatch.perPortion, null); // no portions given
});

// ---- labels ----------------------------------------------------------------

test('formatPhysicalLabel: g integer, CO2e 2 sig. digits (g below 0.1 kg), litres 2 sig. digits', () => {
  assert.equal(formatPhysicalLabel({ grams: 38.4, kgCo2e: 1.149, waterLitres: 18.2 }), '38 g · 1.1 kg CO2e · 18 L water (est.)');
  assert.equal(formatPhysicalLabel({ grams: 36.5, kgCo2e: 0.06497, waterLitres: 32.8135 }), '37 g · 65 g CO2e · 33 L water (est.)');
  assert.equal(formatPhysicalLabel({ grams: 24, kgCo2e: 3.16056, waterLitres: 46.2 }, { estimated: false }), '24 g · 3.2 kg CO2e · 46 L water');
  assert.equal(formatPhysicalLabel({ grams: 0, kgCo2e: 0, waterLitres: 0 }), '0 g · 0 g CO2e · 0 L water (est.)');
  assert.equal(formatPhysicalLabel({ grams: null, kgCo2e: null, waterLitres: null }), null);
  assert.equal(formatGrams(1234.5), '1,235 g');
  assert.equal(formatCo2e(131.69), '130 kg CO2e');
  assert.equal(formatCo2e(0.1), '0.1 kg CO2e');
  assert.equal(formatCo2e(0.0012), '1.2 g CO2e');
  assert.equal(formatWaterLitres(0.523), '0.52 L water');
  assert.equal(formatWaterLitres(1234), '1,200 L water');
  // Overlay legend row (I8)
  const item = captureItemPhysical({ physical: area(20), factor: STEAK });
  assert.equal(`Ancho Flank Steak · ${formatPhysicalLabel(item)}`, 'Ancho Flank Steak · 24 g · 3.2 kg CO2e · 46 L water (est.)');
});

// ---- recommendation ---------------------------------------------------------

const NOW = new Date('2026-10-04T12:00:00.000Z');

test('recommendation facts and fallback cite labeled estimates when plates are calibrated', () => {
  const d = buildImpactDashboard(mixedInput());
  const facts = recommendationFacts(d);
  assert.ok(facts.estimated);
  assert.deepEqual(
    [facts.estimated.calibratedPlates, facts.estimated.analyzedPlates, facts.estimated.volumePlates, facts.estimated.method],
    [2, 3, 1, 'mixed'],
  );
  assert.deepEqual([facts.estimated.grams, facts.estimated.kgCo2e, facts.estimated.waterLitres], [61, 3.23, 79]); // 60.5 → 61 g; 3 sig. digits
  assert.deepEqual(facts.estimated.topCo2.map((t) => [t.food, t.kgCo2e]), [['Ancho Flank Steak', 3.16], ['Sticky Rice', 0.065]]);
  for (const m of [
    'Estimated total: 3.2 kg CO2e (2 of 3 plates calibrated)',
    'Estimated total: 79 L water (2 of 3 plates calibrated)',
    'Ancho Flank Steak: estimated 3.2 kg CO2e and 46 L water',
    'Sticky Rice: estimated 65 g CO2e and 33 L water',
  ]) {
    assert.ok(facts.allowedMetrics.includes(m), m);
  }
  assert.match(recommendationInputVersion(facts), /^impact-rec-v3-physical\|waste-factors-v3\|[0-9a-f]{8}$/);

  const rec = fallbackRecommendation(d, NOW);
  assert.match(rec.text, /Calibrated plates \(2 of 3\): an estimated 3\.2 kg CO2e and 79 L water\./);
  assert.deepEqual(rec.bullets.map((b) => b.metric), [
    'Ancho Flank Steak: 2,000 pixels wasted per portion',
    'Sticky Rice: 800 pixels wasted per portion',
    'Estimated total: 3.2 kg CO2e (2 of 3 plates calibrated)', // steak (top CO2e) already has a bullet
    '3 of 3 plates analyzed',
  ]);
  assert.doesNotMatch(rec.text, /because|dislike|\$|dollar/i);
  assert.ok(parseRecommendationOutput(JSON.stringify({ text: rec.text, bullets: rec.bullets }), facts), 'fallback passes the validator');

  // Without calibrated plates nothing physical appears and the v2 prompt version is kept.
  const plain = recommendationFacts(buildImpactDashboard(mixedInput({ measurements: MIXED.map(({ physical: _p, ...m }) => m) })));
  assert.equal(plain.estimated, undefined);
  assert.doesNotMatch(JSON.stringify(plain), /grams|kgCo2e|CO2e|litre|L water/);
  assert.match(recommendationInputVersion(plain), /^impact-rec-v2\|/);
});

test('Gemini output: physical units only next to "estimated", only with calibrated plates; never money', async () => {
  const d = buildImpactDashboard(mixedInput());
  const facts = recommendationFacts(d);
  const STEAK_RATE = 'Ancho Flank Steak: 2,000 pixels wasted per portion';
  const CO2 = 'Estimated total: 3.2 kg CO2e (2 of 3 plates calibrated)';
  const out = (text: string, bullet = 'Watch steak.') =>
    JSON.stringify({ text, bullets: [{ text: bullet, metric: STEAK_RATE }, { text: 'Calibrated plates only.', metric: CO2 }] });
  assert.ok(parseRecommendationOutput(out('Steak leads per portion. Calibrated plates add up to an estimated 3.2 kg CO2e.'), facts));
  assert.ok(parseRecommendationOutput(out('Steak leads.', 'Steak leftovers: an estimated 46 L water.'), facts));
  assert.equal(parseRecommendationOutput(out('Steak wasted 3.2 kg CO2e.'), facts), null, 'no "estimated"');
  assert.equal(parseRecommendationOutput(out('Estimated cost of $12.'), facts), null, 'money');
  assert.equal(parseRecommendationOutput(out('Estimated 3 dollars.'), facts), null, 'money');

  const plainFacts = recommendationFacts(buildImpactDashboard(mixedInput({ measurements: MIXED.map(({ physical: _p, ...m }) => m) })));
  const plainOut = JSON.stringify({
    text: 'Steak wasted an estimated 3 kg.',
    bullets: [{ text: 'Watch steak.', metric: STEAK_RATE }, { text: 'Scan more.', metric: '3 of 3 plates analyzed' }],
  });
  assert.equal(parseRecommendationOutput(plainOut, plainFacts), null, 'no calibrated plates ⇒ no physical units at all');

  // The prompt and system instruction carry the estimate rules only with calibrated plates.
  const seen: Array<{ prompt: string; system: string | undefined }> = [];
  const gw = {
    async generateText(prompt: string, opts?: { systemInstruction?: string }) {
      seen.push({ prompt, system: opts?.systemInstruction });
      return out('Steak leads. Calibrated plates: an estimated 3.2 kg CO2e.');
    },
  };
  const rec = await generateRecommendation(gw, d, NOW);
  assert.equal(rec.source, 'gemini');
  assert.match(seen[0]!.prompt, /"estimated"/);
  assert.match(seen[0]!.system!, /ESTIMATED grams, kg CO2e and liters of water/);
});
