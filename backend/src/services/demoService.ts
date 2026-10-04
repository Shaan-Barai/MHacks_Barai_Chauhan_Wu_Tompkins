/**
 * Sample history for the dashboard charts (DEMO_SEED).
 *
 * Fills ~14 days of breakfast/lunch/dinner with SAMPLE scans so the trend
 * chart, per-portion ranking and recommendation have something to show
 * before real scans accumulate. Everything it writes is flagged:
 *   - its own services/menus/items (`svc_demo_…`, `menu_demo_…`), never a
 *     real one; a slot that already has a real service is skipped,
 *   - captures with source 'demo' (no photo: imageObjectId 'demo:none'),
 *     scan rows with demo: true, portions with source 'demo',
 *   - and every row is listed in demo_marker first, so `npm run demo:clear`
 *     (clear_demo_data) removes exactly these rows and nothing real.
 * Pixel values are generated, not measured: deterministic for a seed, with a
 * per-food waste tendency and a mild downward trend over the window.
 */

import { DEMO_PORTION_RANGES, WASTE_FACTOR_MENU_TEXT, factorKeyFor, portionRole } from 'scrap-data';
import { badRequest } from '../errors.js';
import type { DemoMarker, Repository } from '../repo/repository.js';
import type {
  AnalysisAttempt,
  CaptureEvent,
  FoodMeasurement,
  ImageGeometry,
  MealLabel,
  MenuBundle,
  MenuItem,
  PortionsServed,
} from '../types.js';

export const DEMO_TIME_ZONE = 'America/Detroit';

export interface DemoStatus {
  hallId: string;
  mode: 'default' | 'sample' | 'cleared';
  sampleLoaded: boolean;
  sampleCaptures: number;
  clearedAt: string | null;
}

export const DEMO_HISTORY_VERSION = 'demo-history-v1';
const DEMO_IMAGE = 'demo:none';
const GEOMETRY: ImageGeometry = { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' };

export interface DemoSeedOptions {
  hallId: string;
  /** Last day of the history (hall local date, YYYY-MM-DD). */
  endDate: string;
  days?: number;
  seed?: string;
  timeZone?: string;
}

export interface DemoSeedResult {
  services: number;
  captures: number;
  measurements: number;
  /** Day/meal slots skipped because a real (or earlier demo) service exists. */
  skippedSlots: string[];
}

/** Meal → foods (by CSV name) and local serving time. Dinner is the full 23-food menu. */
const MEALS: Array<{ meal: MealLabel; time: string; foods: string[] | 'all'; plates: [number, number] }> = [
  {
    meal: 'breakfast',
    time: '08:00',
    foods: ['Oven Roasted Garlic Potatoes', 'Baked Sweet Potatoes', 'Farro', 'Cheese Bread', 'Strawberry Shortcake Bar', 'Pumpkin Pie'],
    plates: [4, 8],
  },
  {
    meal: 'lunch',
    time: '12:00',
    foods: [
      'Broccoli Cheddar Soup', 'Cheese Pizza', 'Pepperoni Pizza', 'Panzanella Salad', 'Sticky Rice',
      'Vegetable Stir Fry Blend', 'Michigan Farmers 4 Bean Stew', 'Golden Cake with Chocolate Frosting',
    ],
    plates: [6, 12],
  },
  { meal: 'dinner', time: '17:30', foods: 'all', plates: [8, 14] },
];

/** Typical leftover area (pixels in the 1024x1024 frame) per food role. */
const ROLE_PIXELS: Record<ReturnType<typeof portionRole>, number> = {
  pizza: 15000,
  entree: 22000,
  side: 12000,
  soup: 16000,
  dessert: 8000,
};

/** Deterministic PRNG in [0, 1) for a key (FNV-1a + xorshift). */
export function demoRandom(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h << 13;
  h ^= h >>> 17;
  h ^= h << 5;
  return (h >>> 0) / 0x1_0000_0000;
}

function intIn(key: string, min: number, max: number): number {
  return min + Math.floor(demoRandom(key) * (max - min + 1));
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** UTC instant for a hall-local date + "HH:MM" (two-pass offset correction, DST-safe). */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const target = Date.parse(`${date}T${time}:00Z`);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
    );
    const shown = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
    guess += target - shown;
  }
  return new Date(guess);
}

export class DemoService {
  constructor(
    private readonly repo: Repository,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async seedHistory(options: DemoSeedOptions): Promise<DemoSeedResult> {
    const days = options.days ?? 14;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.endDate) || !Number.isInteger(days) || days < 1 || days > 60) {
      throw badRequest('INVALID_DEMO_SEED', 'Demo history needs endDate (YYYY-MM-DD) and 1-60 days.');
    }
    const seed = options.seed ?? DEMO_HISTORY_VERSION;
    const timeZone = options.timeZone ?? 'America/Detroit';
    const { hallId } = options;
    const existing = await this.repo.listServices(hallId);
    const taken = new Set(existing.map((s) => `${s.serviceDate}|${s.mealLabel}`));
    const result: DemoSeedResult = { services: 0, captures: 0, measurements: 0, skippedSlots: [] };
    const foods = WASTE_FACTOR_MENU_TEXT;

    for (let d = days - 1; d >= 0; d--) {
      const date = addDays(options.endDate, -d);
      // 1.15 → 0.85 over the window: waste trending down, so the chart has a story.
      const trend = days === 1 ? 1 : 1.15 - (0.3 * (days - 1 - d)) / (days - 1);
      for (const plan of MEALS) {
        if (taken.has(`${date}|${plan.meal}`)) {
          result.skippedSlots.push(`${date} ${plan.meal}`);
          continue;
        }
        const slot = `${hallId}_${date}_${plan.meal}`;
        const serviceId = `svc_demo_${slot}`;
        const menuId = `menu_demo_${slot}`;
        const rows = plan.foods === 'all' ? foods : foods.filter((f) => (plan.foods as string[]).includes(f.food));
        const items: MenuItem[] = rows.map((f) => ({
          itemId: `item_demo_${slot}_${f.factorKey}`,
          menuId,
          displayName: f.food,
          category: f.station,
        }));
        const bundle: MenuBundle = {
          service: { serviceId, hallId, hallTimezone: timeZone, serviceDate: date, mealLabel: plan.meal, menuId, menuVersion: 1 },
          items,
        };
        const portions: PortionsServed[] = items.map((item) => {
          const [min, max] = DEMO_PORTION_RANGES[portionRole(factorKeyFor(item.displayName), item.category ?? '')];
          // Fewer people at breakfast.
          const scale = plan.meal === 'breakfast' ? 0.5 : 1;
          return {
            recordId: JSON.stringify([serviceId, 1, item.itemId]),
            hallId,
            serviceId,
            serviceDate: date,
            menuId,
            menuVersion: 1,
            itemId: item.itemId,
            count: Math.max(1, Math.round(intIn(`${seed}|portions|${serviceId}|${item.itemId}`, min, max) * scale)),
            source: 'demo',
            updatedAt: zonedToUtc(date, '22:00', timeZone).toISOString(),
          };
        });

        // Captures first in memory, so every marker exists before any row is written.
        const plates = intIn(`${seed}|plates|${serviceId}`, plan.plates[0], plan.plates[1]);
        const scans: Array<{ event: CaptureEvent; attempt: AnalysisAttempt; measurements: FoodMeasurement[] }> = [];
        for (let p = 0; p < plates; p++) {
          const eventId = `cap_demo_${slot}_${String(p + 1).padStart(2, '0')}`;
          const attemptId = `att_demo_${slot}_${String(p + 1).padStart(2, '0')}`;
          const capturedAt = new Date(zonedToUtc(date, plan.time, timeZone).getTime() + p * 4 * 60_000).toISOString();
          const clean = demoRandom(`${seed}|clean|${eventId}`) < 0.1;
          const count = clean ? 0 : intIn(`${seed}|count|${eventId}`, 1, 3);
          const picked = new Set<number>();
          const measurements: FoodMeasurement[] = [];
          for (let k = 0; k < count; k++) {
            const idx = intIn(`${seed}|food|${eventId}|${k}`, 0, items.length - 1);
            if (picked.has(idx)) continue;
            picked.add(idx);
            const item = items[idx]!;
            const key = factorKeyFor(item.displayName);
            // Each food has a stable waste tendency (0.5x-1.8x), so rankings are meaningful.
            const tendency = 0.5 + 1.3 * demoRandom(`${seed}|tendency|${key}`);
            const noise = 0.6 + 0.8 * demoRandom(`${seed}|px|${eventId}|${k}`);
            const base = ROLE_PIXELS[portionRole(key, item.category ?? '')];
            const pixels = Math.max(200, Math.round(base * tendency * noise * trend));
            const measurementId = `msr_demo_${slot}_${String(p + 1).padStart(2, '0')}_${k}`;
            measurements.push({
              measurementId,
              eventId,
              attemptId,
              itemId: item.itemId,
              remainingAreaPx: pixels,
              method: 'mask_pixel_count',
              maskCount: {
                pixelsWasted: pixels,
                maskObjectId: DEMO_IMAGE,
                geometry: GEOMETRY,
                menuId,
                menuVersion: 1,
                classificationVersion: DEMO_HISTORY_VERSION,
                segmentationVersion: DEMO_HISTORY_VERSION,
                processingVersion: DEMO_HISTORY_VERSION,
                assignment: 'exclusive',
                validated: true,
              },
              unavailableReason: 'sample data: no baseline',
              qualityFlags: [],
            });
          }
          const total = measurements.reduce((s, m) => s + m.remainingAreaPx, 0);
          const event: CaptureEvent = {
            eventId, hallId, serviceId, capturedAt, imageObjectId: DEMO_IMAGE, geometry: GEOMETRY, source: 'demo', qualityFlags: [], state: 'succeeded',
          };
          const attempt: AnalysisAttempt = {
            eventId,
            attemptId,
            menuId,
            menuVersion: 1,
            baselineVersions: {},
            model: DEMO_HISTORY_VERSION,
            promptVersion: DEMO_HISTORY_VERSION,
            status: 'succeeded',
            qualityFlags: [],
            createdAt: capturedAt,
            segmentation: {
              model: DEMO_HISTORY_VERSION,
              checkpoint: DEMO_HISTORY_VERSION,
              codeRevision: DEMO_HISTORY_VERSION,
              promptSource: 'gemini_box',
              settingsVersion: DEMO_HISTORY_VERSION,
              countingRuleVersion: DEMO_HISTORY_VERSION,
              status: total === 0 ? 'skipped' : 'succeeded',
              countStatus: total === 0 ? 'empty' : 'complete',
              capturePixelsWasted: total,
              widthPx: GEOMETRY.widthPx,
              heightPx: GEOMETRY.heightPx,
              regions: [],
            },
          };
          scans.push({ event, attempt, measurements });
        }

        const markers: DemoMarker[] = [
          { tableName: 'meal_service', rowKey: serviceId },
          ...items.map((i) => ({ tableName: 'menu_item' as const, rowKey: i.itemId })),
          ...portions.map((p) => ({ tableName: 'portions_served' as const, rowKey: p.recordId })),
          ...scans.flatMap(({ event, attempt, measurements }) => [
            { tableName: 'capture_event' as const, rowKey: event.eventId },
            { tableName: 'scan_info' as const, rowKey: event.eventId },
            { tableName: 'analysis_attempt' as const, rowKey: attempt.attemptId },
            { tableName: 'capture_count' as const, rowKey: attempt.attemptId },
            ...measurements.map((m) => ({ tableName: 'food_measurement' as const, rowKey: m.measurementId })),
          ]),
        ];
        await this.repo.recordDemoMarkers(markers);
        await this.repo.upsertMenu(bundle);
        await this.repo.replacePortionsServed(serviceId, 1, portions);
        for (const { event, attempt, measurements } of scans) {
          await this.repo.upsertCaptureEvent(event);
          await this.repo.upsertScanInfo({ eventId: event.eventId, deviceId: 'sample-data', timestampBasis: 'demo', demo: true });
          await this.repo.recordAnalysis(attempt, measurements);
          result.captures++;
          result.measurements += measurements.length;
        }
        result.services++;
      }
    }
    return result;
  }

  /** Dashboard demo-data state for a hall (GET /api/demo/status). */
  async status(hallId: string): Promise<DemoStatus> {
    const clearedAt = (await this.repo.getDashboardView(hallId))?.clearedAt ?? null;
    const sampleCaptures = (await this.repo.listCaptureEvents({ hallId, includeHidden: true })).filter((c) => c.source === 'demo').length;
    return {
      hallId,
      mode: clearedAt ? 'cleared' : sampleCaptures > 0 ? 'sample' : 'default',
      sampleLoaded: sampleCaptures > 0,
      sampleCaptures,
      clearedAt,
    };
  }

  /** Load dummy data: drop the cutoff and add the sample history (idempotent). */
  async load(hallId: string): Promise<DemoStatus> {
    await this.repo.setDashboardView(hallId, null, new Date(this.now()).toISOString());
    const endDate = new Intl.DateTimeFormat('en-CA', { timeZone: DEMO_TIME_ZONE }).format(new Date(this.now()));
    await this.seedHistory({ hallId, endDate });
    return this.status(hallId);
  }

  /** Clear data: remove sample rows and hide every capture taken before now. Real captures stay stored. */
  async clearData(hallId: string): Promise<DemoStatus> {
    await this.repo.clearDemoData();
    await this.repo.setDashboardView(hallId, new Date(this.now()).toISOString(), new Date(this.now()).toISOString());
    return this.status(hallId);
  }

  /** Restore default: remove sample rows and the cutoff, back to the live dashboard. */
  async restore(hallId: string): Promise<DemoStatus> {
    await this.repo.clearDemoData();
    await this.repo.setDashboardView(hallId, null, new Date(this.now()).toISOString());
    return this.status(hallId);
  }

  /** Remove every sample row (and only those). */
  async clear(): Promise<{ removedRows: number }> {
    return { removedRows: await this.repo.clearDemoData() };
  }
}
