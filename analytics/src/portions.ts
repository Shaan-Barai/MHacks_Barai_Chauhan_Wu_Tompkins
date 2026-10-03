import type { CaptureEvent, FoodMeasurement, ImageGeometry, MealService, MenuItem, PortionsServed } from './contracts.js';

export interface PortionBenchmarkItem {
  itemId: string;
  displayName: string;
  portionsServed: number | null;
  portionsSource: PortionsServed['source'] | null;
  pixelsWasted: number | null;
  pixelsWastedPerPortion: number | null;
  measuredCaptures: number;
  unavailableReason: string | null;
}

export interface PortionBenchmark {
  hallId: string;
  serviceId: string;
  serviceDate: string;
  menuVersion: number;
  items: PortionBenchmarkItem[];
  capturedDishes: number;
  measuredDishes: number;
  excludedMeasurements: number;
  label: 'Pixels wasted per portion';
  unit: 'pixels/portion';
  coverageNote: string;
}

export interface PortionBenchmarkInput {
  service: MealService;
  menuItems: MenuItem[];
  captures: CaptureEvent[];
  /** Latest successful attempt per capture, supplied by orchestration. */
  measurements: FoodMeasurement[];
  portions: PortionsServed[];
}

export function geometryKey(g: ImageGeometry): string {
  return JSON.stringify([g.coordinateSpace, g.widthPx, g.heightPx, g.plateShape ?? null, g.plateDiameterPx ?? null]);
}

/** Validate count provenance; decoding/rasterization remains the vision stage's responsibility. */
export function validMaskCount(m: FoodMeasurement, capture: CaptureEvent, service: MealService): boolean {
  const mask = m.maskCount;
  const g = capture.geometry;
  return m.method === 'mask_pixel_count' && mask !== undefined && mask.validated === true &&
    mask.assignment === 'exclusive' && Number.isSafeInteger(mask.pixelsWasted) && mask.pixelsWasted >= 0 &&
    Number.isSafeInteger(g.widthPx) && g.widthPx > 0 && Number.isSafeInteger(g.heightPx) && g.heightPx > 0 &&
    mask.pixelsWasted <= g.widthPx * g.heightPx && g.coordinateSpace === 'topdown-normalized-v1' &&
    geometryKey(mask.geometry) === geometryKey(g) && mask.menuId === service.menuId && mask.menuVersion === service.menuVersion &&
    [mask.maskObjectId, mask.classificationVersion, mask.segmentationVersion, mask.processingVersion].every(v => typeof v === 'string' && v.trim().length > 0) &&
    ![...capture.qualityFlags, ...m.qualityFlags].some(f =>
      ['blurred', 'no_plate', 'multiple_dishes', 'incompatible_geometry', 'ambiguous_items'].includes(f));
}

/** No baselines, attendance, guessed areas, or absent-food zeroes enter this calculation. */
export function summarizePortionBenchmarks(input: PortionBenchmarkInput): PortionBenchmark {
  const { service } = input;
  const captures = new Map(input.captures.filter(c => c.hallId === service.hallId && c.serviceId === service.serviceId)
    .map(c => [c.eventId, c]));
  const byEvent = new Map<string, FoodMeasurement[]>();
  const seen = new Set<string>();
  for (const m of input.measurements) {
    if (!captures.has(m.eventId) || seen.has(m.measurementId)) continue;
    seen.add(m.measurementId);
    const list = byEvent.get(m.eventId) ?? [];
    list.push(m);
    byEvent.set(m.eventId, list);
  }
  const buckets = new Map<string, { pixels: number; events: Set<string> }>();
  const geometries = new Set<string>();
  const measuredEvents = new Set<string>();
  let excludedMeasurements = 0;
  for (const [eventId, rows] of byEvent) {
    const capture = captures.get(eventId)!;
    // A caller must select one attempt. Ambiguous/repeated attempts are unavailable.
    if (capture.state !== 'succeeded' || new Set(rows.map(m => m.attemptId)).size !== 1) {
      excludedMeasurements += rows.length;
      continue;
    }
    const valid = rows.filter(m => validMaskCount(m, capture, service));
    const total = valid.reduce((sum, m) => sum + m.maskCount!.pixelsWasted, 0);
    if (total > capture.geometry.widthPx * capture.geometry.heightPx) {
      excludedMeasurements += rows.length;
      continue;
    }
    excludedMeasurements += rows.length - valid.length;
    if (valid.length > 0) {
      geometries.add(geometryKey(capture.geometry));
      measuredEvents.add(eventId);
    }
    for (const m of valid) {
      if (m.itemId === null || !input.menuItems.some(i => i.itemId === m.itemId && i.menuId === service.menuId)) {
        excludedMeasurements += 1;
        continue;
      }
      const bucket = buckets.get(m.itemId) ?? { pixels: 0, events: new Set<string>() };
      bucket.pixels += m.maskCount!.pixelsWasted;
      bucket.events.add(eventId);
      buckets.set(m.itemId, bucket);
    }
  }
  const incompatible = geometries.size > 1;
  const items = input.menuItems.filter(i => i.menuId === service.menuId).map((item): PortionBenchmarkItem => {
    const counts = input.portions.filter(p => p.hallId === service.hallId && p.serviceId === service.serviceId &&
      p.serviceDate === service.serviceDate && p.menuId === service.menuId && p.menuVersion === service.menuVersion && p.itemId === item.itemId);
    const portion = counts.length === 1 && Number.isSafeInteger(counts[0]!.count) && counts[0]!.count >= 0 ? counts[0]! : null;
    const bucket = buckets.get(item.itemId);
    const pixels = bucket && !incompatible ? bucket.pixels : null;
    let reason: string | null = null;
    if (incompatible) reason = 'Image geometries differ; compare a single compatible capture setup.';
    else if (pixels === null) reason = 'Validated mask counts are unavailable for this item; area estimates do not count.';
    else if (!portion) reason = 'Enter portions served for this menu item.';
    else if (portion.count === 0) reason = pixels > 0 ? 'Waste was observed with zero portions served; check the count.' : 'Zero portions served; the per-portion benchmark is unavailable.';
    return {
      itemId: item.itemId,
      displayName: item.displayName,
      portionsServed: portion?.count ?? null,
      portionsSource: portion?.source ?? null,
      pixelsWasted: pixels,
      pixelsWastedPerPortion: reason === null ? pixels! / portion!.count : null,
      measuredCaptures: bucket?.events.size ?? 0,
      unavailableReason: reason,
    };
  }).sort((a, b) => (b.pixelsWastedPerPortion ?? -1) - (a.pixelsWastedPerPortion ?? -1) || a.itemId.localeCompare(b.itemId));
  return {
    hallId: service.hallId, serviceId: service.serviceId, serviceDate: service.serviceDate, menuVersion: service.menuVersion,
    items, capturedDishes: captures.size, measuredDishes: measuredEvents.size, excludedMeasurements,
    label: 'Pixels wasted per portion', unit: 'pixels/portion',
    coverageNote: `${measuredEvents.size} of ${captures.size} captured dishes have validated mask counts. Observed pixels are divided by full-meal portions served; incomplete capture coverage can understate waste. This does not prove dislike or another cause.`,
  };
}

/** Includes every item/count/source so edits invalidate recommendations, even when rank is unchanged. */
export function portionDataVersion(summary: PortionBenchmark): string {
  return JSON.stringify(['portions-v1', summary.hallId, summary.serviceId, summary.serviceDate, summary.menuVersion,
    summary.capturedDishes, summary.measuredDishes, summary.excludedMeasurements,
    [...summary.items].sort((a, b) => a.itemId.localeCompare(b.itemId))]);
}
