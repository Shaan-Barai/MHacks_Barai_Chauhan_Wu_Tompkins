/**
 * Waste-impact read models (BIG-PLAN v2): the impact dashboard, the
 * recent-plates list, and the AI recommendation, in Pixels wasted plus
 * relative impact points. The backend only gathers records for a reporting
 * window: each capture's counted (latest succeeded) attempt (its quality
 * flags feed the neighbor-food coverage count), that attempt's mask
 * measurements, the service menus, and portions served. Every formula
 * (points, per-portion rates, rankings, the recommendation prompt and its
 * fallback) lives in `@scrap/analytics` (AGENTS.md 5.6). There is no plate
 * calibration and there are no grams; a legacy attempt's `calibration` is
 * ignored.
 */

import {
  buildImpactDashboard,
  generateRecommendation,
  recommendationFacts,
  recommendationInputVersion,
  selectImpactMeasurements,
  UNKNOWN_FOOD_LABEL,
  readableItemName,
  type TextGateway,
} from '@scrap/analytics';
import { findNutritionFactor, findWasteFactor, WASTE_FACTORS_VERSION } from 'scrap-data';
import { badRequest } from '../errors.js';
import type { Repository } from '../repo/repository.js';
import type { IngestionService } from './ingestionService.js';
import { ItemNameResolver } from './itemNames.js';
import type {
  AnalysisAttempt,
  CaptureEvent,
  CaptureListItem,
  FoodMeasurement,
  ImpactDashboard,
  MenuBundle,
  MenuItem,
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
  /** eventId -> the counted (latest succeeded) attempt. */
  countedAttempts: Map<string, AnalysisAttempt>;
  /** eventId -> latest attempt of any status (exclusion reasons). */
  latestAttempts: Map<string, AnalysisAttempt>;
  /** Measurements of the counted attempts only. */
  measurements: FoodMeasurement[];
  /**
   * Current menu items plus any item an older counted attempt measured that a
   * later revision dropped (stored row, else humanized id; ItemNameResolver).
   */
  items: MenuItem[];
  /** Portions served for every menu version a counted attempt froze (and the current one). */
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
  private readonly names: ItemNameResolver;

  constructor(
    private readonly repo: Repository,
    private readonly ingestion: IngestionService,
    /** Live Gemini only; mock text is never a recommendation (fallback instead). */
    private readonly gateway?: TextGateway,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.names = new ItemNameResolver(repo);
  }

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
      // A capture counts against the menu version its attempt froze, so a
      // later revision neither drops it nor pairs it with the wrong portions.
      const versions = new Set([menu.service.menuVersion, ...[...countedAttempts.values()].map((a) => a.menuVersion)]);
      const portions: PortionsServed[] = [];
      for (const v of versions) portions.push(...(await this.repo.listPortionsServed(service.serviceId, v)));
      const items = [...(await this.names.items(menu, measurements.map((m) => m.itemId))).values()];
      out.push({ menu, captures, countedAttempts, latestAttempts, measurements, items, portions });
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
      menuItems: records.flatMap((r) => r.items),
      attemptMenuVersions: new Map(records.flatMap((r) => [...r.countedAttempts].map(([eventId, a]) => [eventId, a.menuVersion] as const))),
    });
    // Counted attempts' quality flags: vision's target-dish counting marks an
    // attempt that dropped food from a neighboring dish (analytics
    // NEIGHBOR_FOOD_EXCLUDED_FLAG) -> coverage.capturesWithNeighborFoodExcluded.
    const attemptQualityFlags = new Map<string, readonly string[]>();
    for (const r of records) {
      for (const [eventId, attempt] of r.countedAttempts) attemptQualityFlags.set(eventId, attempt.qualityFlags ?? []);
    }
    return buildImpactDashboard({
      window,
      measurements: selected.measurements,
      attemptQualityFlags,
      captures: selected.captures,
      menuItems: records.flatMap((r) => r.items),
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
      const names = new Map(r.items.map((i) => [i.itemId, i.displayName]));
      for (const event of r.captures) {
        const attempt = r.countedAttempts.get(event.eventId);
        const rows = attempt ? r.measurements.filter((m) => m.attemptId === attempt.attemptId) : [];
        const seg = attempt?.segmentation;
        const counted = seg?.countStatus === 'complete' || seg?.countStatus === 'empty';
        const latest = r.latestAttempts.get(event.eventId);
        items.push({
          eventId: event.eventId,
          capturedAt: event.capturedAt,
          serviceId: event.serviceId,
          source: event.source,
          state: event.state,
          // null (never 0) unless the counted attempt has a complete or empty count;
          // a counted clean plate is a measured 0.
          pixelsWasted: counted ? seg!.capturePixelsWasted ?? null : null,
          items: rows.map((m) => ({
            itemId: m.itemId,
            displayName: m.itemId === null ? UNKNOWN_FOOD_LABEL : names.get(m.itemId) ?? readableItemName(m.itemId),
            pixels: m.remainingAreaPx,
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
