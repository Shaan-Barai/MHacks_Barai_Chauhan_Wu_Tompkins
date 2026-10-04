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
  MenuItem,
  ReferencePortion,
  ImageObject,
  CaptureEvent,
  AnalysisAttempt,
  FoodMeasurement,
  PortionsServed,
  Attendance,
  Insight,
  ScanInfo,
} from '../types.js';
import type { DemoMarker, Repository } from './repository.js';
import { menuVersionConflict } from '../errors.js';
import { conflict } from '../errors.js';

interface Snapshot {
  menus: MenuBundle[];
  /** Items dropped by a later menu revision (mirrors menu_item_revision). */
  archivedMenuItems?: Array<MenuItem & { menuVersion: number }>;
  referencePortions: ReferencePortion[];
  imageObjects: ImageObject[];
  captureEvents: CaptureEvent[];
  analysisAttempts: AnalysisAttempt[];
  measurements: FoodMeasurement[];
  attendance: Attendance[];
  insights: Insight[];
  portionsServed: PortionsServed[];
  scans?: ScanInfo[];
  demoMarkers?: DemoMarker[];
}

export class JsonFileRepository implements Repository {
  private menus = new Map<string, MenuBundle>(); // key: serviceId
  /** Superseded items by itemId, newest version last (mirrors menu_item_revision). */
  private archivedMenuItems = new Map<string, Array<MenuItem & { menuVersion: number }>>();
  private referencePortions = new Map<string, ReferencePortion>(); // key: baselineId
  private imageObjects = new Map<string, ImageObject>();
  private captureEvents = new Map<string, CaptureEvent>();
  private analysisAttempts = new Map<string, AnalysisAttempt[]>(); // key: eventId
  private measurementsByAttempt = new Map<string, FoodMeasurement[]>();
  private attendance = new Map<string, Attendance>(); // key: serviceId
  private insights = new Map<string, Insight>();
  private portionsServed = new Map<string, PortionsServed>();
  private scans = new Map<string, ScanInfo>(); // key: eventId
  private demoMarkers = new Map<string, DemoMarker>(); // key: `${tableName}:${rowKey}`

  constructor(private readonly dataFile?: string) {
    if (dataFile && existsSync(dataFile)) this.load(dataFile);
  }

  // --- menus ---
  async upsertMenu(menu: MenuBundle): Promise<void> {
    // Same guard as the upsert_menu reducer: never overwrite a newer version;
    // a newer version archives the superseded items.
    const existing = this.menus.get(menu.service.serviceId);
    if (existing && menu.service.menuVersion < existing.service.menuVersion) {
      throw menuVersionConflict({ serviceId: menu.service.serviceId, menuVersion: menu.service.menuVersion, storedVersion: existing.service.menuVersion });
    }
    if (existing && menu.service.menuVersion > existing.service.menuVersion) {
      for (const item of existing.items) this.archiveItem({ ...structuredClone(item), menuVersion: existing.service.menuVersion });
    }
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
  private archiveItem(item: MenuItem & { menuVersion: number }): void {
    const list = (this.archivedMenuItems.get(item.itemId) ?? []).filter((i) => i.menuVersion !== item.menuVersion);
    list.push(item);
    list.sort((a, b) => a.menuVersion - b.menuVersion);
    this.archivedMenuItems.set(item.itemId, list);
  }
  async getMenuItem(itemId: string): Promise<MenuItem | undefined> {
    for (const m of this.menus.values()) {
      const item = m.items.find((i) => i.itemId === itemId);
      if (item) return structuredClone(item);
    }
    const archived = this.archivedMenuItems.get(itemId)?.at(-1);
    if (!archived) return undefined;
    const { menuVersion: _v, ...item } = archived;
    return structuredClone(item);
  }
  async listServices(hallId?: string): Promise<MealService[]> {
    return [...this.menus.values()]
      .map((m) => structuredClone(m.service))
      .filter((s) => hallId === undefined || s.hallId === hallId);
  }

  // --- reference portions ---
  async replacePortionsServed(serviceId: string, menuVersion: number, portions: PortionsServed[]): Promise<void> {
    // Check again at write time so a simultaneous menu revision cannot accept stale counts.
    const menu = this.menus.get(serviceId);
    if (!menu || menu.service.menuVersion !== menuVersion) throw conflict('STALE_PORTIONS_MENU', 'The menu changed; reload before saving portions.');
    for (const [key, p] of this.portionsServed) {
      if (p.serviceId === serviceId && p.menuVersion === menuVersion) this.portionsServed.delete(key);
    }
    for (const p of portions) this.portionsServed.set(p.recordId, structuredClone(p));
    this.persist();
  }
  async listPortionsServed(serviceId: string, menuVersion: number): Promise<PortionsServed[]> {
    return [...this.portionsServed.values()].filter(p => p.serviceId === serviceId && p.menuVersion === menuVersion).map(p => structuredClone(p));
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

  async findImageObjectsByAssociation(kind: ImageObject['association']['kind'], id: string): Promise<ImageObject[]> {
    return [...this.imageObjects.values()]
      .filter((o) => o.association.kind === kind && o.association.id === id)
      .map((o) => structuredClone(o));
  }

  // --- scans ---
  async upsertScanInfo(scan: ScanInfo): Promise<void> {
    this.scans.set(scan.eventId, structuredClone(scan));
    this.persist();
  }
  async getScanInfo(eventId: string): Promise<ScanInfo | undefined> {
    const s = this.scans.get(eventId);
    return s ? structuredClone(s) : undefined;
  }

  // --- sample data ---
  async recordDemoMarkers(markers: DemoMarker[]): Promise<void> {
    for (const m of markers) this.demoMarkers.set(`${m.tableName}:${m.rowKey}`, { ...m });
    this.persist();
  }
  async clearDemoData(): Promise<number> {
    const markers = [...this.demoMarkers.values()];
    for (const { tableName, rowKey } of markers) {
      if (tableName === 'meal_service') {
        this.menus.delete(rowKey);
        this.attendance.delete(rowKey);
      }
      else if (tableName === 'portions_served') this.portionsServed.delete(rowKey);
      else if (tableName === 'capture_event') this.captureEvents.delete(rowKey);
      else if (tableName === 'scan_info') this.scans.delete(rowKey);
      else if (tableName === 'analysis_attempt') {
        for (const [eventId, list] of this.analysisAttempts) {
          const kept = list.filter((a) => a.attemptId !== rowKey);
          if (kept.length === 0) this.analysisAttempts.delete(eventId);
          else this.analysisAttempts.set(eventId, kept);
        }
        this.measurementsByAttempt.delete(rowKey);
      } else if (tableName === 'food_measurement') {
        for (const [attemptId, list] of this.measurementsByAttempt) {
          this.measurementsByAttempt.set(attemptId, list.filter((m) => m.measurementId !== rowKey));
        }
      }
      // menu_item rows go with their meal_service (menus are stored as bundles);
      // capture_count lives on the attempt here.
    }
    this.demoMarkers.clear();
    this.persist();
    return markers.length;
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
  async recordAnalysis(attempt: AnalysisAttempt, measurements: FoodMeasurement[]): Promise<void> {
    await this.addAnalysisAttempt(attempt);
    if (measurements.length > 0) await this.addMeasurements(measurements);
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
      archivedMenuItems: [...this.archivedMenuItems.values()].flat(),
      referencePortions: [...this.referencePortions.values()],
      imageObjects: [...this.imageObjects.values()],
      captureEvents: [...this.captureEvents.values()],
      analysisAttempts: [...this.analysisAttempts.values()].flat(),
      measurements: [...this.measurementsByAttempt.values()].flat(),
      attendance: [...this.attendance.values()],
      insights: [...this.insights.values()],
      portionsServed: [...this.portionsServed.values()],
      scans: [...this.scans.values()],
      demoMarkers: [...this.demoMarkers.values()],
    };
    mkdirSync(dirname(this.dataFile), { recursive: true });
    const tmp = `${this.dataFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    renameSync(tmp, this.dataFile);
  }

  private load(dataFile: string): void {
    const snapshot = JSON.parse(readFileSync(dataFile, 'utf8')) as Snapshot;
    for (const m of snapshot.menus ?? []) this.menus.set(m.service.serviceId, m);
    for (const i of snapshot.archivedMenuItems ?? []) this.archiveItem(i);
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
    for (const p of snapshot.portionsServed ?? []) this.portionsServed.set(p.recordId, p);
    for (const sc of snapshot.scans ?? []) this.scans.set(sc.eventId, sc);
    for (const m of snapshot.demoMarkers ?? []) this.demoMarkers.set(`${m.tableName}:${m.rowKey}`, m);
  }
}
