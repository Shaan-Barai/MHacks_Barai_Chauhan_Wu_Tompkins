/**
 * Dashboard summary per AGENTS.md §7.
 *
 *   overall_waste_percent = 100 * sum(remaining_area_px_i) / sum(baseline_area_px_i)
 *
 * computed over ELIGIBLE measurements only — an AREA-WEIGHTED percentage,
 * never an average of item percentages. A measurement is eligible when:
 *   - it belongs to the event's counted (latest succeeded) attempt,
 *   - itemId is a menu item (unknown food is excluded from percentages),
 *   - baselineAreaPx is finite and > 0 (missing baseline => excluded),
 *   - rawWasteFraction <= 1 (above-baseline is flagged for review, excluded),
 *   - remainingAreaPx is finite and >= 0.
 *
 * Every exclusion is COUNTED and visible; excluded/failed work is never
 * reported as zero waste. Zero denominators => `unavailable` with a reason.
 * Attendance normalization is labeled simulated and is unavailable when
 * attendance is missing or zero.
 */

import { notFound } from '../errors.js';
import type { IngestionService } from './ingestionService.js';
import type { Repository } from '../repo/repository.js';
import type { FoodMeasurement } from '../types.js';

export interface ExclusionCounts {
  /** Events whose latest state is failed (no successful analysis). */
  failedCaptures: number;
  needsReviewCaptures: number;
  pendingCaptures: number;
  /** Measurements excluded from percentages, by reason. */
  unknownItemMeasurements: number;
  missingBaselineMeasurements: number;
  aboveBaselineMeasurements: number;
  invalidValueMeasurements: number;
}

export interface ItemBreakdown {
  itemId: string;
  displayName: string;
  servings: number;
  remainingAreaPx: number;
  baselineAreaPx: number;
  /** Area-weighted per item: 100 * sum(remaining) / sum(baseline). */
  wastePercent: number;
}

export interface DashboardSummary {
  hallId: string;
  serviceId: string;
  totals: {
    capturedDishes: number;
    analyzedDishes: number;
    eligibleMeasurements: number;
    /** "Observed estimated leftover area (pixels)" — eligible sum. */
    observedRemainingAreaPx: number;
    baselineAreaPx: number;
    /** Area-weighted §7 aggregate, or null with a reason. */
    overallWastePercent: number | null;
    overallUnavailableReason?: string;
    /** Unknown food keeps its visible-area estimate, reported separately. */
    unknownItemRemainingAreaPx: number;
  };
  exclusions: ExclusionCounts;
  perItem: ItemBreakdown[];
  attendance: {
    count: number | null;
    source: 'simulated' | null;
    /** "Observed leftover area per simulated attendee", or null. */
    observedRemainingAreaPxPerAttendee: number | null;
    unavailableReason?: string;
  };
  /** All measurements are AI estimates; attendance is simulated. */
  labels: { measurementMethod: string; attendanceSource: string };
}

export class SummaryService {
  constructor(
    private readonly repo: Repository,
    private readonly ingestion: IngestionService,
  ) {}

  async getSummary(hallId: string, serviceId: string): Promise<DashboardSummary> {
    const menu = await this.repo.getMenuByService(serviceId);
    if (!menu || menu.service.hallId !== hallId) {
      throw notFound('MENU_NOT_FOUND', 'No menu is saved for this hall and service yet. Add one in Menus.', {
        hallId,
        serviceId,
      });
    }
    const displayNames = new Map(menu.items.map((i) => [i.itemId, i.displayName]));

    const events = await this.repo.listCaptureEvents({ hallId, serviceId });
    const exclusions: ExclusionCounts = {
      failedCaptures: 0,
      needsReviewCaptures: 0,
      pendingCaptures: 0,
      unknownItemMeasurements: 0,
      missingBaselineMeasurements: 0,
      aboveBaselineMeasurements: 0,
      invalidValueMeasurements: 0,
    };

    const eligible: FoodMeasurement[] = [];
    let unknownItemRemainingAreaPx = 0;
    let analyzedDishes = 0;

    for (const event of events) {
      if (event.state === 'failed') {
        exclusions.failedCaptures += 1;
        continue;
      }
      if (event.state === 'needs_review') {
        exclusions.needsReviewCaptures += 1;
        continue;
      }
      if (event.state === 'pending' || event.state === 'processing') {
        exclusions.pendingCaptures += 1;
        continue;
      }
      analyzedDishes += 1;
      // Only the counted (latest succeeded) attempt — never double-counted.
      const measurements = await this.ingestion.countedMeasurements(event);
      for (const m of measurements) {
        if (!Number.isFinite(m.remainingAreaPx) || m.remainingAreaPx < 0) {
          exclusions.invalidValueMeasurements += 1;
          continue;
        }
        if (m.itemId === null) {
          exclusions.unknownItemMeasurements += 1;
          unknownItemRemainingAreaPx += m.remainingAreaPx;
          continue;
        }
        if (m.baselineAreaPx === undefined || !Number.isFinite(m.baselineAreaPx) || m.baselineAreaPx <= 0) {
          exclusions.missingBaselineMeasurements += 1;
          continue;
        }
        if ((m.rawWasteFraction ?? m.remainingAreaPx / m.baselineAreaPx) > 1) {
          exclusions.aboveBaselineMeasurements += 1;
          continue;
        }
        eligible.push(m);
      }
    }

    const observedRemainingAreaPx = eligible.reduce((s, m) => s + m.remainingAreaPx, 0);
    const baselineAreaPx = eligible.reduce((s, m) => s + (m.baselineAreaPx ?? 0), 0);
    const overallWastePercent = baselineAreaPx > 0 ? (100 * observedRemainingAreaPx) / baselineAreaPx : null;

    const perItemMap = new Map<string, ItemBreakdown>();
    for (const m of eligible) {
      const itemId = m.itemId as string;
      const row = perItemMap.get(itemId) ?? {
        itemId,
        displayName: displayNames.get(itemId) ?? itemId,
        servings: 0,
        remainingAreaPx: 0,
        baselineAreaPx: 0,
        wastePercent: 0,
      };
      row.servings += 1;
      row.remainingAreaPx += m.remainingAreaPx;
      row.baselineAreaPx += m.baselineAreaPx ?? 0;
      perItemMap.set(itemId, row);
    }
    const perItem = [...perItemMap.values()]
      .map((row) => ({ ...row, wastePercent: (100 * row.remainingAreaPx) / row.baselineAreaPx }))
      .sort((a, b) => b.remainingAreaPx - a.remainingAreaPx);

    const attendance = await this.repo.getAttendance(serviceId);
    const attendanceBlock: DashboardSummary['attendance'] =
      attendance && attendance.count > 0
        ? {
            count: attendance.count,
            source: 'simulated',
            observedRemainingAreaPxPerAttendee: observedRemainingAreaPx / attendance.count,
          }
        : {
            count: attendance?.count ?? null,
            source: attendance ? 'simulated' : null,
            observedRemainingAreaPxPerAttendee: null,
            unavailableReason: attendance ? 'attendance_zero' : 'attendance_missing',
          };

    return {
      hallId,
      serviceId,
      totals: {
        capturedDishes: events.length,
        analyzedDishes,
        eligibleMeasurements: eligible.length,
        observedRemainingAreaPx,
        baselineAreaPx,
        overallWastePercent,
        ...(overallWastePercent === null ? { overallUnavailableReason: 'no_eligible_baselines' } : {}),
        unknownItemRemainingAreaPx,
      },
      exclusions,
      perItem,
      attendance: attendanceBlock,
      labels: {
        measurementMethod: 'AI estimate (gemini_area_estimate); pixel areas, not grams or cost',
        attendanceSource: 'simulated attendance (prototype)',
      },
    };
  }
}
