/**
 * Supabase (Postgres) Repository, replacing SpacetimeDB (contracts/decisions.md
 * 2026-10-24). Same interface, same record shapes: the service layer does not
 * change.
 *
 * - Writes use the service role key (server only; never sent to a browser).
 *   Multi-row writes call the transactional Postgres functions in
 *   supabase/migrations/*_write_functions.sql (one call = one transaction, like
 *   a reducer). Single-row writes are upserts on the primary key, so retries
 *   update the same row (idempotent ingestion by eventId).
 * - Reads go through PostgREST and page past its 1000-row response limit.
 * - Rows map back to the contract shapes the SpacetimeDB repository returned:
 *   snake_case -> camelCase, SQL NULL -> absent optional field, timestamptz ->
 *   UTC ISO string, flattened capture geometry -> `geometry`.
 *
 * Only references and metadata cross this boundary — image bytes stay in
 * Supabase Storage (AGENTS.md §2).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
  ClassificationRegion,
  SegmentationResult,
  PlateCalibration,
  CameraCalibration,
  MeasurementSettings,
  PlateScaleRecord,
  ScanInfo,
} from '../types.js';
import { isBeforeCutoff, type CaptureEventFilter, type DemoMarker, type Repository } from './repository.js';
import { attemptFromStored, calibrationFromStored, measurementFromStored, settingsFromStored } from './legacyPhysical.js';
import { badRequest, conflict, menuVersionConflict } from '../errors.js';

export interface SupabaseRepoConfig {
  /** Project API URL, https://<ref>.supabase.co */
  url: string;
  /** Service role (secret) key. Server only. */
  serviceRoleKey: string;
  /** Injectable for tests. */
  client?: SupabaseClient;
}

type Row = Record<string, any>;

/** Postgres timestamptz columns, returned to callers as UTC ISO 8601 strings. */
const TIMESTAMP_COLUMNS = new Set([
  'uploaded_at', 'captured_at', 'created_at', 'superseded_at', 'updated_at',
  'window_start', 'window_end', 'generated_at', 'cleared_at',
]);

const PAGE = 1000;

function camel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function snake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Drop null/undefined values recursively (SQL NULL = an absent optional contract field). */
function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropNulls) as T;
  if (value === null || typeof value !== 'object') return value;
  const out: Row = {};
  for (const [k, v] of Object.entries(value as Row)) if (v !== null && v !== undefined) out[k] = dropNulls(v);
  return out as T;
}

/** A Postgres row as a contract-shaped record. */
function fromRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    out[camel(key)] = TIMESTAMP_COLUMNS.has(key) && typeof value === 'string' ? new Date(value).toISOString() : dropNulls(value);
  }
  return out;
}

/** A contract-shaped record as a Postgres row (undefined fields become NULL). */
function toRow(record: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(record)) out[snake(key)] = value === undefined ? null : value;
  return out;
}

export class SupabaseRepository implements Repository {
  private readonly db: SupabaseClient;

  constructor(config: SupabaseRepoConfig) {
    this.db =
      config.client ??
      createClient(config.url, config.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
  }

  // --- low-level helpers ---

  private fail(op: string, error: { message?: string; code?: string } | null): never {
    throw new Error(`Supabase ${op} failed${error?.code ? ` (${error.code})` : ''}: ${error?.message ?? 'unknown error'}`);
  }

  private async rpc(fn: string, args: Row = {}): Promise<unknown> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) this.fail(fn, error);
    return data;
  }

  /** Every row matching `filters` (column -> value), paged past PostgREST's row limit. */
  private async select(table: string, filters: Row = {}, orderBy?: string | string[]): Promise<Row[]> {
    const rows: Row[] = [];
    for (let from = 0; ; from += PAGE) {
      let q = this.db.from(table).select('*');
      for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);
      for (const col of orderBy === undefined ? [] : Array.isArray(orderBy) ? orderBy : [orderBy]) {
        q = q.order(col, { ascending: true, nullsFirst: false });
      }
      const { data, error } = await q.range(from, from + PAGE - 1);
      if (error) this.fail(`select ${table}`, error);
      rows.push(...(data ?? []));
      if ((data ?? []).length < PAGE) return rows;
    }
  }

  private async one(table: string, filters: Row): Promise<Row | undefined> {
    let q = this.db.from(table).select('*');
    for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);
    const { data, error } = await q.maybeSingle();
    if (error) this.fail(`select ${table}`, error);
    return data ?? undefined;
  }

  private async upsert(table: string, row: Row, onConflict: string): Promise<void> {
    const { error } = await this.db.from(table).upsert(row, { onConflict });
    if (error) this.fail(`upsert ${table}`, error);
  }

  private async remove(table: string, filters: Row): Promise<void> {
    let q = this.db.from(table).delete();
    for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);
    const { error } = await q;
    if (error) this.fail(`delete ${table}`, error);
  }

  /** Readiness: one tiny query proves the project, key and schema work. */
  async ping(): Promise<void> {
    const { error } = await this.db.from('meal_service').select('service_id').limit(1);
    if (error) this.fail('ping', error);
  }

  // --- menus ---
  async upsertMenu(menu: MenuBundle): Promise<void> {
    try {
      await this.rpc('upsert_menu', { p_menu: menu });
    } catch (error) {
      // A version older than the stored one is a client conflict, not a server fault.
      if (error instanceof Error && /is older than the stored version/.test(error.message)) {
        throw menuVersionConflict({ serviceId: menu.service.serviceId, menuVersion: menu.service.menuVersion });
      }
      throw error;
    }
  }
  private toMenuItem(row: Row): MenuItem {
    const { dishId: _dish, position: _position, ...item } = fromRow(row);
    return item as MenuItem;
  }
  private async bundles(services: Row[]): Promise<MenuBundle[]> {
    const out: MenuBundle[] = [];
    for (const service of services) {
      // Upload order, as the menu was entered (SpacetimeDB returned insertion order).
      const items = await this.select('menu_item', { menu_id: service.menu_id }, ['position', 'item_id']);
      out.push({ service: fromRow(service) as MealService, items: items.map((i) => this.toMenuItem(i)) });
    }
    return out;
  }
  async getMenuByService(serviceId: string): Promise<MenuBundle | undefined> {
    const row = await this.one('meal_service', { service_id: serviceId });
    return row ? (await this.bundles([row]))[0] : undefined;
  }
  async findMenus(hallId: string, serviceDate: string, mealLabel?: string): Promise<MenuBundle[]> {
    const filters: Row = { hall_id: hallId, service_date: serviceDate };
    if (mealLabel !== undefined) filters.meal_label = mealLabel;
    return this.bundles(await this.select('meal_service', filters, 'service_id'));
  }
  async getMenuItem(itemId: string): Promise<MenuItem | undefined> {
    const row = await this.one('menu_item', { item_id: itemId });
    if (row) return this.toMenuItem(row);
    // Items a later revision dropped are archived in menu_item_revision (newest version wins).
    const revisions = await this.select('menu_item_revision', { item_id: itemId });
    const latest = revisions.sort((a, b) => Number(b.menu_version) - Number(a.menu_version))[0];
    if (!latest) return undefined;
    const { itemId: id, menuId, displayName, category, description } = fromRow(latest);
    return dropNulls({ itemId: id, menuId, displayName, category, description }) as MenuItem;
  }
  async listServices(hallId?: string): Promise<MealService[]> {
    const rows = await this.select('meal_service', hallId === undefined ? {} : { hall_id: hallId }, 'service_id');
    return rows.map((r) => fromRow(r) as MealService);
  }

  // --- portions served ---
  async replacePortionsServed(serviceId: string, menuVersion: number, portions: PortionsServed[]): Promise<void> {
    try {
      await this.rpc('replace_portions_served', { p_snapshot: { serviceId, menuVersion, portions } });
    } catch (error) {
      if (error instanceof Error && error.message.includes('The menu changed')) {
        throw conflict('STALE_PORTIONS_MENU', 'The menu changed; reload before saving portions.');
      }
      throw error;
    }
  }
  async listPortionsServed(serviceId: string, menuVersion: number): Promise<PortionsServed[]> {
    if (!Number.isInteger(menuVersion) || menuVersion < 1) throw new Error('Invalid menu version.');
    const rows = await this.select('portions_served', { service_id: serviceId, menu_version: menuVersion }, 'record_id');
    return rows.map((r) => fromRow(r) as PortionsServed);
  }

  // --- reference portions ---
  async upsertReferencePortion(ref: ReferencePortion): Promise<void> {
    // §7.1: the denominator must be finite and > 0 (same message as the former reducer;
    // the table's CHECK constraint enforces it too).
    if (typeof ref.expectedAreaPx !== 'number' || !Number.isFinite(ref.expectedAreaPx) || ref.expectedAreaPx <= 0) {
      throw new Error('reference.expectedAreaPx must be a finite number > 0');
    }
    await this.upsert('reference_portion', toRow(ref as unknown as Row), 'baseline_id');
  }
  async getReferencePortion(baselineId: string): Promise<ReferencePortion | undefined> {
    const row = await this.one('reference_portion', { baseline_id: baselineId });
    return row ? (fromRow(row) as ReferencePortion) : undefined;
  }
  async listReferencePortions(itemId?: string): Promise<ReferencePortion[]> {
    const rows = await this.select('reference_portion', itemId === undefined ? {} : { item_id: itemId }, 'baseline_id');
    return rows.map((r) => fromRow(r) as ReferencePortion);
  }
  async deleteReferencePortion(baselineId: string): Promise<boolean> {
    const existed = (await this.getReferencePortion(baselineId)) !== undefined;
    if (existed) await this.remove('reference_portion', { baseline_id: baselineId });
    return existed;
  }

  // --- image objects ---
  private toImageObject(row: Row): ImageObject {
    const { associationKind, associationId, ...rest } = fromRow(row);
    return { ...rest, association: { kind: associationKind, id: associationId } } as ImageObject;
  }
  async upsertImageObject(obj: ImageObject): Promise<void> {
    const { association, ...rest } = obj;
    await this.upsert(
      'image_object',
      toRow({ ...rest, associationKind: association.kind, associationId: association.id }),
      'object_id',
    );
  }
  async getImageObject(objectId: string): Promise<ImageObject | undefined> {
    const row = await this.one('image_object', { object_id: objectId });
    return row ? this.toImageObject(row) : undefined;
  }
  async listImageObjects(state?: ImageObject['state']): Promise<ImageObject[]> {
    const rows = await this.select('image_object', state === undefined ? {} : { state }, 'object_id');
    return rows.map((r) => this.toImageObject(r));
  }
  async deleteImageObject(objectId: string): Promise<boolean> {
    const existed = (await this.getImageObject(objectId)) !== undefined;
    if (existed) await this.remove('image_object', { object_id: objectId });
    return existed;
  }
  async findImageObjectsByAssociation(kind: ImageObject['association']['kind'], id: string): Promise<ImageObject[]> {
    const rows = await this.select('image_object', { association_kind: kind, association_id: id }, 'object_id');
    return rows.map((r) => this.toImageObject(r));
  }

  // --- plate scale ---
  async recordPlateScale(record: PlateScaleRecord): Promise<void> {
    await this.upsert('plate_scale_estimate', toRow(record as unknown as Row), 'attempt_id');
  }
  async listPlateScales(eventIds: string[]): Promise<PlateScaleRecord[]> {
    const out: PlateScaleRecord[] = [];
    for (let i = 0; i < eventIds.length; i += 200) {
      const { data, error } = await this.db.from('plate_scale_estimate').select('*').in('event_id', eventIds.slice(i, i + 200));
      if (error) this.fail('select plate_scale_estimate', error);
      for (const row of data ?? []) out.push({ ...(fromRow(row) as unknown as PlateScaleRecord), createdAt: new Date(String(row.created_at)).toISOString() });
    }
    return out;
  }

  // --- scans ---
  async upsertScanInfo(scan: ScanInfo): Promise<void> {
    await this.upsert('scan_info', toRow({ ...scan, demo: scan.demo === true } as unknown as Row), 'event_id');
  }
  async getScanInfo(eventId: string): Promise<ScanInfo | undefined> {
    const row = await this.one('scan_info', { event_id: eventId });
    return row ? (fromRow(row) as ScanInfo) : undefined;
  }

  // --- sample data ---
  async recordDemoMarkers(markers: DemoMarker[]): Promise<void> {
    for (let i = 0; i < markers.length; i += 500) {
      const rows = markers.slice(i, i + 500).map((m) => ({ marker_id: `${m.tableName}:${m.rowKey}`, table_name: m.tableName, row_key: m.rowKey }));
      const { error } = await this.db.from('demo_marker').upsert(rows, { onConflict: 'marker_id', ignoreDuplicates: true });
      if (error) this.fail('upsert demo_marker', error);
    }
  }
  async clearDemoData(): Promise<number> {
    return Number(await this.rpc('clear_demo_data'));
  }

  // --- capture events ---
  private toCaptureEvent(row: Row): CaptureEvent {
    const { widthPx, heightPx, coordinateSpace, plateShape, plateDiameterPx, ...rest } = fromRow(row);
    return {
      ...rest,
      qualityFlags: rest.qualityFlags ?? [],
      geometry: dropNulls({ widthPx, heightPx, coordinateSpace, plateShape, plateDiameterPx }),
    } as CaptureEvent;
  }
  async upsertCaptureEvent(event: CaptureEvent): Promise<void> {
    const { geometry, ...rest } = event;
    // Retries update the same event; they never create another dish.
    await this.upsert(
      'capture_event',
      toRow({
        ...rest,
        qualityFlags: event.qualityFlags ?? [],
        widthPx: geometry.widthPx,
        heightPx: geometry.heightPx,
        coordinateSpace: geometry.coordinateSpace,
        plateShape: geometry.plateShape,
        plateDiameterPx: geometry.plateDiameterPx,
      }),
      'event_id',
    );
  }
  async getCaptureEvent(eventId: string): Promise<CaptureEvent | undefined> {
    const row = await this.one('capture_event', { event_id: eventId });
    return row ? this.toCaptureEvent(row) : undefined;
  }
  async listCaptureEvents(filter?: CaptureEventFilter): Promise<CaptureEvent[]> {
    const filters: Row = {};
    if (filter?.hallId !== undefined) filters.hall_id = filter.hallId;
    if (filter?.serviceId !== undefined) filters.service_id = filter.serviceId;
    const [rows, hidden, views] = await Promise.all([
      this.select('capture_event', filters, 'event_id'),
      filter?.includeHidden ? Promise.resolve(new Set<string>()) : this.listHiddenCaptureIds(),
      filter?.includeHidden ? Promise.resolve([] as Row[]) : this.select('dashboard_view'),
    ]);
    const cutoffs = new Map(views.map((v) => [String(v.hall_id), v.cleared_at ? new Date(v.cleared_at).toISOString() : null]));
    return rows
      .map((r) => this.toCaptureEvent(r))
      .filter((e) => !hidden.has(e.eventId) && !isBeforeCutoff(e, cutoffs.get(e.hallId)));
  }

  // --- dashboard cutoff ---
  async getDashboardView(hallId: string) {
    const row = await this.one('dashboard_view', { hall_id: hallId });
    if (!row) return undefined;
    const v = fromRow(row);
    return { hallId, clearedAt: typeof v.clearedAt === 'string' ? v.clearedAt : null, updatedAt: String(v.updatedAt) };
  }
  async setDashboardView(hallId: string, clearedAt: string | null, updatedAt: string): Promise<void> {
    await this.upsert('dashboard_view', { hall_id: hallId, cleared_at: clearedAt || null, updated_at: updatedAt }, 'hall_id');
  }

  // --- admin curation ---
  async listHiddenCaptureIds(): Promise<Set<string>> {
    const rows = await this.select('capture_visibility', { hidden: true });
    return new Set(rows.map((r) => String(r.event_id)));
  }
  async setCaptureVisibility(eventIds: string[], hidden: boolean, updatedAt: string): Promise<void> {
    if (eventIds.length === 0) return;
    await this.rpc('set_capture_visibility', { p_event_ids: eventIds, p_hidden: hidden, p_updated_at: updatedAt });
  }

  // --- analysis attempts + measurements ---
  async addAnalysisAttempt(attempt: AnalysisAttempt): Promise<void> {
    await this.recordAnalysis(attempt, []);
  }
  /** Attempt + measurements + segmentation + overlay in one Postgres function call (one transaction). */
  async recordAnalysis(attempt: AnalysisAttempt, measurements: FoodMeasurement[]): Promise<void> {
    await this.rpc('record_analysis', { p_attempt: attempt, p_measurements: measurements });
  }
  /** Rebuild contract SegmentationResults (capture_count + segmentation_region) for an event. */
  private async segmentationsFor(eventId: string): Promise<Map<string, SegmentationResult>> {
    const [counts, regions] = await Promise.all([
      this.select('capture_count', { event_id: eventId }),
      this.select('segmentation_region', { event_id: eventId }),
    ]);
    const out = new Map<string, SegmentationResult>();
    for (const c of counts) {
      const { attemptId, eventId: _e, ...rest } = fromRow(c);
      out.set(attemptId, { ...rest, regions: [] } as unknown as SegmentationResult);
    }
    const mapped = regions.map(fromRow);
    mapped.sort((a, b) => String(a.regionId).localeCompare(String(b.regionId), undefined, { numeric: true }));
    for (const r of mapped) {
      const seg = out.get(r.attemptId);
      if (!seg) continue;
      const { geminiBox, pixelBox, boxConvention, itemId, ...rest } = r;
      seg.regions.push({
        ...rest,
        itemId: itemId ?? null,
        box: { gemini: geminiBox, pixelXyxy: pixelBox, convention: boxConvention },
      } as ClassificationRegion);
    }
    return out;
  }
  /** Calibration + overlay reference per attempt (attempt_calibration). */
  private async calibrationsFor(eventId: string): Promise<Map<string, Pick<AnalysisAttempt, 'calibration' | 'overlayObjectId'>>> {
    const rows = (await this.select('attempt_calibration', { event_id: eventId })).map(fromRow);
    return new Map(
      rows.map((r) => [
        r.attemptId as string,
        dropNulls({ calibration: r.calibration as PlateCalibration | undefined, overlayObjectId: r.overlayObjectId as string | undefined }),
      ]),
    );
  }
  async listAnalysisAttempts(eventId: string): Promise<AnalysisAttempt[]> {
    const rows = await this.select('analysis_attempt', { event_id: eventId });
    const [segmentations, calibrations] = await Promise.all([this.segmentationsFor(eventId), this.calibrationsFor(eventId)]);
    return rows
      .map((row) => {
        const r = fromRow(row);
        const attempt: Row = {
          ...r,
          baselineVersions: r.baselineVersions ?? {},
          qualityFlags: r.qualityFlags ?? [],
          ...calibrations.get(r.attemptId),
        };
        const segmentation = segmentations.get(r.attemptId);
        if (segmentation) attempt.segmentation = segmentation;
        return attemptFromStored(attempt as AnalysisAttempt);
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async addMeasurements(_measurements: FoodMeasurement[]): Promise<void> {
    // Measurements are only ever written with their attempt (recordAnalysis),
    // so both commit in one transaction.
    throw new Error('SupabaseRepository: write measurements via recordAnalysis(attempt, measurements)');
  }
  /**
   * Mask measurements get their regionIds back from segmentation_region:
   * an item's count is the union of its successfully segmented regions, and
   * the unclassified bucket's regions are the unknown-food ones.
   */
  private async withRegionIds(rows: Row[], regionFilter: Row): Promise<FoodMeasurement[]> {
    const masked = rows.some((r) => r.method === 'mask_pixel_count');
    const regions = masked ? (await this.select('segmentation_region', regionFilter)).map(fromRow) : [];
    regions.sort((a, b) => String(a.regionId).localeCompare(String(b.regionId), undefined, { numeric: true }));
    return rows.map((row) => {
      const r = fromRow(row);
      const m = { ...r, itemId: r.itemId ?? null, qualityFlags: r.qualityFlags ?? [] } as FoodMeasurement;
      if (m.method === 'mask_pixel_count') {
        m.regionIds = regions
          .filter((g) => g.attemptId === m.attemptId && g.segmentationStatus === 'succeeded' && (g.itemId ?? null) === m.itemId)
          .map((g) => g.regionId as string);
      }
      return m;
    });
  }
  async listMeasurementsByAttempt(attemptId: string): Promise<FoodMeasurement[]> {
    const rows = await this.select('food_measurement', { attempt_id: attemptId }, 'measurement_id');
    return this.withPhysical(await this.withRegionIds(rows, { attempt_id: attemptId }));
  }
  async listMeasurementsByEvent(eventId: string): Promise<FoodMeasurement[]> {
    const rows = await this.select('food_measurement', { event_id: eventId }, 'measurement_id');
    return this.withPhysical(await this.withRegionIds(rows, { event_id: eventId }));
  }

  /** Succeeded calibrations are immutable, so they are cached for physical recomputation. */
  private readonly succeededCalibrations = new Map<string, CameraCalibration>();

  /** IT_4: physical area only from the snapshotted calibration (areaCm2 = pixels × k). */
  private async withPhysical(measurements: FoodMeasurement[]): Promise<FoodMeasurement[]> {
    const ids = new Set<string>();
    for (const m of measurements) {
      const id = (m.physical as { calibrationId?: unknown } | undefined)?.calibrationId;
      if (typeof id === 'string') ids.add(id);
    }
    const cals = new Map<string, CameraCalibration | undefined>();
    for (const id of ids) {
      let cal = this.succeededCalibrations.get(id);
      if (!cal) {
        cal = await this.getCameraCalibration(id);
        if (cal?.status === 'succeeded') this.succeededCalibrations.set(id, cal);
      }
      cals.set(id, cal);
    }
    return measurements.map((m) => {
      const id = (m.physical as { calibrationId?: unknown } | undefined)?.calibrationId;
      return measurementFromStored(m, typeof id === 'string' ? cals.get(id) : undefined);
    });
  }

  // --- attendance (SIMULATED, per service; table simulated_attendance) ---
  async upsertAttendance(att: Attendance): Promise<void> {
    if (att.source !== 'simulated') throw new Error("attendance.source must be 'simulated' in the prototype");
    await this.upsert('simulated_attendance', toRow(att as unknown as Row), 'service_id');
  }
  async getAttendance(serviceId: string): Promise<Attendance | undefined> {
    const row = await this.one('simulated_attendance', { service_id: serviceId });
    return row ? (fromRow(row) as Attendance) : undefined;
  }

  // --- IT_4: camera calibrations + measurement settings ---
  private toCalibration(row: Row): CameraCalibration {
    return calibrationFromStored({ ...fromRow(row) } as CameraCalibration);
  }
  async upsertCameraCalibration(calibration: CameraCalibration): Promise<void> {
    try {
      await this.rpc('upsert_camera_calibration', { p_calibration: calibration });
    } catch (error) {
      if (error instanceof Error && /cannot change/.test(error.message)) {
        throw conflict('CALIBRATION_IMMUTABLE', 'This calibration is finished and cannot change.', { calibrationId: calibration.calibrationId });
      }
      throw error;
    }
  }
  async getCameraCalibration(calibrationId: string): Promise<CameraCalibration | undefined> {
    const row = await this.one('camera_calibration', { calibration_id: calibrationId });
    return row ? this.toCalibration(row) : undefined;
  }
  async listCameraCalibrations(hallId?: string): Promise<CameraCalibration[]> {
    const rows = await this.select('camera_calibration', hallId === undefined ? {} : { hall_id: hallId }, 'calibration_id');
    return rows.map((r) => this.toCalibration(r));
  }
  async upsertMeasurementSettings(settings: MeasurementSettings): Promise<void> {
    try {
      await this.rpc('upsert_measurement_settings', {
        p_settings: { hallId: settings.hallId, activeCalibrationId: settings.activeCalibrationId, updatedAt: settings.updatedAt },
      });
    } catch (error) {
      if (error instanceof Error && /is not a succeeded calibration/.test(error.message)) {
        throw badRequest('INVALID_CALIBRATION', 'Only a successful calibration of this hall can be activated.', {
          calibrationId: settings.activeCalibrationId,
        });
      }
      throw error;
    }
  }
  async getMeasurementSettings(hallId: string): Promise<MeasurementSettings | undefined> {
    const row = await this.one('measurement_settings', { hall_id: hallId });
    return row ? settingsFromStored(fromRow(row)) : undefined;
  }

  // --- insights ---
  async upsertInsight(insight: Insight): Promise<void> {
    await this.upsert('insight', toRow({ ...insight, metrics: insight.metrics ?? {} } as unknown as Row), 'insight_id');
  }
  async listInsights(hallId?: string): Promise<Insight[]> {
    const rows = await this.select('insight', hallId === undefined ? {} : { hall_id: hallId }, 'insight_id');
    return rows.map((r) => ({ ...fromRow(r), metrics: r.metrics ?? {} }) as Insight);
  }
}
