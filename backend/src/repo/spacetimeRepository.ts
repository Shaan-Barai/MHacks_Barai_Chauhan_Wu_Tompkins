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
} from '../types.js';
import type { Repository } from './repository.js';

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
    await this.call('upsert_menu', { menuJson: JSON.stringify(menu) });
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
  async listServices(hallId?: string): Promise<MealService[]> {
    const q = hallId === undefined ? 'SELECT * FROM meal_service' : `SELECT * FROM meal_service WHERE hall_id = ${quote(hallId)}`;
    return clean((await this.sql(q)) as MealService[]);
  }

  // --- reference portions ---
  async replacePortionsServed(serviceId: string, menuVersion: number, portions: PortionsServed[]): Promise<void> {
    await this.call('replace_portions_served', { snapshotJson: JSON.stringify({ serviceId, menuVersion, portions }) });
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
  async listAnalysisAttempts(eventId: string): Promise<AnalysisAttempt[]> {
    const rows = await this.sql(`SELECT * FROM analysis_attempt WHERE event_id = ${quote(eventId)}`);
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
        } as AnalysisAttempt);
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async addMeasurements(_measurements: FoodMeasurement[]): Promise<void> {
    // Measurements are only ever written with their attempt (recordAnalysis),
    // because SpacetimeDB can commit both in one transaction.
    throw new Error('SpacetimeRepository: write measurements via recordAnalysis(attempt, measurements)');
  }
  private toMeasurement(row: Row): FoodMeasurement {
    const { maskCountJson, ...rest } = row;
    return clean({ ...rest, itemId: row.itemId ?? null, ...(maskCountJson ? { maskCount: JSON.parse(maskCountJson) } : {}) } as FoodMeasurement);
  }
  async listMeasurementsByAttempt(attemptId: string): Promise<FoodMeasurement[]> {
    const rows = await this.sql(`SELECT * FROM food_measurement WHERE attempt_id = ${quote(attemptId)}`);
    return rows.map((r) => this.toMeasurement(r));
  }
  async listMeasurementsByEvent(eventId: string): Promise<FoodMeasurement[]> {
    const rows = await this.sql(`SELECT * FROM food_measurement WHERE event_id = ${quote(eventId)}`);
    return rows.map((r) => this.toMeasurement(r));
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
