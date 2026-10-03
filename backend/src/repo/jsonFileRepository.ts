/**
 * PLACEHOLDER persistence: in-memory maps with optional JSON-file snapshots.
 *
 * This stands in for SpacetimeDB until Agent 2's schema exists (see
 * repository.ts for the swap plan). It is deliberately boring: no indexes,
 * no transactions beyond JS single-threadedness, atomic-enough file writes
 * via rename. Suitable for the demo and tests only.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  MenuBundle,
  MealService,
  ReferencePortion,
  ImageObject,
  CaptureEvent,
  AnalysisAttempt,
  FoodMeasurement,
  Attendance,
  Insight,
} from '../types.js';
import type { Repository } from './repository.js';

interface Snapshot {
  menus: MenuBundle[];
  referencePortions: ReferencePortion[];
  imageObjects: ImageObject[];
  captureEvents: CaptureEvent[];
  analysisAttempts: AnalysisAttempt[];
  measurements: FoodMeasurement[];
  attendance: Attendance[];
  insights: Insight[];
}

export class JsonFileRepository implements Repository {
  private menus = new Map<string, MenuBundle>(); // key: serviceId
  private referencePortions = new Map<string, ReferencePortion>(); // key: baselineId
  private imageObjects = new Map<string, ImageObject>();
  private captureEvents = new Map<string, CaptureEvent>();
  private analysisAttempts = new Map<string, AnalysisAttempt[]>(); // key: eventId
  private measurementsByAttempt = new Map<string, FoodMeasurement[]>();
  private attendance = new Map<string, Attendance>(); // key: serviceId
  private insights = new Map<string, Insight>();

  constructor(private readonly dataFile?: string) {
    if (dataFile && existsSync(dataFile)) this.load(dataFile);
  }

  // --- menus ---
  async upsertMenu(menu: MenuBundle): Promise<void> {
    this.menus.set(menu.service.serviceId, structuredClone(menu));
    this.persist();
  }
  async getMenuByService(serviceId: string): Promise<MenuBundle | undefined> {
    const m = this.menus.get(serviceId);
    return m ? structuredClone(m) : undefined;
  }
  async findMenus(hallId: string, serviceDate: string, mealLabel?: string): Promise<MenuBundle[]> {
    return [...this.menus.values()]
      .filter(
        (m) =>
          m.service.hallId === hallId &&
          m.service.serviceDate === serviceDate &&
          (mealLabel === undefined || m.service.mealLabel === mealLabel),
      )
      .map((m) => structuredClone(m));
  }
  async listServices(hallId?: string): Promise<MealService[]> {
    return [...this.menus.values()]
      .map((m) => structuredClone(m.service))
      .filter((s) => hallId === undefined || s.hallId === hallId);
  }

  // --- reference portions ---
  async upsertReferencePortion(ref: ReferencePortion): Promise<void> {
    this.referencePortions.set(ref.baselineId, structuredClone(ref));
    this.persist();
  }
  async getReferencePortion(baselineId: string): Promise<ReferencePortion | undefined> {
    const r = this.referencePortions.get(baselineId);
    return r ? structuredClone(r) : undefined;
  }
  async listReferencePortions(itemId?: string): Promise<ReferencePortion[]> {
    return [...this.referencePortions.values()]
      .filter((r) => itemId === undefined || r.itemId === itemId)
      .map((r) => structuredClone(r));
  }
  async deleteReferencePortion(baselineId: string): Promise<boolean> {
    const existed = this.referencePortions.delete(baselineId);
    if (existed) this.persist();
    return existed;
  }

  // --- image objects ---
  async upsertImageObject(obj: ImageObject): Promise<void> {
    this.imageObjects.set(obj.objectId, structuredClone(obj));
    this.persist();
  }
  async getImageObject(objectId: string): Promise<ImageObject | undefined> {
    const o = this.imageObjects.get(objectId);
    return o ? structuredClone(o) : undefined;
  }
  async listImageObjects(state?: ImageObject['state']): Promise<ImageObject[]> {
    return [...this.imageObjects.values()]
      .filter((o) => state === undefined || o.state === state)
      .map((o) => structuredClone(o));
  }
  async deleteImageObject(objectId: string): Promise<boolean> {
    const existed = this.imageObjects.delete(objectId);
    if (existed) this.persist();
    return existed;
  }

  // --- capture events ---
  async upsertCaptureEvent(event: CaptureEvent): Promise<void> {
    this.captureEvents.set(event.eventId, structuredClone(event));
    this.persist();
  }
  async getCaptureEvent(eventId: string): Promise<CaptureEvent | undefined> {
    const e = this.captureEvents.get(eventId);
    return e ? structuredClone(e) : undefined;
  }
  async listCaptureEvents(filter?: { hallId?: string; serviceId?: string }): Promise<CaptureEvent[]> {
    return [...this.captureEvents.values()]
      .filter(
        (e) =>
          (filter?.hallId === undefined || e.hallId === filter.hallId) &&
          (filter?.serviceId === undefined || e.serviceId === filter.serviceId),
      )
      .map((e) => structuredClone(e));
  }

  // --- analysis attempts ---
  async addAnalysisAttempt(attempt: AnalysisAttempt): Promise<void> {
    const list = this.analysisAttempts.get(attempt.eventId) ?? [];
    list.push(structuredClone(attempt));
    this.analysisAttempts.set(attempt.eventId, list);
    this.persist();
  }
  async listAnalysisAttempts(eventId: string): Promise<AnalysisAttempt[]> {
    return (this.analysisAttempts.get(eventId) ?? []).map((a) => structuredClone(a));
  }

  // --- measurements ---
  async addMeasurements(measurements: FoodMeasurement[]): Promise<void> {
    for (const m of measurements) {
      const list = this.measurementsByAttempt.get(m.attemptId) ?? [];
      list.push(structuredClone(m));
      this.measurementsByAttempt.set(m.attemptId, list);
    }
    this.persist();
  }
  async listMeasurementsByAttempt(attemptId: string): Promise<FoodMeasurement[]> {
    return (this.measurementsByAttempt.get(attemptId) ?? []).map((m) => structuredClone(m));
  }
  async listMeasurementsByEvent(eventId: string): Promise<FoodMeasurement[]> {
    const out: FoodMeasurement[] = [];
    for (const list of this.measurementsByAttempt.values()) {
      for (const m of list) if (m.eventId === eventId) out.push(structuredClone(m));
    }
    return out;
  }

  // --- attendance ---
  async upsertAttendance(att: Attendance): Promise<void> {
    this.attendance.set(att.serviceId, structuredClone(att));
    this.persist();
  }
  async getAttendance(serviceId: string): Promise<Attendance | undefined> {
    const a = this.attendance.get(serviceId);
    return a ? structuredClone(a) : undefined;
  }

  // --- insights ---
  async upsertInsight(insight: Insight): Promise<void> {
    this.insights.set(insight.insightId, structuredClone(insight));
    this.persist();
  }
  async listInsights(hallId?: string): Promise<Insight[]> {
    return [...this.insights.values()]
      .filter((i) => hallId === undefined || i.hallId === hallId)
      .map((i) => structuredClone(i));
  }

  // --- snapshot persistence ---
  private persist(): void {
    if (!this.dataFile) return;
    const snapshot: Snapshot = {
      menus: [...this.menus.values()],
      referencePortions: [...this.referencePortions.values()],
      imageObjects: [...this.imageObjects.values()],
      captureEvents: [...this.captureEvents.values()],
      analysisAttempts: [...this.analysisAttempts.values()].flat(),
      measurements: [...this.measurementsByAttempt.values()].flat(),
      attendance: [...this.attendance.values()],
      insights: [...this.insights.values()],
    };
    mkdirSync(dirname(this.dataFile), { recursive: true });
    const tmp = `${this.dataFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    renameSync(tmp, this.dataFile);
  }

  private load(dataFile: string): void {
    const snapshot = JSON.parse(readFileSync(dataFile, 'utf8')) as Snapshot;
    for (const m of snapshot.menus ?? []) this.menus.set(m.service.serviceId, m);
    for (const r of snapshot.referencePortions ?? []) this.referencePortions.set(r.baselineId, r);
    for (const o of snapshot.imageObjects ?? []) this.imageObjects.set(o.objectId, o);
    for (const e of snapshot.captureEvents ?? []) this.captureEvents.set(e.eventId, e);
    for (const a of snapshot.analysisAttempts ?? []) {
      const list = this.analysisAttempts.get(a.eventId) ?? [];
      list.push(a);
      this.analysisAttempts.set(a.eventId, list);
    }
    for (const m of snapshot.measurements ?? []) {
      const list = this.measurementsByAttempt.get(m.attemptId) ?? [];
      list.push(m);
      this.measurementsByAttempt.set(m.attemptId, list);
    }
    for (const a of snapshot.attendance ?? []) this.attendance.set(a.serviceId, a);
    for (const i of snapshot.insights ?? []) this.insights.set(i.insightId, i);
  }
}
