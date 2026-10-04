/**
 * Dashboard read models for Agent 7's UI (UI.md): daily series, the three
 * summary cards, and per-meal detail with a grounded suggestion.
 *
 * All formulas come from Agent 6's analytics package (AGENTS.md 5.6): this
 * service only gathers the counted observations, makes sure each service has
 * one persisted simulated attendance value, and stores generated insights.
 * Values stay in pixels ("observed estimated leftover area"); the UI decides
 * how to scale them into friendly "waste units".
 */

import {
  generateAttendance,
  summarizeService,
  type ServiceSummary,
  type TextGateway,
  summarizePortionBenchmarks,
  portionDataVersion,
  generatePortionInsight,
  type PortionBenchmark,
  generateInsight,
  computeDataVersion,
  plateWastePercent,
  averagePlateWaste,
  readableItemName,
} from '@scrap/analytics';
import { notFound } from '../errors.js';
import type { BackendConfig } from '../config.js';
import type { Repository } from '../repo/repository.js';
import type { IngestionService } from './ingestionService.js';
import type { Attendance, CaptureEvent, FoodMeasurement, Insight, MealLabel, MenuBundle } from '../types.js';

const MEALS: MealLabel[] = ['breakfast', 'lunch', 'dinner'];

export interface DailyPoint {
  date: string;
  /** Eligible observed leftover area that day; null = no analyzed plates. */
  observedRemainingAreaPx: number | null;
  capturedDishes: number;
  analyzedDishes: number;
  /** One entry per scanned plate: its waste percent, or null when unavailable. */
  plateWastePercents: (number | null)[];
}

export interface PeriodTotal {
  start: string;
  end: string;
  observedRemainingAreaPx: number;
  /** Same-length window immediately before; null when it has no data. */
  previousObservedRemainingAreaPx: number | null;
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
  summary: ServiceSummary;
  attendance: Attendance;
  /** Null when no counted item exists yet (nothing to ground a tip in). */
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
  private async observations(menu: MenuBundle): Promise<{ captures: CaptureEvent[]; measurements: FoodMeasurement[] }> {
    const captures = await this.repo.listCaptureEvents({
      hallId: menu.service.hallId,
      serviceId: menu.service.serviceId,
    });
    const measurements: FoodMeasurement[] = [];
    for (const event of captures) {
      if (event.state === 'succeeded') measurements.push(...(await this.ingestion.countedMeasurements(event)));
    }
    return { captures, measurements };
  }

  async serviceSummary(menu: MenuBundle, attendance?: Attendance | null): Promise<ServiceSummary> {
    const { captures, measurements } = await this.observations(menu);
    return summarizeService({
      service: menu.service,
      captures,
      measurements,
      attendance: attendance ?? null,
      menuItems: menu.items,
    });
  }

  async daily(hallId: string, start: string, end: string): Promise<DailyPoint[]> {
    const services = (await this.repo.listServices(hallId)).filter(
      (s) => s.serviceDate >= start && s.serviceDate <= end,
    );
    const byDate = new Map<string, DailyPoint>();
    for (const service of services) {
      const menu = await this.repo.getMenuByService(service.serviceId);
      if (!menu) continue;
      const { captures, measurements } = await this.observations(menu);
      const summary = summarizeService({ service: menu.service, captures, measurements, attendance: null, menuItems: menu.items });
      const point = byDate.get(service.serviceDate) ?? {
        date: service.serviceDate,
        observedRemainingAreaPx: null,
        capturedDishes: 0,
        analyzedDishes: 0,
        plateWastePercents: [],
      };
      for (const capture of captures) point.plateWastePercents.push(plateWastePercent(capture, measurements));
      point.capturedDishes += summary.captureCount;
      point.analyzedDishes += summary.succeededCaptureCount;
      if (summary.succeededCaptureCount > 0) {
        point.observedRemainingAreaPx = (point.observedRemainingAreaPx ?? 0) + summary.observedRemainingAreaPx;
      }
      byDate.set(service.serviceDate, point);
    }
    return eachDay(start, end).map(
      (date) =>
        byDate.get(date) ?? { date, observedRemainingAreaPx: null, capturedDishes: 0, analyzedDishes: 0, plateWastePercents: [] },
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
        const v = points.get(d)?.observedRemainingAreaPx ?? null;
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
        observedRemainingAreaPx: sum(start, today) ?? 0,
        previousObservedRemainingAreaPx: sum(addDays(prevEnd, -(days - 1)), prevEnd),
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
    // Per-portion rates rank suggestions when they exist; until validated mask
    // counts do, suggest from the meal's observed waste share instead.
    const insight = portionBenchmark.items.some((i) => i.pixelsWastedPerPortion !== null)
      ? await this.portionInsightFor(portionBenchmark)
      : await this.summaryInsightFor(menu, summary);
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

  /** Waste-share suggestion, stored and reused for identical data like the portion insight. */
  private async summaryInsightFor(menu: MenuBundle, summary: ServiceSummary): Promise<Insight> {
    const dataVersion = `summary-plain-v1|${computeDataVersion(summary)}`;
    const stored = (await this.repo.listInsights(menu.service.hallId)).find(
      (i) => i.dataVersion === dataVersion && (i.source === 'gemini' || this.gateway === undefined),
    );
    if (stored) return stored;
    const captures = await this.repo.listCaptureEvents({ hallId: menu.service.hallId, serviceId: menu.service.serviceId });
    const times = captures.map((c) => c.capturedAt).filter((t) => Number.isFinite(Date.parse(t))).sort();
    const now = new Date().toISOString();
    const insight = await generateInsight(
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
