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
  CameraCalibration,
  MeasurementSettings,
} from '../types.js';
import type { Repository } from './repository.js';
import { menuVersionConflict } from '../errors.js';
import { attemptFromStored, calibrationFromStored, measurementFromStored, settingsFromStored } from './legacyPhysical.js';
import { badRequest, conflict } from '../errors.js';

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
  cameraCalibrations?: CameraCalibration[];
  measurementSettings?: MeasurementSettings[];
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
  private cameraCalibrations = new Map<string, CameraCalibration>();
  private measurementSettings = new Map<string, MeasurementSettings>(); // key: hallId

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
    return (this.analysisAttempts.get(eventId) ?? []).map((a) => attemptFromStored(structuredClone(a)));
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
    return (this.measurementsByAttempt.get(attemptId) ?? []).map((m) => this.withPhysical(structuredClone(m)));
  }
  async listMeasurementsByEvent(eventId: string): Promise<FoodMeasurement[]> {
    const out: FoodMeasurement[] = [];
    for (const list of this.measurementsByAttempt.values()) {
      for (const m of list) if (m.eventId === eventId) out.push(this.withPhysical(structuredClone(m)));
    }
    return out;
  }

  /** IT_4: physical area only from the snapshotted calibration (legacyPhysical.ts). */
  private withPhysical(m: FoodMeasurement): FoodMeasurement {
    const id = (m.physical as { calibrationId?: unknown } | undefined)?.calibrationId;
    return measurementFromStored(m, typeof id === 'string' ? this.cameraCalibrations.get(id) : undefined);
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

  // --- IT_4: calibrations + settings (same guards as the reducers) ---
  async upsertCameraCalibration(calibration: CameraCalibration): Promise<void> {
    const existing = this.cameraCalibrations.get(calibration.calibrationId);
    if (existing && existing.status !== 'processing') {
      throw conflict('CALIBRATION_IMMUTABLE', 'This calibration is finished and cannot change.', { calibrationId: calibration.calibrationId });
    }
    this.cameraCalibrations.set(calibration.calibrationId, structuredClone(calibration));
    this.persist();
  }
  async getCameraCalibration(calibrationId: string): Promise<CameraCalibration | undefined> {
    const c = this.cameraCalibrations.get(calibrationId);
    return c ? calibrationFromStored(structuredClone(c)) : undefined;
  }
  async listCameraCalibrations(hallId?: string): Promise<CameraCalibration[]> {
    return [...this.cameraCalibrations.values()]
      .filter((c) => hallId === undefined || c.hallId === hallId)
      .map((c) => calibrationFromStored(structuredClone(c)));
  }
  async upsertMeasurementSettings(settings: MeasurementSettings): Promise<void> {
    if (settings.activeCalibrationId !== null) {
      const cal = this.cameraCalibrations.get(settings.activeCalibrationId);
      if (!cal || cal.hallId !== settings.hallId || cal.status !== 'succeeded') {
        throw badRequest('INVALID_CALIBRATION', 'Only a successful calibration of this hall can be activated.', {
          calibrationId: settings.activeCalibrationId,
        });
      }
    }
    this.measurementSettings.set(settings.hallId, settingsFromStored(structuredClone(settings) as unknown as Record<string, unknown>));
    this.persist();
  }
  async getMeasurementSettings(hallId: string): Promise<MeasurementSettings | undefined> {
    const m = this.measurementSettings.get(hallId);
    return m ? settingsFromStored(structuredClone(m) as unknown as Record<string, unknown>) : undefined;
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
      cameraCalibrations: [...this.cameraCalibrations.values()],
      measurementSettings: [...this.measurementSettings.values()],
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
    for (const c of snapshot.cameraCalibrations ?? []) this.cameraCalibrations.set(c.calibrationId, c);
    for (const m of snapshot.measurementSettings ?? []) this.measurementSettings.set(m.hallId, m);
  }
}
