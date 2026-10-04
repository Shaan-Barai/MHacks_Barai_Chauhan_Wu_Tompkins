/**
 * Dashboard read models for Agent 7's UI (UI.md): daily series, the three
 * summary cards, and per-meal detail with a grounded suggestion — all in
 * **Pixels wasted** (contracts/measurement.md): integer counts of foreground
 * pixels in validated leftover-food masks, one union per capture.
 *
 * All formulas come from Agent 6's analytics package (AGENTS.md 5.6): this
 * service only gathers each capture's counted attempt and measurements, makes
 * sure each service has one persisted simulated attendance value, and stores
 * generated insights. The auxiliary per-plate waste percent (analytics
 * plateWaste) and the "Behind the scenes" plate list ride alongside; they
 * never gate Pixels wasted.
 */

import {
  generateAttendance,
  summarizePixels,
  type PixelServiceSummary,
  type TextGateway,
  summarizePortionBenchmarks,
  portionDataVersion,
  generatePortionInsight,
  type PortionBenchmark,
  generatePixelInsight,
  computePixelDataVersion,
  plateWastePercent,
  averagePlateWaste,
  readableItemName,
} from '@scrap/analytics';
import { notFound } from '../errors.js';
import type { BackendConfig } from '../config.js';
import type { Repository } from '../repo/repository.js';
import type { IngestionService } from './ingestionService.js';
import type { AnalysisAttempt, Attendance, CaptureEvent, FoodMeasurement, Insight, MealLabel, MenuBundle } from '../types.js';

const MEALS: MealLabel[] = ['breakfast', 'lunch', 'dinner'];

export interface DailyPoint {
  date: string;
  /** Pixels wasted that day; null = no counted plates. */
  pixelsWasted: number | null;
  capturedDishes: number;
  countedDishes: number;
  /** One entry per scanned plate: its waste percent, or null when unavailable. */
  plateWastePercents: (number | null)[];
}

export interface PeriodTotal {
  start: string;
  end: string;
  pixelsWasted: number;
  /** Same-length window immediately before; null when it has no data. */
  previousPixelsWasted: number | null;
  /** Mean per-plate waste percent (clean plates 0%); null without plates. */
  averagePlateWastePercent: number | null;
  platesCounted: number;
  platesWithoutPercent: number;
}

/** One scanned plate for the "Behind the scenes" view. */
export interface PlateRecord {
  eventId: string;
  capturedAt: string;
  source: string;
  state: CaptureEvent['state'];
  imageObjectId: string;
  /** null when the plate has no usable percent (see analytics plateWaste). */
  plateWastePercent: number | null;
  foods: {
    itemId: string | null;
    name: string;
    leftoverPx: number;
    fullServingPx: number | null;
    /** Leftover as a percent of a full serving, capped at 100; null without one. */
    percentOfServing: number | null;
    flags: string[];
  }[];
}


export interface MealDetailResponse {
  serviceId: string;
  date: string;
  meal: MealLabel;
  summary: PixelServiceSummary;
  attendance: Attendance;
  /**
   * Grounded in the Pixels-wasted-per-portion benchmark (AGENTS.md 7) when a
   * rate exists; otherwise in the meal's measured Pixels wasted.
   */
  insight: Insight | null;
  portionBenchmark: PortionBenchmark;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Monday-start week, matching the frontend's summary cards. */
function startOfWeek(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

export class DashboardService {
  constructor(
    private readonly repo: Repository,
    private readonly ingestion: IngestionService,
    private readonly config: BackendConfig,
    private readonly gateway?: TextGateway,
  ) {}

  /** One persisted simulated value per service; never re-rolled per request (6.3). */
  async ensureAttendance(menu: MenuBundle): Promise<Attendance> {
    const existing = await this.repo.getAttendance(menu.service.serviceId);
    if (existing) return existing;
    const generated = generateAttendance({
      hallId: menu.service.hallId,
      serviceId: menu.service.serviceId,
      serviceDate: menu.service.serviceDate,
      min: this.config.attendance.min,
      max: this.config.attendance.max,
      ...(this.config.attendance.seed ? { seed: this.config.attendance.seed } : {}),
    });
    await this.repo.upsertAttendance(generated);
    return generated;
  }

  /** Captures plus only the counted (latest succeeded) attempt per dish, never double-counted. */
  private async observations(menu: MenuBundle): Promise<{
    captures: CaptureEvent[];
    countedAttempts: Map<string, AnalysisAttempt>;
    latestAttempts: Map<string, AnalysisAttempt>;
    measurements: FoodMeasurement[];
  }> {
    const captures = await this.repo.listCaptureEvents({
      hallId: menu.service.hallId,
      serviceId: menu.service.serviceId,
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
    return { captures, countedAttempts, latestAttempts, measurements };
  }

  private summarize(
    menu: MenuBundle,
    obs: Awaited<ReturnType<DashboardService['observations']>>,
    attendance: Attendance | null,
  ): PixelServiceSummary {
    return summarizePixels({
      service: menu.service,
      captures: obs.captures,
      countedAttempts: obs.countedAttempts,
      latestAttempts: obs.latestAttempts,
      measurements: obs.measurements,
      attendance,
      menuItems: menu.items,
    });
  }

  async serviceSummary(menu: MenuBundle, attendance?: Attendance | null): Promise<PixelServiceSummary> {
    return this.summarize(menu, await this.observations(menu), attendance ?? null);
  }

  async daily(hallId: string, start: string, end: string): Promise<DailyPoint[]> {
    const services = (await this.repo.listServices(hallId)).filter(
      (s) => s.serviceDate >= start && s.serviceDate <= end,
    );
    const byDate = new Map<string, DailyPoint>();
    for (const service of services) {
      const menu = await this.repo.getMenuByService(service.serviceId);
      if (!menu) continue;
      const obs = await this.observations(menu);
      const summary = this.summarize(menu, obs, null);
      const point = byDate.get(service.serviceDate) ?? {
        date: service.serviceDate,
        pixelsWasted: null,
        capturedDishes: 0,
        countedDishes: 0,
        plateWastePercents: [],
      };
      for (const capture of obs.captures) point.plateWastePercents.push(plateWastePercent(capture, obs.measurements));
      point.capturedDishes += summary.captureCount;
      point.countedDishes += summary.countedCaptureCount;
      if (summary.countedCaptureCount > 0) {
        point.pixelsWasted = (point.pixelsWasted ?? 0) + summary.pixelsWasted;
      }
      byDate.set(service.serviceDate, point);
    }
    return eachDay(start, end).map(
      (date) => byDate.get(date) ?? { date, pixelsWasted: null, capturedDishes: 0, countedDishes: 0, plateWastePercents: [] },
    );
  }

  async portionBenchmark(menu: MenuBundle): Promise<PortionBenchmark> {
    const captures = await this.repo.listCaptureEvents({ hallId: menu.service.hallId, serviceId: menu.service.serviceId });
    const measurements: FoodMeasurement[] = [];
    for (const event of captures) {
      if (event.state === 'succeeded') measurements.push(...await this.ingestion.countedMeasurements(event));
    }
    return summarizePortionBenchmarks({ service: menu.service, menuItems: menu.items, captures, measurements,
      portions: await this.repo.listPortionsServed(menu.service.serviceId, menu.service.menuVersion) });
  }

  async cards(hallId: string, today: string): Promise<Record<'today' | 'thisWeek' | 'thisMonth', PeriodTotal>> {
    const monthStart = `${today.slice(0, 8)}01`;
    const windows = { today: today, thisWeek: startOfWeek(today), thisMonth: monthStart };
    const earliest = addDays(monthStart, -31);
    const points = new Map((await this.daily(hallId, earliest, today)).map((p) => [p.date, p]));
    const sum = (start: string, end: string): number | null => {
      let total: number | null = null;
      for (const d of eachDay(start, end)) {
        const v = points.get(d)?.pixelsWasted ?? null;
        if (v !== null) total = (total ?? 0) + v;
      }
      return total;
    };
    const period = (start: string): PeriodTotal => {
      const days = eachDay(start, today).length;
      const prevEnd = addDays(start, -1);
      const plates = averagePlateWaste(eachDay(start, today).flatMap((d) => points.get(d)?.plateWastePercents ?? []));
      return {
        start,
        end: today,
        pixelsWasted: sum(start, today) ?? 0,
        previousPixelsWasted: sum(addDays(prevEnd, -(days - 1)), prevEnd),
        ...plates,
      };
    };
    return {
      today: period(windows.today),
      thisWeek: period(windows.thisWeek),
      thisMonth: period(windows.thisMonth),
    };
  }

  async meal(hallId: string, date: string, meal: MealLabel): Promise<MealDetailResponse> {
    if (!MEALS.includes(meal)) {
      throw notFound('MEAL_NOT_FOUND', 'Pick Breakfast, Lunch, or Dinner.', { meal });
    }
    const [menu] = await this.repo.findMenus(hallId, date, meal);
    if (!menu) {
      throw notFound('MENU_NOT_FOUND', 'No menu for this meal yet. Add one in Menus.', {
        hallId,
        serviceDate: date,
        mealLabel: meal,
      });
    }
    const attendance = await this.ensureAttendance(menu);
    const summary = await this.serviceSummary(menu, attendance);
    const portionBenchmark = await this.portionBenchmark(menu);
    // Per-portion rates rank suggestions when they exist (AGENTS.md 7); without
    // one, suggest from the meal's measured Pixels wasted so each meal gets a tip.
    const insight = portionBenchmark.items.some((i) => i.pixelsWastedPerPortion !== null)
      ? await this.portionInsightFor(portionBenchmark)
      : await this.pixelInsightFor(menu, summary);
    return { serviceId: menu.service.serviceId, date, meal, summary, attendance, insight, portionBenchmark };
  }

  /** Every scanned plate for a meal with its labels, for the "Behind the scenes" view. */
  async plates(hallId: string, date: string, meal: MealLabel): Promise<{ serviceId: string | null; plates: PlateRecord[] }> {
    const [menu] = await this.repo.findMenus(hallId, date, meal);
    if (!menu) return { serviceId: null, plates: [] };
    const { captures, measurements } = await this.observations(menu);
    const names = new Map(menu.items.map((i) => [i.itemId, i.displayName]));
    const plates = captures
      .slice()
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
      .map((capture): PlateRecord => ({
        eventId: capture.eventId,
        capturedAt: capture.capturedAt,
        source: capture.source,
        state: capture.state,
        imageObjectId: capture.imageObjectId,
        plateWastePercent: plateWastePercent(capture, measurements),
        foods: measurements
          .filter((m) => m.eventId === capture.eventId)
          .map((m) => {
            const full = typeof m.baselineAreaPx === 'number' && m.baselineAreaPx > 0 ? m.baselineAreaPx : null;
            return {
              itemId: m.itemId,
              name: m.itemId === null ? 'Unknown food' : names.get(m.itemId) ?? readableItemName(m.itemId),
              leftoverPx: m.remainingAreaPx,
              fullServingPx: full,
              percentOfServing: full === null ? null : Math.round(Math.min(100, (100 * m.remainingAreaPx) / full) * 10) / 10,
              flags: m.qualityFlags,
            };
          }),
      }));
    return { serviceId: menu.service.serviceId, plates };
  }

  /** Pixels-wasted suggestion, stored and reused for identical data like the portion insight. */
  private async pixelInsightFor(menu: MenuBundle, summary: PixelServiceSummary): Promise<Insight> {
    const dataVersion = `pixel-summary-v1|${computePixelDataVersion(summary)}`;
    const stored = (await this.repo.listInsights(menu.service.hallId)).find(
      (i) => i.dataVersion === dataVersion && (i.source === 'gemini' || this.gateway === undefined),
    );
    if (stored) return stored;
    const captures = await this.repo.listCaptureEvents({ hallId: menu.service.hallId, serviceId: menu.service.serviceId });
    const times = captures.map((c) => c.capturedAt).filter((t) => Number.isFinite(Date.parse(t))).sort();
    const now = new Date().toISOString();
    const insight = await generatePixelInsight(
      {
        hallId: menu.service.hallId,
        windowStart: times[0] ?? now,
        windowEnd: times.at(-1) ?? now,
        summary,
        menuItems: menu.items,
        dataVersion,
      },
      this.gateway ? { gateway: this.gateway } : {},
    );
    await this.repo.upsertInsight(insight);
    return insight;
  }

  /**
   * Reuse the stored insight for this exact data; generate (Gemini or labeled
   * fallback) when it changed. A stored fallback is retried with Gemini on the
   * next read, so a transient provider failure doesn't stick.
   */
  private async portionInsightFor(benchmark: PortionBenchmark): Promise<Insight> {
    const dataVersion = portionDataVersion(benchmark);
    const stored = (await this.repo.listInsights(benchmark.hallId)).find(
      (i) => i.dataVersion === dataVersion && (i.source === 'gemini' || this.gateway === undefined),
    );
    if (stored) return stored;

    const captures = await this.repo.listCaptureEvents({ hallId: benchmark.hallId, serviceId: benchmark.serviceId });
    const times = captures.map(c => c.capturedAt).filter(t => Number.isFinite(Date.parse(t))).map(t => new Date(t).toISOString()).sort();
    const now = new Date().toISOString();
    const insight = await generatePortionInsight(benchmark, this.gateway, { windowStart: times[0] ?? now, windowEnd: times.at(-1) ?? now });
    await this.repo.upsertInsight(insight);
    return insight;
  }
}
