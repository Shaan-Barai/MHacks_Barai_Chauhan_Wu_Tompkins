/**
 * SpacetimeDB-backed Repository (swap plan in repository.ts / db/README.md).
 *
 * Mutations call the module's reducers (db/spacetimedb/src/reducers.ts) over
 * the SpacetimeDB HTTP API, one reducer per method; reads run SQL against the
 * tables. The backend authenticates as the identity that published the
 * module, so it can read the private tables (image_object, analysis_attempt).
 *
 * Only references and metadata cross this boundary — image bytes stay in
 * object storage (AGENTS.md §2).
 */

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
  ScanInfo,
} from '../types.js';
import type { DemoMarker, Repository } from './repository.js';
import { conflict, menuVersionConflict } from '../errors.js';

export interface SpacetimeConfig {
  /** e.g. http://127.0.0.1:3000 */
  uri: string;
  /** Database name, e.g. "scrap". */
  module: string;
  /** Bearer token of the module owner identity. */
  token?: string;
}

type AlgebraicType = Record<string, any>;
type Row = Record<string, any>;

interface SqlResult {
  schema: { elements: { name: { some?: string }; algebraic_type: AlgebraicType }[] };
  rows: unknown[][];
}

/** snake_case SQL column names back to the camelCase contract field names. */
function camel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Decode a SATS-JSON value: products arrive as positional arrays, sums as
 * [tag, value]. Options become value-or-undefined.
 */
function decode(value: unknown, type: AlgebraicType): unknown {
  if (type.Product) {
    const out: Row = {};
    (type.Product.elements as SqlResult['schema']['elements']).forEach((el, i) => {
      out[camel(el.name.some ?? String(i))] = decode((value as unknown[])[i], el.algebraic_type);
    });
    return out;
  }
  if (type.Sum) {
    const [tag, inner] = value as [number, unknown];
    const variant = type.Sum.variants[tag];
    const name = variant?.name?.some;
    if (name === 'none') return undefined;
    return decode(inner, variant.algebraic_type);
  }
  if (type.Array) return (value as unknown[]).map((v) => decode(v, type.Array));
  if (type.U64 || type.I64) return Number(value);
  return value;
}

/** Drop undefined fields so records match the contract's optional-field shape. */
function clean<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export class SpacetimeRepository implements Repository {
  private readonly base: string;

  constructor(private readonly config: SpacetimeConfig) {
    this.base = `${config.uri.replace(/\/$/, '')}/v1/database/${encodeURIComponent(config.module)}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.config.token) h.Authorization = `Bearer ${this.config.token}`;
    return h;
  }

  private async call(reducer: string, args: Record<string, string>): Promise<void> {
    const res = await fetch(`${this.base}/call/${reducer}`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      throw new Error(`SpacetimeDB reducer ${reducer} failed (${res.status}): ${await res.text()}`);
    }
  }

  private async sql(query: string): Promise<Row[]> {
    const res = await fetch(`${this.base}/sql`, { method: 'POST', headers: this.headers(), body: query });
    if (!res.ok) throw new Error(`SpacetimeDB query failed (${res.status}): ${await res.text()}`);
    const results = (await res.json()) as SqlResult[];
    const result = results[0];
    if (!result) return [];
    const rowType = { Product: { elements: result.schema.elements } };
    return result.rows.map((r) => decode(r, rowType) as Row);
  }

  // --- menus ---
  async upsertMenu(menu: MenuBundle): Promise<void> {
    try {
      await this.call('upsert_menu', { menuJson: JSON.stringify(menu) });
    } catch (error) {
      // Reducer guard: a version older than the stored one is a client conflict, not a server fault.
      if (error instanceof Error && /is older than the stored version/.test(error.message)) {
        throw menuVersionConflict({ serviceId: menu.service.serviceId, menuVersion: menu.service.menuVersion });
      }
      throw error;
    }
  }
  private async bundles(services: Row[]): Promise<MenuBundle[]> {
    const out: MenuBundle[] = [];
    for (const service of services) {
      const items = await this.sql(`SELECT * FROM menu_item WHERE menu_id = ${quote(service.menuId)}`);
      out.push(clean({ service: service as MealService, items: items as MenuItem[] }));
    }
    return out;
  }
  async getMenuByService(serviceId: string): Promise<MenuBundle | undefined> {
    const rows = await this.sql(`SELECT * FROM meal_service WHERE service_id = ${quote(serviceId)}`);
    return (await this.bundles(rows))[0];
  }
  async findMenus(hallId: string, serviceDate: string, mealLabel?: string): Promise<MenuBundle[]> {
    let q = `SELECT * FROM meal_service WHERE hall_id = ${quote(hallId)} AND service_date = ${quote(serviceDate)}`;
    if (mealLabel !== undefined) q += ` AND meal_label = ${quote(mealLabel)}`;
    return this.bundles(await this.sql(q));
  }
  async getMenuItem(itemId: string): Promise<MenuItem | undefined> {
    const rows = await this.sql(`SELECT * FROM menu_item WHERE item_id = ${quote(itemId)}`);
    if (rows[0]) return clean(rows[0] as MenuItem);
    // Items a later revision dropped are archived in menu_item_revision (newest version wins).
    let revisions: Row[] = [];
    try {
      revisions = await this.sql(`SELECT * FROM menu_item_revision WHERE item_id = ${quote(itemId)}`);
    } catch {
      return undefined; // older schema without the archive table
    }
    const latest = revisions.sort((a, b) => Number(b.menuVersion) - Number(a.menuVersion))[0];
    if (!latest) return undefined;
    const { itemId: id, menuId, displayName, category, description } = latest;
    return clean({ itemId: id, menuId, displayName, category, description } as MenuItem);
  }
  async listServices(hallId?: string): Promise<MealService[]> {
    const q = hallId === undefined ? 'SELECT * FROM meal_service' : `SELECT * FROM meal_service WHERE hall_id = ${quote(hallId)}`;
    return clean((await this.sql(q)) as MealService[]);
  }

  // --- reference portions ---
  async replacePortionsServed(serviceId: string, menuVersion: number, portions: PortionsServed[]): Promise<void> {
    try {
      await this.call('replace_portions_served', { snapshotJson: JSON.stringify({ serviceId, menuVersion, portions }) });
    } catch (error) {
      if (error instanceof Error && error.message.includes('The menu changed')) throw conflict('STALE_PORTIONS_MENU', 'The menu changed; reload before saving portions.');
      throw error;
    }
  }
  async listPortionsServed(serviceId: string, menuVersion: number): Promise<PortionsServed[]> {
    if (!Number.isInteger(menuVersion) || menuVersion < 1) throw new Error('Invalid menu version.');
    return clean(await this.sql(`SELECT * FROM portions_served WHERE service_id = ${quote(serviceId)} AND menu_version = ${menuVersion}`) as PortionsServed[]);
  }

  // --- reference portions ---
  async upsertReferencePortion(ref: ReferencePortion): Promise<void> {
    await this.call('upsert_reference_portion', { refJson: JSON.stringify(ref) });
  }
  async getReferencePortion(baselineId: string): Promise<ReferencePortion | undefined> {
    const rows = await this.sql(`SELECT * FROM reference_portion WHERE baseline_id = ${quote(baselineId)}`);
    return clean(rows[0] as ReferencePortion | undefined);
  }
  async listReferencePortions(itemId?: string): Promise<ReferencePortion[]> {
    const q =
      itemId === undefined
        ? 'SELECT * FROM reference_portion'
        : `SELECT * FROM reference_portion WHERE item_id = ${quote(itemId)}`;
    return clean((await this.sql(q)) as ReferencePortion[]);
  }
  async deleteReferencePortion(baselineId: string): Promise<boolean> {
    const existed = (await this.getReferencePortion(baselineId)) !== undefined;
    if (existed) await this.call('delete_reference_portion', { baselineId });
    return existed;
  }

  // --- image objects ---
  private toImageObject(row: Row): ImageObject {
    const { associationKind, associationId, ...rest } = row;
    return clean({ ...rest, association: { kind: associationKind, id: associationId } } as ImageObject);
  }
  async upsertImageObject(obj: ImageObject): Promise<void> {
    await this.call('upsert_image_object', { objectJson: JSON.stringify(obj) });
  }
  async getImageObject(objectId: string): Promise<ImageObject | undefined> {
    const rows = await this.sql(`SELECT * FROM image_object WHERE object_id = ${quote(objectId)}`);
    return rows[0] ? this.toImageObject(rows[0]) : undefined;
  }
  async listImageObjects(state?: ImageObject['state']): Promise<ImageObject[]> {
    const q = state === undefined ? 'SELECT * FROM image_object' : `SELECT * FROM image_object WHERE state = ${quote(state)}`;
    return (await this.sql(q)).map((r) => this.toImageObject(r));
  }
  async deleteImageObject(objectId: string): Promise<boolean> {
    const existed = (await this.getImageObject(objectId)) !== undefined;
    if (existed) await this.call('delete_image_object', { objectId });
    return existed;
  }

  async findImageObjectsByAssociation(kind: ImageObject['association']['kind'], id: string): Promise<ImageObject[]> {
    const rows = await this.sql(
      `SELECT * FROM image_object WHERE association_kind = ${quote(kind)} AND association_id = ${quote(id)}`,
    );
    return rows.map((r) => this.toImageObject(r));
  }

  // --- scans ---
  async upsertScanInfo(scan: ScanInfo): Promise<void> {
    await this.call('upsert_scan_info', { scanJson: JSON.stringify(scan) });
  }
  async getScanInfo(eventId: string): Promise<ScanInfo | undefined> {
    const [row] = await this.sql(`SELECT * FROM scan_info WHERE event_id = ${quote(eventId)}`);
    return row ? clean(row as ScanInfo) : undefined;
  }

  // --- sample data ---
  async recordDemoMarkers(markers: DemoMarker[]): Promise<void> {
    // Chunked so one reducer argument stays small.
    for (let i = 0; i < markers.length; i += 500) {
      await this.call('record_demo_markers', { markersJson: JSON.stringify(markers.slice(i, i + 500)) });
    }
  }
  async clearDemoData(): Promise<number> {
    const marked = (await this.sql('SELECT * FROM demo_marker')).length;
    await this.call('clear_demo_data', {});
    return marked;
  }

  // --- capture events ---
  async upsertCaptureEvent(event: CaptureEvent): Promise<void> {
    await this.call('upsert_capture_event', { eventJson: JSON.stringify(event) });
  }
  async getCaptureEvent(eventId: string): Promise<CaptureEvent | undefined> {
    const rows = await this.sql(`SELECT * FROM capture_event WHERE event_id = ${quote(eventId)}`);
    return clean(rows[0] as CaptureEvent | undefined);
  }
  async listCaptureEvents(filter?: { hallId?: string; serviceId?: string }): Promise<CaptureEvent[]> {
    const where: string[] = [];
    if (filter?.hallId !== undefined) where.push(`hall_id = ${quote(filter.hallId)}`);
    if (filter?.serviceId !== undefined) where.push(`service_id = ${quote(filter.serviceId)}`);
    const q = `SELECT * FROM capture_event${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
    return clean((await this.sql(q)) as CaptureEvent[]);
  }

  // --- analysis attempts + measurements ---
  async addAnalysisAttempt(attempt: AnalysisAttempt): Promise<void> {
    await this.recordAnalysis(attempt, []);
  }
  /** Attempt + measurements in one reducer call, so they commit atomically. */
  async recordAnalysis(attempt: AnalysisAttempt, measurements: FoodMeasurement[]): Promise<void> {
    await this.call('record_analysis', {
      attemptJson: JSON.stringify(attempt),
      measurementsJson: JSON.stringify(measurements),
    });
  }
  /** Rebuild contract SegmentationResults (capture_count + segmentation_region) for an event. */
  private async segmentationsFor(eventId: string): Promise<Map<string, SegmentationResult>> {
    const [counts, regions] = await Promise.all([
      this.sql(`SELECT * FROM capture_count WHERE event_id = ${quote(eventId)}`),
      this.sql(`SELECT * FROM segmentation_region WHERE event_id = ${quote(eventId)}`),
    ]);
    const out = new Map<string, SegmentationResult>();
    for (const c of counts) {
      const { attemptId, eventId: _e, ...rest } = c;
      out.set(attemptId, clean({ ...rest, regions: [] } as unknown as SegmentationResult));
    }
    regions.sort((a, b) => String(a.regionId).localeCompare(String(b.regionId), undefined, { numeric: true }));
    for (const r of regions) {
      const seg = out.get(r.attemptId);
      if (!seg) continue;
      const { geminiBox, pixelBox, boxConvention, error, itemId, ...rest } = r;
      seg.regions.push(
        clean({
          ...rest,
          itemId: itemId ?? null,
          box: { gemini: geminiBox, pixelXyxy: pixelBox, convention: boxConvention },
          error: error
            ? { code: error.code, message: error.message, details: error.detailsJson ? JSON.parse(error.detailsJson) : undefined, retryable: error.retryable }
            : undefined,
        } as ClassificationRegion),
      );
    }
    return out;
  }

  /** Calibration + overlay reference per attempt (attempt_calibration, BIG-PLAN D2/D7). */
  private async calibrationsFor(eventId: string): Promise<Map<string, Pick<AnalysisAttempt, 'calibration' | 'overlayObjectId'>>> {
    const rows = await this.sql(`SELECT * FROM attempt_calibration WHERE event_id = ${quote(eventId)}`);
    return new Map(
      rows.map((r) => [
        r.attemptId as string,
        { calibration: r.calibration as PlateCalibration | undefined, overlayObjectId: r.overlayObjectId as string | undefined },
      ]),
    );
  }

  async listAnalysisAttempts(eventId: string): Promise<AnalysisAttempt[]> {
    const rows = await this.sql(`SELECT * FROM analysis_attempt WHERE event_id = ${quote(eventId)}`);
    const [segmentations, calibrations] = await Promise.all([this.segmentationsFor(eventId), this.calibrationsFor(eventId)]);
    return rows
      .map((r) => {
        const { baselineVersions, error, ...rest } = r;
        return clean({
          ...rest,
          baselineVersions: Object.fromEntries(
            (baselineVersions as { itemId: string; baselineVersion: number }[]).map((b) => [b.itemId, b.baselineVersion]),
          ),
          error: error
            ? {
                code: error.code,
                message: error.message,
                details: error.detailsJson ? JSON.parse(error.detailsJson) : undefined,
                retryable: error.retryable,
              }
            : undefined,
          segmentation: segmentations.get(r.attemptId),
          ...calibrations.get(r.attemptId),
        } as AnalysisAttempt);
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async addMeasurements(_measurements: FoodMeasurement[]): Promise<void> {
    // Measurements are only ever written with their attempt (recordAnalysis),
    // because SpacetimeDB can commit both in one transaction.
    throw new Error('SpacetimeRepository: write measurements via recordAnalysis(attempt, measurements)');
  }
  /**
   * Mask measurements get their regionIds back from segmentation_region:
   * an item's count is the union of its successfully segmented regions, and
   * the unclassified bucket's regions are the unknown-food ones.
   */
  private async withRegionIds(rows: Row[], regionQuery: string): Promise<FoodMeasurement[]> {
    const masked = rows.some((r) => r.method === 'mask_pixel_count');
    const regions = masked ? await this.sql(regionQuery) : [];
    regions.sort((a, b) => String(a.regionId).localeCompare(String(b.regionId), undefined, { numeric: true }));
    return rows.map((row) => {
      const { maskCountJson, ...rest } = row;
      const m = {
        ...rest,
        itemId: row.itemId ?? null,
        ...(maskCountJson ? { maskCount: JSON.parse(maskCountJson as string) } : {}),
      } as FoodMeasurement;
      if (m.method === 'mask_pixel_count') {
        m.regionIds = regions
          .filter((g) => g.attemptId === m.attemptId && g.segmentationStatus === 'succeeded' && (g.itemId ?? null) === m.itemId)
          .map((g) => g.regionId as string);
      }
      return clean(m);
    });
  }
  async listMeasurementsByAttempt(attemptId: string): Promise<FoodMeasurement[]> {
    const rows = await this.sql(`SELECT * FROM food_measurement WHERE attempt_id = ${quote(attemptId)}`);
    return this.withRegionIds(rows, `SELECT * FROM segmentation_region WHERE attempt_id = ${quote(attemptId)}`);
  }
  async listMeasurementsByEvent(eventId: string): Promise<FoodMeasurement[]> {
    const rows = await this.sql(`SELECT * FROM food_measurement WHERE event_id = ${quote(eventId)}`);
    return this.withRegionIds(rows, `SELECT * FROM segmentation_region WHERE event_id = ${quote(eventId)}`);
  }

  // --- attendance ---
  async upsertAttendance(att: Attendance): Promise<void> {
    await this.call('upsert_attendance', { attendanceJson: JSON.stringify(att) });
  }
  async getAttendance(serviceId: string): Promise<Attendance | undefined> {
    const rows = await this.sql(`SELECT * FROM attendance WHERE service_id = ${quote(serviceId)}`);
    return clean(rows[0] as Attendance | undefined);
  }

  // --- insights ---
  async upsertInsight(insight: Insight): Promise<void> {
    await this.call('upsert_insight', { insightJson: JSON.stringify(insight) });
  }
  async listInsights(hallId?: string): Promise<Insight[]> {
    const q = hallId === undefined ? 'SELECT * FROM insight' : `SELECT * FROM insight WHERE hall_id = ${quote(hallId)}`;
    return (await this.sql(q)).map((r) => {
      const { metricsJson, ...rest } = r;
      return clean({ ...rest, metrics: JSON.parse(metricsJson) } as Insight);
    });
  }
}
