/**
 * Aggregate formulas (AGENTS.md 6.1 and §7).
 *
 * overall_waste_percent = 100 * sum(remaining) / sum(baseline)   [eligible only]
 * leftover_per_attendee = observed_remaining / attendance
 *
 * Invalid / failed / above-baseline / unknown measurements are excluded and
 * counted — never treated as zero waste. Item percentages are area-weighted,
 * not an average of per-item display percents.
 */

import type {
  Attendance,
  CaptureEvent,
  FoodMeasurement,
  MealLabel,
  MealService,
  MenuItem,
} from './contracts.js';
import {
  classifyCapture,
  classifyMeasurement,
  emptyExclusionCounts,
  geometryCompatible,
  isFinitePositive,
  type ExclusionReason,
} from './eligibility.js';

export const METRIC_LABELS = {
  remainingArea: 'observed estimated leftover area (pixels)',
  perAttendee: 'observed leftover area per simulated attendee',
  attendanceSource: 'simulated',
  measurementMethod: 'AI estimate',
} as const;

export interface ItemWasteComparison {
  itemId: string;
  displayName?: string;
  eligibleCount: number;
  remainingAreaPx: number;
  baselineAreaPx: number;
  /** Area-weighted waste percent for this item's eligible servings. */
  wastePercent: number;
  /**
   * Share of total observed leftover area attributed to this item.
   * null when total remaining is zero.
   */
  shareOfMealWastePercent: number | null;
}

export interface ServiceSummary {
  hallId: string;
  serviceId: string;
  serviceDate: string;
  mealLabel?: MealLabel;

  captureCount: number;
  succeededCaptureCount: number;
  excludedCaptureCount: number;

  eligibleMeasurementCount: number;
  excludedMeasurementCount: number;
  exclusionReasons: Record<ExclusionReason, number>;

  observedRemainingAreaPx: number;
  observedBaselineAreaPx: number;
  /** null when no eligible baseline denominator. */
  overallWastePercent: number | null;
  overallWasteUnavailableReason?: string;

  attendance: Attendance | null;
  leftoverAreaPerSimulatedAttendee: number | null;
  perAttendeeUnavailableReason?: string;

  items: ItemWasteComparison[];
  labels: typeof METRIC_LABELS;
}

export interface WasteTrendPoint {
  hallId: string;
  serviceId: string;
  serviceDate: string;
  mealLabel?: MealLabel;
  overallWastePercent: number | null;
  observedRemainingAreaPx: number;
  leftoverAreaPerSimulatedAttendee: number | null;
  eligibleMeasurementCount: number;
}

export interface AggregateInput {
  service: MealService;
  captures: CaptureEvent[];
  measurements: FoodMeasurement[];
  /** Optional persisted attendance; do not generate here. */
  attendance?: Attendance | null;
  /** Optional display names for item breakdown. */
  menuItems?: MenuItem[];
}

interface ItemBucket {
  itemId: string;
  remainingAreaPx: number;
  baselineAreaPx: number;
  eligibleCount: number;
}

function roundPercent(n: number): number {
  // One decimal keeps demo numbers readable without implying false precision.
  return Math.round(n * 10) / 10;
}

/**
 * Summarize waste for one hall/date/service.
 * Filters captures to the service; measurements must belong to those captures.
 */
export function summarizeService(input: AggregateInput): ServiceSummary {
  const { service } = input;
  const menuNames = new Map((input.menuItems ?? []).map((m) => [m.itemId, m.displayName]));

  const serviceCaptures = input.captures.filter(
    (c) => c.hallId === service.hallId && c.serviceId === service.serviceId,
  );
  const captureById = new Map(serviceCaptures.map((c) => [c.eventId, c]));

  const exclusionReasons = emptyExclusionCounts();
  let succeededCaptureCount = 0;
  let excludedCaptureCount = 0;

  const eligibleCaptureIds = new Set<string>();
  for (const capture of serviceCaptures) {
    const capClass = classifyCapture(capture);
    if (!capClass.eligible) {
      excludedCaptureCount += 1;
      exclusionReasons.capture_not_succeeded += 1;
      continue;
    }
    if (!geometryCompatible(capture)) {
      excludedCaptureCount += 1;
      exclusionReasons.incompatible_geometry += 1;
      continue;
    }
    succeededCaptureCount += 1;
    eligibleCaptureIds.add(capture.eventId);
  }

  const itemBuckets = new Map<string, ItemBucket>();
  let eligibleMeasurementCount = 0;
  let excludedMeasurementCount = 0;
  let observedRemainingAreaPx = 0;
  let observedBaselineAreaPx = 0;

  for (const m of input.measurements) {
    const capture = captureById.get(m.eventId);
    if (capture === undefined) {
      // Measurement for another service or unknown capture — skip quietly.
      continue;
    }
    if (!eligibleCaptureIds.has(m.eventId)) {
      // Already counted via capture exclusion; do not double-count reasons.
      continue;
    }

    const result = classifyMeasurement(m);
    if (!result.eligible) {
      excludedMeasurementCount += 1;
      if (result.reason !== undefined) {
        exclusionReasons[result.reason] += 1;
      }
      continue;
    }

    // itemId and baseline are guaranteed by classifyMeasurement.
    const itemId = m.itemId as string;
    const baseline = m.baselineAreaPx as number;
    eligibleMeasurementCount += 1;
    observedRemainingAreaPx += m.remainingAreaPx;
    observedBaselineAreaPx += baseline;

    const bucket = itemBuckets.get(itemId) ?? {
      itemId,
      remainingAreaPx: 0,
      baselineAreaPx: 0,
      eligibleCount: 0,
    };
    bucket.remainingAreaPx += m.remainingAreaPx;
    bucket.baselineAreaPx += baseline;
    bucket.eligibleCount += 1;
    itemBuckets.set(itemId, bucket);
  }

  let overallWastePercent: number | null = null;
  let overallWasteUnavailableReason: string | undefined;
  if (!isFinitePositive(observedBaselineAreaPx)) {
    overallWasteUnavailableReason =
      eligibleMeasurementCount === 0
        ? 'No eligible measurements with valid baselines for this service.'
        : 'Aggregate baseline denominator is zero.';
  } else {
    overallWastePercent = roundPercent((100 * observedRemainingAreaPx) / observedBaselineAreaPx);
  }

  const attendance = input.attendance ?? null;
  let leftoverAreaPerSimulatedAttendee: number | null = null;
  let perAttendeeUnavailableReason: string | undefined;
  if (attendance === null) {
    perAttendeeUnavailableReason = 'Simulated attendance has not been generated for this service.';
  } else if (!isFinitePositive(attendance.count)) {
    perAttendeeUnavailableReason = 'Simulated attendance is missing or zero.';
  } else {
    leftoverAreaPerSimulatedAttendee = observedRemainingAreaPx / attendance.count;
  }

  const items: ItemWasteComparison[] = [...itemBuckets.values()]
    .map((b) => {
      const wastePercent = isFinitePositive(b.baselineAreaPx)
        ? roundPercent((100 * b.remainingAreaPx) / b.baselineAreaPx)
        : 0;
      const shareOfMealWastePercent =
        observedRemainingAreaPx > 0
          ? roundPercent((100 * b.remainingAreaPx) / observedRemainingAreaPx)
          : null;
      const row: ItemWasteComparison = {
        itemId: b.itemId,
        eligibleCount: b.eligibleCount,
        remainingAreaPx: b.remainingAreaPx,
        baselineAreaPx: b.baselineAreaPx,
        wastePercent,
        shareOfMealWastePercent,
      };
      const name = menuNames.get(b.itemId);
      if (name !== undefined) row.displayName = name;
      return row;
    })
    .sort((a, b) => b.remainingAreaPx - a.remainingAreaPx);

  const summary: ServiceSummary = {
    hallId: service.hallId,
    serviceId: service.serviceId,
    serviceDate: service.serviceDate,
    mealLabel: service.mealLabel,
    captureCount: serviceCaptures.length,
    succeededCaptureCount,
    excludedCaptureCount,
    eligibleMeasurementCount,
    excludedMeasurementCount,
    exclusionReasons,
    observedRemainingAreaPx,
    observedBaselineAreaPx,
    overallWastePercent,
    attendance,
    leftoverAreaPerSimulatedAttendee,
    items,
    labels: METRIC_LABELS,
  };
  if (overallWasteUnavailableReason !== undefined) {
    summary.overallWasteUnavailableReason = overallWasteUnavailableReason;
  }
  if (perAttendeeUnavailableReason !== undefined) {
    summary.perAttendeeUnavailableReason = perAttendeeUnavailableReason;
  }
  return summary;
}

/**
 * Build trend points across multiple services (same hall recommended).
 * Caller supplies already-computed summaries so attendance stays persisted.
 */
export function buildWasteTrend(summaries: ServiceSummary[]): WasteTrendPoint[] {
  return [...summaries]
    .sort((a, b) => {
      const byDate = a.serviceDate.localeCompare(b.serviceDate);
      if (byDate !== 0) return byDate;
      return a.serviceId.localeCompare(b.serviceId);
    })
    .map((s) => {
      const point: WasteTrendPoint = {
        hallId: s.hallId,
        serviceId: s.serviceId,
        serviceDate: s.serviceDate,
        observedRemainingAreaPx: s.observedRemainingAreaPx,
        overallWastePercent: s.overallWastePercent,
        leftoverAreaPerSimulatedAttendee: s.leftoverAreaPerSimulatedAttendee,
        eligibleMeasurementCount: s.eligibleMeasurementCount,
      };
      if (s.mealLabel !== undefined) point.mealLabel = s.mealLabel;
      return point;
    });
}

/** Stable data-version fingerprint for suggestion caching (AGENTS.md 6.5). */
export function computeDataVersion(summary: ServiceSummary): string {
  const top = summary.items[0]?.itemId ?? 'none';
  return [
    'agg',
    summary.hallId,
    summary.serviceId,
    summary.serviceDate,
    `m${summary.eligibleMeasurementCount}`,
    `x${summary.excludedMeasurementCount}`,
    `r${summary.observedRemainingAreaPx}`,
    `b${summary.observedBaselineAreaPx}`,
    `t${top}`,
    `a${summary.attendance?.count ?? 0}`,
  ].join('-');
}
