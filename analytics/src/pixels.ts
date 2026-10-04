/**
 * Pixels wasted aggregation (contracts/measurement.md, AGENTS.md 6.1).
 *
 *   capture_pixels_wasted = union of the capture's eligible food masks
 *   total_pixels_wasted   = sum over unique eligible captures
 *   item share            = item pixels / total pixels (a breakdown, not % of food served)
 *
 * A capture contributes only when its counted analysis attempt has a
 * 'complete' count, or a validated 'empty' plate (0 pixels). Partial,
 * unavailable, failed, and legacy (Gemini area-estimate) captures are
 * excluded and counted by reason — never treated as zero. Captures whose
 * geometry differs from the service's agreed canvas are kept out of the
 * pooled total (incompatible pixels are not summed).
 */

import type {
  AnalysisAttempt,
  Attendance,
  CaptureEvent,
  FoodMeasurement,
  MealService,
  MenuItem,
} from './contracts.js';

export const PIXEL_LABELS = {
  pixelsWasted: 'Pixels wasted',
  unit: 'pixels',
  explanation:
    'Visible leftover-food pixels inside AI-generated segmentation masks, counted by the app. Not grams, servings, or the share of food originally served.',
  perAttendee: 'Pixels wasted per simulated attendee',
  unclassified: 'Unclassified food',
} as const;

export type PixelExclusionReason =
  | 'not_analyzed' // capture still pending/processing or no counted attempt
  | 'analysis_failed'
  | 'needs_review'
  | 'partial_segmentation'
  | 'count_unavailable'
  | 'legacy_estimate' // pre-mask Gemini area estimate: not a mask count
  | 'incompatible_geometry';

export interface PixelItemTotal {
  itemId: string;
  displayName?: string;
  pixelsWasted: number;
  /** Captures with pixels for this item. */
  captures: number;
  /** Share of the service's total wasted pixels (0-100); null when total is 0. */
  shareOfMealPixelsPercent: number | null;
}

export interface PixelServiceSummary {
  hallId: string;
  serviceId: string;
  serviceDate: string;
  mealLabel?: MealService['mealLabel'];
  /** The canvas every counted capture shares, e.g. "1024x1024 topdown-normalized-v1". */
  geometryKey: string | null;
  captureCount: number;
  /** Captures in the total (complete + empty). */
  countedCaptureCount: number;
  emptyPlateCount: number;
  excludedCaptureCount: number;
  exclusionReasons: Record<PixelExclusionReason, number>;
  pixelsWasted: number;
  unclassifiedPixels: number;
  /** Sorted by pixelsWasted, descending. */
  items: PixelItemTotal[];
  attendance: Attendance | null;
  pixelsPerSimulatedAttendee: number | null;
  labels: typeof PIXEL_LABELS;
}

export interface PixelAggregateInput {
  service: MealService;
  captures: CaptureEvent[];
  /** eventId -> the counted (latest succeeded) attempt, if any. */
  countedAttempts: Map<string, AnalysisAttempt>;
  /** eventId -> latest attempt of any status (to explain exclusions). */
  latestAttempts?: Map<string, AnalysisAttempt>;
  /** Measurements of the counted attempts. */
  measurements: FoodMeasurement[];
  attendance?: Attendance | null;
  menuItems?: MenuItem[];
}

function emptyReasons(): Record<PixelExclusionReason, number> {
  return {
    not_analyzed: 0,
    analysis_failed: 0,
    needs_review: 0,
    partial_segmentation: 0,
    count_unavailable: 0,
    legacy_estimate: 0,
    incompatible_geometry: 0,
  };
}

function geometryKey(c: CaptureEvent): string {
  return `${c.geometry.widthPx}x${c.geometry.heightPx} ${c.geometry.coordinateSpace}`;
}

export function summarizePixels(input: PixelAggregateInput): PixelServiceSummary {
  const { service } = input;
  const reasons = emptyReasons();
  const names = new Map((input.menuItems ?? []).map((i) => [i.itemId, i.displayName]));

  // The service's agreed canvas = the most common geometry among countable captures.
  const tally = new Map<string, number>();
  for (const c of input.captures) {
    const a = input.countedAttempts.get(c.eventId);
    if (a?.segmentation && (a.segmentation.countStatus === 'complete' || a.segmentation.countStatus === 'empty')) {
      tally.set(geometryKey(c), (tally.get(geometryKey(c)) ?? 0) + 1);
    }
  }
  const agreed = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  const counted = new Set<string>();
  let emptyPlates = 0;
  let pixelsWasted = 0;
  for (const c of input.captures) {
    const attempt = input.countedAttempts.get(c.eventId);
    if (!attempt) {
      const latest = input.latestAttempts?.get(c.eventId);
      if (c.state === 'failed' || latest?.status === 'failed') reasons.analysis_failed++;
      else if (c.state === 'needs_review' || latest?.status === 'needs_review') {
        if (latest?.segmentation?.countStatus === 'partial') reasons.partial_segmentation++;
        else reasons.needs_review++;
      } else reasons.not_analyzed++;
      continue;
    }
    const seg = attempt.segmentation;
    if (!seg) {
      reasons.legacy_estimate++;
      continue;
    }
    if (seg.countStatus === 'partial') {
      reasons.partial_segmentation++;
      continue;
    }
    if (seg.countStatus === 'unavailable' || seg.capturePixelsWasted === undefined) {
      reasons.count_unavailable++;
      continue;
    }
    if (geometryKey(c) !== agreed) {
      reasons.incompatible_geometry++;
      continue;
    }
    counted.add(c.eventId);
    pixelsWasted += seg.capturePixelsWasted;
    if (seg.countStatus === 'empty') emptyPlates++;
  }

  const perItem = new Map<string, { pixels: number; captures: Set<string> }>();
  let unclassifiedPixels = 0;
  for (const m of input.measurements) {
    if (!counted.has(m.eventId) || m.method !== 'mask_pixel_count') continue;
    if (m.itemId === null) {
      unclassifiedPixels += m.remainingAreaPx;
      continue;
    }
    const row = perItem.get(m.itemId) ?? { pixels: 0, captures: new Set<string>() };
    row.pixels += m.remainingAreaPx;
    row.captures.add(m.eventId);
    perItem.set(m.itemId, row);
  }
  const items: PixelItemTotal[] = [...perItem.entries()]
    .map(([itemId, row]) => {
      const displayName = names.get(itemId);
      return {
        itemId,
        ...(displayName !== undefined ? { displayName } : {}),
        pixelsWasted: row.pixels,
        captures: row.captures.size,
        shareOfMealPixelsPercent: pixelsWasted > 0 ? (100 * row.pixels) / pixelsWasted : null,
      };
    })
    .sort((a, b) => b.pixelsWasted - a.pixelsWasted || a.itemId.localeCompare(b.itemId));

  const attendance = input.attendance ?? null;
  const excluded = input.captures.length - counted.size;
  return {
    hallId: service.hallId,
    serviceId: service.serviceId,
    serviceDate: service.serviceDate,
    mealLabel: service.mealLabel,
    geometryKey: agreed,
    captureCount: input.captures.length,
    countedCaptureCount: counted.size,
    emptyPlateCount: emptyPlates,
    excludedCaptureCount: excluded,
    exclusionReasons: reasons,
    pixelsWasted,
    unclassifiedPixels,
    items,
    attendance,
    pixelsPerSimulatedAttendee: attendance && attendance.count > 0 && counted.size > 0 ? pixelsWasted / attendance.count : null,
    labels: PIXEL_LABELS,
  };
}

/** Stable fingerprint of the pixel facts, for suggestion caching. */
export function computePixelDataVersion(s: PixelServiceSummary): string {
  return [
    'px',
    s.serviceId,
    `c${s.countedCaptureCount}`,
    `x${s.excludedCaptureCount}`,
    `p${s.pixelsWasted}`,
    `u${s.unclassifiedPixels}`,
    `t${s.items[0]?.itemId ?? 'none'}:${s.items[0]?.pixelsWasted ?? 0}`,
    `a${s.attendance?.count ?? 0}`,
  ].join('-');
}
