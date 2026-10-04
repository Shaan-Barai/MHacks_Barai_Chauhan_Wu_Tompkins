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
  captureItemPhysical,
  type CapturePhysicalContext,
  generateRecommendation,
  recommendationFacts,
  RECOMMENDATION_PROMPT_VERSION,
  type TrendHalf,
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
  CameraCalibration,
  CaptureEvent,
  CaptureListItem,
  DailyImpactPoint,
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
  /** IT_4 I9: eventId -> the counted attempt's physical snapshot. */
  physical: Map<string, CapturePhysicalContext>;
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

/** One headline period (pixels; relative impact points; never a physical unit). */
export interface WasteTotal {
  start: string;
  end: string;
  pixels: number;
  impactPoints: number | null;
  captures: number;
  analyzedCaptures: number;
  sampleCaptures: number;
  /**
   * Calibrated estimates for the same period (main's IT_4 design): null when no
   * plate in it was scanned with a calibrated camera, never 0 for missing.
   */
  estimated: { grams: number; kgCo2e: number | null; waterLitres: number | null; calibratedCaptures: number } | null;
}

/** Longest window GET /api/dashboard/impact/daily accepts, in days. */
export const DAILY_IMPACT_MAX_DAYS = 366;

/** YYYY-MM-DD plus n days (calendar arithmetic at UTC noon). */
function addDays(d: string, n: number): string {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export interface WasteTotals {
  today: WasteTotal;
  week: WasteTotal;
  month: WasteTotal;
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

  /** Records for every service whose local date falls in the window (hidden captures only for the admin list). */
  async gather(window: ImpactWindow, opts: { includeHidden?: boolean } = {}): Promise<ServiceRecords[]> {
    const services = (await this.repo.listServices(window.hallId)).filter(
      (s) => s.serviceDate >= window.start && s.serviceDate <= window.end,
    );
    services.sort((a, b) => a.serviceDate.localeCompare(b.serviceDate) || a.serviceId.localeCompare(b.serviceId));
    const out: ServiceRecords[] = [];
    const calibrations = new Map<string, CameraCalibration | null>();
    for (const service of services) {
      const menu = await this.repo.getMenuByService(service.serviceId);
      if (!menu) continue;
      const captures = await this.repo.listCaptureEvents({
        hallId: service.hallId,
        serviceId: service.serviceId,
        includeHidden: opts.includeHidden === true,
      });
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
      const physical = new Map<string, CapturePhysicalContext>();
      for (const [eventId, attempt] of countedAttempts) {
        const event = captures.find((c) => c.eventId === eventId)!;
        physical.set(eventId, await this.physicalContext(attempt, event, calibrations));
      }
      out.push({ menu, captures, countedAttempts, latestAttempts, measurements, items, portions, physical });
    }
    return out;
  }

  /**
   * IT_4 I9: what the counted attempt snapshotted. A method ⇒ calibrated. A
   * calibration that was active but not applied ⇒ incompatible_geometry when
   * its resolution differs from the capture, else no_calibration. No snapshot
   * (no active calibration, or a pre-IT_4 attempt) ⇒ no_calibration.
   */
  private async physicalContext(
    attempt: AnalysisAttempt,
    event: CaptureEvent,
    cache: Map<string, CameraCalibration | null>,
  ): Promise<CapturePhysicalContext> {
    if (attempt.physicalMethod) return { physicalMethod: attempt.physicalMethod };
    if (!attempt.calibrationId) return { physicalMethod: null, unavailableReason: 'no_calibration' };
    if (!cache.has(attempt.calibrationId)) cache.set(attempt.calibrationId, (await this.repo.getCameraCalibration(attempt.calibrationId)) ?? null);
    const cal = cache.get(attempt.calibrationId);
    const mismatch = cal && (cal.widthPx !== event.geometry.widthPx || cal.heightPx !== event.geometry.heightPx);
    return { physicalMethod: null, unavailableReason: mismatch ? 'incompatible_geometry' : 'no_calibration' };
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
      capturePhysical: new Map(records.flatMap((r) => [...r.physical])),
    });
    // Counted attempts' quality flags: vision's target-dish counting marks an
    // attempt that dropped food from a neighboring dish (analytics
    // NEIGHBOR_FOOD_EXCLUDED_FLAG) -> coverage.capturesWithNeighborFoodExcluded.
    const attemptQualityFlags = new Map<string, readonly string[]>();
    for (const r of records) {
      for (const [eventId, attempt] of r.countedAttempts) attemptQualityFlags.set(eventId, attempt.qualityFlags ?? []);
    }
    // Generated sample history (source 'demo') is labeled on the dashboard.
    const sampleCaptures = records.flatMap((r) => r.captures).filter((c) => c.source === 'demo').length;
    const dashboard = buildImpactDashboard({
      window,
      measurements: selected.measurements,
      attemptQualityFlags,
      captures: selected.captures,
      menuItems: records.flatMap((r) => r.items),
      portions: records.flatMap((r) => r.portions),
      factors: { findWasteFactor, findNutritionFactor },
      wasteFactorsVersion: WASTE_FACTORS_VERSION,
      physicalCoverage: selected.physicalCoverage,
    });
    return {
      ...dashboard,
      coverage: { ...dashboard.coverage, sampleCaptures },
      labels: { ...dashboard.labels, sampleData: sampleCaptures > 0 },
    };
  }

  /** Recent plates, newest first, capped (contracts CaptureListItem). */
  async captures(window: ImpactWindow, limit = CAPTURE_LIST_DEFAULT_LIMIT, opts: { includeHidden?: boolean } = {}): Promise<CaptureListItem[]> {
    return (await this.capturesPage(window, limit, opts)).items;
  }

  /** Newest `limit` captures plus the full count (D14: callers can show truncation). */
  async capturesPage(window: ImpactWindow, limit: number, opts: { includeHidden?: boolean } = {}): Promise<{ items: CaptureListItem[]; total: number }> {
    const records = await this.gather(window, opts);
    const items: CaptureListItem[] = [];
    for (const r of records) {
      const names = new Map(r.items.map((i) => [i.itemId, i.displayName]));
      for (const event of r.captures) {
        const attempt = r.countedAttempts.get(event.eventId);
        const rows = attempt ? r.measurements.filter((m) => m.attemptId === attempt.attemptId) : [];
        const seg = attempt?.segmentation;
        const segCounted = seg?.countStatus === 'complete' || seg?.countStatus === 'empty';
        // D2: apply the SAME eligibility rule as the totals (analytics selectImpactMeasurements ->
        // validMaskCount), so the gallery never shows pixels the totals drop.
        const sel = segCounted
          ? selectImpactMeasurements({
              services: [r.menu.service],
              captures: [event],
              measurements: rows,
              menuItems: r.items,
              attemptMenuVersions: new Map([[event.eventId, attempt!.menuVersion]]),
            })
          : null;
        const counted = sel !== null && sel.captures.analyzed === 1;
        const shownPixels = counted ? sel!.measurements.reduce((n, m) => n + m.pixels, 0) : null;
        const notCountedReason = sel !== null && !counted
          ? 'Not counted in the totals: its pixel counts lack validated mask provenance.'
          : undefined;
        const latest = r.latestAttempts.get(event.eventId);
        const ctx = r.physical.get(event.eventId);
        items.push({
          eventId: event.eventId,
          capturedAt: event.capturedAt,
          serviceId: event.serviceId,
          source: event.source,
          state: event.state,
          // null (never 0) unless the counted attempt has a complete or empty count;
          // a counted clean plate is a measured 0.
          pixelsWasted: shownPixels,
          ...(notCountedReason ? { notCountedReason } : {}),
          items: rows.map((m) => {
            const displayName = m.itemId === null ? UNKNOWN_FOOD_LABEL : names.get(m.itemId) ?? readableItemName(m.itemId);
            // IT_4 I8: estimated grams / CO2e / water next to the label (formulas in analytics).
            const est = captureItemPhysical({
              physical: m.physical,
              factor: m.itemId === null ? null : findWasteFactor(displayName),
              unknownItem: m.itemId === null,
              captureReason: ctx?.physicalMethod === null ? ctx.unavailableReason : undefined,
            });
            return {
              itemId: m.itemId,
              displayName,
              pixels: m.remainingAreaPx,
              grams: est.grams,
              kgCo2e: est.kgCo2e,
              waterLitres: est.waterLitres,
              areaCm2: est.areaCm2,
            };
          }),
          hasOverlay: Boolean((attempt ?? latest)?.overlayObjectId),
          calibrationId: attempt?.calibrationId ?? null,
          physicalMethod: attempt?.physicalMethod ?? null,
        });
      }
    }
    items.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || b.eventId.localeCompare(a.eventId));
    return { items: items.slice(0, limit), total: items.length };
  }

  /**
   * Headline totals for today, this week (Monday to today) and this month
   * (1st to today), in pixels, from the same eligible rows as the dashboard.
   */
  async totals(hallId: string | undefined, today: string): Promise<WasteTotals> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw badRequest('INVALID_PARAMETER', "'today' must be YYYY-MM-DD.");
    const t = new Date(`${today}T12:00:00Z`);
    const monday = new Date(t);
    monday.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
    const periods = {
      today: { start: today, end: today },
      week: { start: monday.toISOString().slice(0, 10), end: today },
      month: { start: `${today.slice(0, 8)}01`, end: today },
    };
    // One read for the widest window; each period is built from its own dates.
    const earliest = periods.week.start < periods.month.start ? periods.week.start : periods.month.start;
    const records = await this.gather({ start: earliest, end: today, ...(hallId ? { hallId } : {}) });
    const sum = (p: { start: string; end: string }): WasteTotal => {
      const rows = records.filter((r) => r.menu.service.serviceDate >= p.start && r.menu.service.serviceDate <= p.end);
      const d = this.build({ ...p, ...(hallId ? { hallId } : {}) }, rows);
      return {
        ...p,
        pixels: d.totals.pixels,
        impactPoints: d.totals.impactPoints,
        captures: d.totals.captures,
        analyzedCaptures: d.totals.analyzedCaptures,
        sampleCaptures: d.coverage.sampleCaptures ?? 0,
        estimated:
          d.totals.grams != null && (d.totals.physicalCoverage?.calibratedCaptures ?? 0) > 0
            ? {
                grams: d.totals.grams,
                kgCo2e: d.totals.kgCo2e ?? null,
                waterLitres: d.totals.waterLitres ?? null,
                calibratedCaptures: d.totals.physicalCoverage!.calibratedCaptures,
              }
            : null,
      };
    };
    return { today: sum(periods.today), week: sum(periods.week), month: sum(periods.month) };
  }

  /**
   * One point per local date in the window (inclusive), each built from that
   * date's records exactly like the dashboard totals; one gather for the window.
   */
  async daily(window: ImpactWindow): Promise<DailyImpactPoint[]> {
    const days = Math.round((Date.parse(`${window.end}T12:00:00Z`) - Date.parse(`${window.start}T12:00:00Z`)) / 86_400_000) + 1;
    if (!Number.isFinite(days) || days < 1 || days > DAILY_IMPACT_MAX_DAYS) {
      throw badRequest('INVALID_WINDOW', `The window must cover 1 to ${DAILY_IMPACT_MAX_DAYS} days.`, { start: window.start, end: window.end });
    }
    const records = await this.gather(window);
    const out: DailyImpactPoint[] = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(window.start, i);
      const d = this.build({ ...window, start: date, end: date }, records.filter((r) => r.menu.service.serviceDate === date));
      const calibratedCaptures = d.totals.physicalCoverage?.calibratedCaptures ?? 0;
      const analyzedCaptures = d.totals.analyzedCaptures;
      out.push({
        date,
        pixels: analyzedCaptures > 0 ? d.totals.pixels : null,
        // Same rule as totals().estimated: only with a calibrated plate that day.
        kgCo2e: calibratedCaptures > 0 && d.totals.kgCo2e != null ? d.totals.kgCo2e : null,
        co2Points: analyzedCaptures > 0 ? d.totals.co2Points ?? null : null,
        analyzedCaptures,
        calibratedCaptures,
      });
    }
    return out;
  }

  /** Earlier/later halves of the window (by local date) for the recommendation's trend fact. */
  private halves(window: ImpactWindow, records: ServiceRecords[]): { earlier: TrendHalf; later: TrendHalf } | undefined {
    const day = addDays;
    const days = Math.round((Date.parse(`${window.end}T12:00:00Z`) - Date.parse(`${window.start}T12:00:00Z`)) / 86_400_000) + 1;
    if (days < 2) return undefined;
    const midEnd = day(window.start, Math.floor(days / 2) - 1);
    const half = (start: string, end: string): TrendHalf => {
      const d = this.build({ ...window, start, end }, records.filter((r) => r.menu.service.serviceDate >= start && r.menu.service.serviceDate <= end));
      return { start, end, pixels: d.totals.pixels, analyzedPlates: d.totals.analyzedCaptures };
    };
    return { earlier: half(window.start, midEnd), later: half(day(midEnd, 1), window.end) };
  }

  /** Saved impact recommendations for a hall (insight rows), newest first. */
  async savedRecommendations(hallId: string): Promise<Recommendation[]> {
    const out: Recommendation[] = [];
    // A recommendation made before "Clear data" describes data the dashboard no longer shows.
    const clearedAt = (await this.repo.getDashboardView(hallId))?.clearedAt ?? null;
    for (const i of await this.repo.listInsights(hallId)) {
      if (i.metrics.kind !== 'impact-recommendation') continue;
      if (clearedAt && Date.parse(i.generatedAt) < Date.parse(clearedAt)) continue;
      try {
        const body = JSON.parse(i.recommendation) as Pick<Recommendation, 'text' | 'bullets'>;
        out.push({
          text: body.text,
          bullets: body.bullets,
          source: i.source === 'gemini' ? 'gemini' : 'fallback',
          generatedAt: i.generatedAt,
          inputVersion: i.dataVersion,
          window: { start: i.windowStart, end: i.windowEnd },
        });
      } catch {
        // An unreadable row is skipped, never shown.
      }
    }
    return out.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  /**
   * Grounded recommendation (D8), stored in SpacetimeDB (insight table) with
   * its window, the exact facts it was given and their input version.
   * - A saved Gemini recommendation for the same window and inputs is reused
   *   (the same statistics never pay for a second Gemini call) unless
   *   `regenerate` is set.
   * - If Gemini fails, the last saved Gemini recommendation is returned,
   *   marked `stale` with its own window; with none saved, the labeled
   *   rule-based fallback (retried after a short delay).
   */
  async recommendation(window: ImpactWindow, options: { regenerate?: boolean } = {}): Promise<Recommendation> {
    const records = await this.gather(window);
    const dashboard = this.build(window, records);
    const halves = this.halves(window, records);
    const facts = recommendationFacts(dashboard, halves);
    const inputVersion = recommendationInputVersion(facts);
    const hallId = window.hallId ?? 'all';
    const saved = await this.savedRecommendations(hallId);
    const sameWindow = (r: Recommendation) => r.window?.start === window.start && r.window?.end === window.end;
    if (!options.regenerate) {
      const reuse = saved.find((r) => r.source === 'gemini' && r.inputVersion === inputVersion && sameWindow(r));
      if (reuse) return reuse;
      const cached = this.recommendations.get(`${hallId}|${inputVersion}|${window.start}|${window.end}`);
      if (cached && this.now() - cached.storedAt < FALLBACK_RETRY_MS) return cached.value;
    }

    const generated = { ...(await generateRecommendation(this.gateway ?? null, dashboard, new Date(this.now()), halves)), window: { start: window.start, end: window.end } };
    const hasData = facts.plates.analyzed > 0 && (facts.targets.length > 0 || facts.mostWasted.length > 0);
    if (generated.source === 'gemini' || options.regenerate) await this.store(hallId, window, generated, facts);
    if (generated.source === 'gemini') return generated;

    const lastGemini = saved.find((r) => r.source === 'gemini');
    const value = hasData && lastGemini ? { ...lastGemini, stale: true } : generated;
    this.recommendations.set(`${hallId}|${inputVersion}|${window.start}|${window.end}`, { value, storedAt: this.now() });
    return value;
  }

  private async store(hallId: string, window: ImpactWindow, rec: Recommendation, facts: ReturnType<typeof recommendationFacts>): Promise<void> {
    await this.repo.upsertInsight({
      insightId: `rec_${hallId}_${window.start}_${window.end}_${rec.generatedAt}`,
      hallId,
      windowStart: window.start,
      windowEnd: window.end,
      metrics: {
        kind: 'impact-recommendation',
        promptVersion: RECOMMENDATION_PROMPT_VERSION,
        inputVersion: rec.inputVersion,
        // The exact numbers the recommendation was allowed to use.
        facts: JSON.stringify(facts),
      },
      dataVersion: rec.inputVersion,
      recommendation: JSON.stringify({ text: rec.text, bullets: rec.bullets }),
      source: rec.source === 'gemini' ? 'gemini' : 'fallback_rules',
      generatedAt: rec.generatedAt,
    });
  }
}
