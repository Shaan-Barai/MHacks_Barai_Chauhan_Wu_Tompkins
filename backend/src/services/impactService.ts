/**
 * Waste-impact read models (BIG-PLAN D2–D8): the impact dashboard, the
 * recent-plates list, and the AI recommendation. The backend only gathers
 * records for a reporting window — each capture's counted (latest succeeded)
 * attempt with its persisted plate calibration, that attempt's mask
 * measurements, the service menus, and portions served. Every formula
 * (grams, CO2e, water, impact $, per-portion rates, rankings, the
 * recommendation prompt and its fallback) lives in `@scrap/analytics`
 * (AGENTS.md 5.6, D3).
 */

import {
  buildImpactDashboard,
  computeWasteImpact,
  generateRecommendation,
  recommendationFacts,
  recommendationInputVersion,
  selectImpactMeasurements,
  sumImpacts,
  UNKNOWN_FOOD_LABEL,
  type TextGateway,
} from '@scrap/analytics';
import { findNutritionFactor, findWasteFactor, WASTE_FACTORS_VERSION } from 'scrap-data';
import { badRequest } from '../errors.js';
import type { Repository } from '../repo/repository.js';
import type { IngestionService } from './ingestionService.js';
import type {
  AnalysisAttempt,
  PlateCalibration,
  CaptureEvent,
  CaptureListItem,
  FoodMeasurement,
  ImpactDashboard,
  MenuBundle,
  PortionsServed,
  Recommendation,
} from '../types.js';

export interface ImpactWindow {
  /** Local service dates, YYYY-MM-DD, inclusive. */
  start: string;
  end: string;
  hallId?: string;
}

/** Everything recorded for one meal service inside the window. */
export interface ServiceRecords {
  menu: MenuBundle;
  captures: CaptureEvent[];
  /** eventId -> the counted (latest succeeded) attempt, carrying `calibration`. */
  countedAttempts: Map<string, AnalysisAttempt>;
  /** eventId -> latest attempt of any status (exclusion reasons). */
  latestAttempts: Map<string, AnalysisAttempt>;
  /** Measurements of the counted attempts only. */
  measurements: FoodMeasurement[];
  /** Portions served for the service's current menu version. */
  portions: PortionsServed[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const CAPTURE_LIST_DEFAULT_LIMIT = 50;
export const CAPTURE_LIST_MAX_LIMIT = 200;
/** A fallback is retried with Gemini after this long, so a provider blip does not stick. */
const FALLBACK_RETRY_MS = 60_000;

export function parseWindow(query: Record<string, unknown>): ImpactWindow {
  const { start, end, hallId } = query;
  if (typeof start !== 'string' || !DATE.test(start) || typeof end !== 'string' || !DATE.test(end)) {
    throw badRequest('INVALID_WINDOW', "Query parameters 'start' and 'end' are required as YYYY-MM-DD dates.", {
      start: typeof start === 'string' ? start : null,
      end: typeof end === 'string' ? end : null,
    });
  }
  if (start > end) throw badRequest('INVALID_WINDOW', "'start' must be on or before 'end'.", { start, end });
  if (hallId !== undefined && (typeof hallId !== 'string' || hallId.length === 0)) {
    throw badRequest('INVALID_PARAMETER', "'hallId' must be a non-empty string when given.");
  }
  return { start, end, ...(typeof hallId === 'string' ? { hallId } : {}) };
}

export class ImpactService {
  private readonly recommendations = new Map<string, { value: Recommendation; storedAt: number }>();

  constructor(
    private readonly repo: Repository,
    private readonly ingestion: IngestionService,
    /** Live Gemini only; mock text is never a recommendation (fallback instead). */
    private readonly gateway?: TextGateway,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Records for every service whose local date falls in the window. */
  async gather(window: ImpactWindow): Promise<ServiceRecords[]> {
    const services = (await this.repo.listServices(window.hallId)).filter(
      (s) => s.serviceDate >= window.start && s.serviceDate <= window.end,
    );
    services.sort((a, b) => a.serviceDate.localeCompare(b.serviceDate) || a.serviceId.localeCompare(b.serviceId));
    const out: ServiceRecords[] = [];
    for (const service of services) {
      const menu = await this.repo.getMenuByService(service.serviceId);
      if (!menu) continue;
      const captures = await this.repo.listCaptureEvents({ hallId: service.hallId, serviceId: service.serviceId });
      const countedAttempts = new Map<string, AnalysisAttempt>();
      const latestAttempts = new Map<string, AnalysisAttempt>();
      const measurements: FoodMeasurement[] = [];
      for (const event of captures) {
        const attempts = await this.repo.listAnalysisAttempts(event.eventId);
        const latest = attempts.at(-1);
        if (latest) latestAttempts.set(event.eventId, latest);
        if (event.state !== 'succeeded') continue;
        const counted = await this.ingestion.countedAttempt(event.eventId);
        if (!counted) continue;
        countedAttempts.set(event.eventId, counted);
        measurements.push(...(await this.repo.listMeasurementsByAttempt(counted.attemptId)));
      }
      const portions = await this.repo.listPortionsServed(service.serviceId, menu.service.menuVersion);
      out.push({ menu, captures, countedAttempts, latestAttempts, measurements, portions });
    }
    return out;
  }

  async dashboard(window: ImpactWindow): Promise<ImpactDashboard> {
    return this.build(window, await this.gather(window));
  }

  private build(window: ImpactWindow, records: ServiceRecords[]): ImpactDashboard {
    // Eligibility (validated exclusive mask counts of the counted attempt,
    // same rules as the per-portion benchmark) comes from analytics.
    const selected = selectImpactMeasurements({
      services: records.map((r) => r.menu.service),
      captures: records.flatMap((r) => r.captures),
      measurements: records.flatMap((r) => r.measurements),
      menuItems: records.flatMap((r) => r.menu.items),
    });
    const calibrations = new Map<string, PlateCalibration | null>();
    for (const r of records) {
      for (const [eventId, attempt] of r.countedAttempts) calibrations.set(eventId, attempt.calibration ?? null);
    }
    return buildImpactDashboard({
      window,
      measurements: selected.measurements,
      calibrations,
      captures: selected.captures,
      menuItems: records.flatMap((r) => r.menu.items),
      portions: records.flatMap((r) => r.portions),
      factors: { findWasteFactor, findNutritionFactor },
      wasteFactorsVersion: WASTE_FACTORS_VERSION,
    });
  }

  /** Recent plates, newest first, capped (contracts CaptureListItem). */
  async captures(window: ImpactWindow, limit = CAPTURE_LIST_DEFAULT_LIMIT): Promise<CaptureListItem[]> {
    const records = await this.gather(window);
    const items: CaptureListItem[] = [];
    for (const r of records) {
      const names = new Map(r.menu.items.map((i) => [i.itemId, i.displayName]));
      for (const event of r.captures) {
        const attempt = r.countedAttempts.get(event.eventId);
        const rows = attempt ? r.measurements.filter((m) => m.attemptId === attempt.attemptId) : [];
        const impacts = rows.map((m) => {
          const unknown = m.itemId === null;
          const displayName = unknown ? UNKNOWN_FOOD_LABEL : names.get(m.itemId!) ?? m.itemId!;
          const impact = computeWasteImpact(
            m.remainingAreaPx,
            attempt?.calibration ?? null,
            unknown ? null : findWasteFactor(displayName),
            unknown ? null : findNutritionFactor(displayName),
            { unknownItem: unknown, wasteFactorsVersion: WASTE_FACTORS_VERSION },
          );
          return { m, displayName, impact };
        });
        const seg = attempt?.segmentation;
        const counted = seg?.countStatus === 'complete' || seg?.countStatus === 'empty';
        const latest = r.latestAttempts.get(event.eventId);
        items.push({
          eventId: event.eventId,
          capturedAt: event.capturedAt,
          serviceId: event.serviceId,
          source: event.source,
          state: event.state,
          pixelsWasted: counted ? seg!.capturePixelsWasted ?? null : null,
          // analytics sumImpacts rule: grams of the pixels that have a calibration + factor.
          grams: counted ? sumImpacts(impacts.map((x) => x.impact), WASTE_FACTORS_VERSION).grams : null,
          items: impacts.map(({ m, displayName, impact }) => ({
            itemId: m.itemId,
            displayName,
            pixels: m.remainingAreaPx,
            grams: impact.grams,
          })),
          hasOverlay: Boolean((attempt ?? latest)?.overlayObjectId),
        });
      }
    }
    items.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || b.eventId.localeCompare(a.eventId));
    return items.slice(0, limit);
  }

  /**
   * Grounded recommendation (D8). Cached by window + analytics
   * `recommendationInputVersion` (a hash of the facts the prompt cites): the
   * same statistics never pay for a second Gemini call. A labeled fallback is
   * served when Gemini is unavailable and retried after a short delay.
   */
  async recommendation(window: ImpactWindow): Promise<Recommendation> {
    const dashboard = await this.dashboard(window);
    const key = `${JSON.stringify(dashboard.window)}|${recommendationInputVersion(recommendationFacts(dashboard))}`;
    const cached = this.recommendations.get(key);
    if (cached && (cached.value.source === 'gemini' || this.gateway === undefined || this.now() - cached.storedAt < FALLBACK_RETRY_MS)) {
      return cached.value;
    }
    const value = await generateRecommendation(this.gateway ?? null, dashboard, new Date(this.now()));
    this.recommendations.set(key, { value, storedAt: this.now() });
    return value;
  }
}
