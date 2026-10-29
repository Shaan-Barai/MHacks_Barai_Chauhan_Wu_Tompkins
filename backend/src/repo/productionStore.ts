/**
 * production_log persistence (forecasting): rows read from production-sheet
 * photos start UNCONFIRMED with per-field confidence and review flags; a
 * person edits and confirms them. Supabase-backed in production; an in-memory
 * store for tests and offline (JSON/SpacetimeDB) setups, where forecasting
 * tables do not exist.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { conflict, notFound } from '../errors.js';

export type ProductionStatus = 'unconfirmed' | 'confirmed' | 'rejected';
export type ProductionSource = 'manual' | 'sheet_photo' | 'csv' | 'demo';
export type MealLabel = 'breakfast' | 'lunch' | 'dinner';

export interface ProductionLogRow {
  productionLogId: number;
  hallId: string;
  serviceDate: string | null; // YYYY-MM-DD; null only while unconfirmed (unreadable date)
  mealLabel: MealLabel | null;
  dishId: string | null;
  dishNameRaw: string | null;
  station: string | null;
  preppedLb: number | null;
  preppedPortions: number | null;
  panLeftoverLb: number | null;
  /** UTC instant the dish ran out; null = did not run out (or not recorded). */
  ranOutAt: string | null;
  source: ProductionSource;
  status: ProductionStatus;
  fieldConfidence: Record<string, number> | null;
  reviewFlags: string[];
  sheetImageObjectId: string | null;
  sheetPhotoPath: string | null;
  extractionModel: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  isSimulated: boolean;
  createdAt: string;
  updatedAt: string;
}

export type NewProductionRow = Omit<ProductionLogRow, 'productionLogId' | 'createdAt' | 'updatedAt' | 'confirmedBy' | 'confirmedAt' | 'isSimulated'>;
export type ProductionPatch = Partial<
  Pick<ProductionLogRow, 'serviceDate' | 'mealLabel' | 'dishId' | 'station' | 'preppedLb' | 'preppedPortions' | 'panLeftoverLb' | 'ranOutAt' | 'fieldConfidence' | 'reviewFlags' | 'status' | 'confirmedBy' | 'confirmedAt'>
>;

export interface DishRecord {
  dishId: string;
  displayName: string;
  category: string | null;
  serviceStyle: string;
  isSimulated: boolean;
}

export interface ProductionFilter {
  hallId: string;
  status?: ProductionStatus;
  start?: string;
  end?: string;
  sheetImageObjectId?: string;
}

export interface ProductionStore {
  readonly kind: 'supabase' | 'memory';
  listDishes(): Promise<DishRecord[]>;
  /** Menu item names on a hall's date that are linked to a dish (extra names to match sheet lines against). */
  dishAliases(hallId: string, serviceDate?: string): Promise<{ dishId: string; name: string }[]>;
  hallTimezone(hallId: string): Promise<string>;
  insert(rows: NewProductionRow[]): Promise<ProductionLogRow[]>;
  list(filter: ProductionFilter): Promise<ProductionLogRow[]>;
  get(id: number): Promise<ProductionLogRow | undefined>;
  update(id: number, patch: ProductionPatch): Promise<ProductionLogRow>;
}

const DEFAULT_TZ = 'America/Detroit';

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const NUMERIC = new Set(['prepped_lb', 'pan_leftover_lb']);
const TIMESTAMPS = new Set(['ran_out_at', 'confirmed_at', 'created_at', 'updated_at']);

function fromRow(row: Record<string, unknown>): ProductionLogRow {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'prepped_portions' || k === 'production_log_id') out[camel(k)] = v === null ? null : Number(v);
    else if (NUMERIC.has(k)) out[camel(k)] = v === null ? null : Number(v); // numeric arrives as a string
    else if (TIMESTAMPS.has(k)) out[camel(k)] = v === null ? null : new Date(String(v)).toISOString();
    else out[camel(k)] = v;
  }
  out.reviewFlags = (out.reviewFlags as string[] | null) ?? [];
  return out as unknown as ProductionLogRow;
}

function toRow(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) if (v !== undefined) out[snake(k)] = v;
  return out;
}

function uniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}

export class SupabaseProductionStore implements ProductionStore {
  readonly kind = 'supabase' as const;
  private readonly db: SupabaseClient;

  constructor(config: { url: string; serviceRoleKey: string; client?: SupabaseClient }) {
    this.db = config.client ?? createClient(config.url, config.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private fail(op: string, error: { message?: string; code?: string }): never {
    throw new Error(`Supabase ${op} failed${error.code ? ` (${error.code})` : ''}: ${error.message ?? 'unknown error'}`);
  }

  async listDishes(): Promise<DishRecord[]> {
    const { data, error } = await this.db.from('dish').select('dish_id, display_name, category, service_style, is_simulated').order('display_name');
    if (error) this.fail('select dish', error);
    return (data ?? []).map((d) => ({ dishId: d.dish_id, displayName: d.display_name, category: d.category, serviceStyle: d.service_style, isSimulated: d.is_simulated }));
  }

  async dishAliases(hallId: string, serviceDate?: string): Promise<{ dishId: string; name: string }[]> {
    let q = this.db.from('meal_service').select('menu_id').eq('hall_id', hallId);
    if (serviceDate) q = q.eq('service_date', serviceDate);
    const { data: services, error } = await q;
    if (error) this.fail('select meal_service', error);
    const menuIds = [...new Set((services ?? []).map((s) => s.menu_id))];
    if (menuIds.length === 0) return [];
    const { data: items, error: e2 } = await this.db.from('menu_item').select('dish_id, display_name').in('menu_id', menuIds).not('dish_id', 'is', null);
    if (e2) this.fail('select menu_item', e2);
    return (items ?? []).map((i) => ({ dishId: i.dish_id as string, name: i.display_name as string }));
  }

  async hallTimezone(hallId: string): Promise<string> {
    const { data } = await this.db.from('hall').select('timezone').eq('hall_id', hallId).maybeSingle();
    return (data?.timezone as string | undefined) ?? DEFAULT_TZ;
  }

  async insert(rows: NewProductionRow[]): Promise<ProductionLogRow[]> {
    if (rows.length === 0) return [];
    const { data, error } = await this.db.from('production_log').insert(rows.map((r) => toRow(r as unknown as Record<string, unknown>))).select('*');
    if (error) this.fail('insert production_log', error);
    return (data ?? []).map(fromRow);
  }

  async list(filter: ProductionFilter): Promise<ProductionLogRow[]> {
    let q = this.db.from('production_log').select('*').eq('hall_id', filter.hallId);
    if (filter.status) q = q.eq('status', filter.status);
    if (filter.start) q = q.gte('service_date', filter.start);
    if (filter.end) q = q.lte('service_date', filter.end);
    if (filter.sheetImageObjectId) q = q.eq('sheet_image_object_id', filter.sheetImageObjectId);
    const { data, error } = await q.order('service_date', { ascending: true, nullsFirst: true }).order('production_log_id').limit(2000);
    if (error) this.fail('select production_log', error);
    return (data ?? []).map(fromRow);
  }

  async get(id: number): Promise<ProductionLogRow | undefined> {
    const { data, error } = await this.db.from('production_log').select('*').eq('production_log_id', id).maybeSingle();
    if (error) this.fail('select production_log', error);
    return data ? fromRow(data) : undefined;
  }

  async update(id: number, patch: ProductionPatch): Promise<ProductionLogRow> {
    const { data, error } = await this.db
      .from('production_log')
      .update({ ...toRow(patch as Record<string, unknown>), updated_at: new Date().toISOString() })
      .eq('production_log_id', id)
      .select('*')
      .maybeSingle();
    if (error) {
      if (uniqueViolation(error)) throw conflict('PRODUCTION_ROW_EXISTS', 'This dish already has a confirmed row for that station, date and meal.', { productionLogId: id });
      this.fail('update production_log', error);
    }
    if (!data) throw notFound('PRODUCTION_ROW_NOT_FOUND', 'That production row does not exist.', { productionLogId: id });
    return fromRow(data);
  }
}

/** Offline store with the same rules as the table (used by tests and non-Supabase setups). */
export class InMemoryProductionStore implements ProductionStore {
  readonly kind = 'memory' as const;
  private rows: ProductionLogRow[] = [];
  private nextId = 1;

  constructor(
    private readonly dishes: DishRecord[] = [],
    private readonly aliases: { hallId: string; serviceDate?: string; dishId: string; name: string }[] = [],
    private readonly timezone = DEFAULT_TZ,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async listDishes() {
    return [...this.dishes];
  }
  async dishAliases(hallId: string, serviceDate?: string) {
    return this.aliases.filter((a) => a.hallId === hallId && (!serviceDate || !a.serviceDate || a.serviceDate === serviceDate)).map(({ dishId, name }) => ({ dishId, name }));
  }
  async hallTimezone() {
    return this.timezone;
  }
  async insert(rows: NewProductionRow[]) {
    const stamp = new Date(this.now()).toISOString();
    const created = rows.map((r) => ({ ...r, productionLogId: this.nextId++, confirmedBy: null, confirmedAt: null, isSimulated: false, createdAt: stamp, updatedAt: stamp }));
    this.rows.push(...created);
    return created.map((r) => ({ ...r }));
  }
  async list(filter: ProductionFilter) {
    return this.rows
      .filter((r) => r.hallId === filter.hallId)
      .filter((r) => !filter.status || r.status === filter.status)
      .filter((r) => !filter.start || (r.serviceDate !== null && r.serviceDate >= filter.start))
      .filter((r) => !filter.end || (r.serviceDate !== null && r.serviceDate <= filter.end))
      .filter((r) => !filter.sheetImageObjectId || r.sheetImageObjectId === filter.sheetImageObjectId)
      .map((r) => ({ ...r }));
  }
  async get(id: number) {
    const r = this.rows.find((x) => x.productionLogId === id);
    return r ? { ...r } : undefined;
  }
  async update(id: number, patch: ProductionPatch) {
    const i = this.rows.findIndex((x) => x.productionLogId === id);
    if (i < 0) throw notFound('PRODUCTION_ROW_NOT_FOUND', 'That production row does not exist.', { productionLogId: id });
    const next = { ...this.rows[i]!, ...patch, updatedAt: new Date(this.now()).toISOString() } as ProductionLogRow;
    if (next.status === 'confirmed') {
      const clash = this.rows.some(
        (r, j) => j !== i && r.status === 'confirmed' && r.hallId === next.hallId && r.serviceDate === next.serviceDate &&
          r.mealLabel === next.mealLabel && r.dishId === next.dishId && (r.station ?? '') === (next.station ?? ''),
      );
      if (clash) throw conflict('PRODUCTION_ROW_EXISTS', 'This dish already has a confirmed row for that station, date and meal.', { productionLogId: id });
    }
    this.rows[i] = next;
    return { ...next };
  }
}

/** Local wall-clock time (HH:MM) on a local date in `timeZone` -> UTC ISO instant. */
export function localTimeToUtc(serviceDate: string, hhmm: string, timeZone: string): string {
  const [y, mo, d] = serviceDate.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Offset of the zone at that instant (two passes handle DST edges).
  const offsetAt = (t: number) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t).toISOString();
}

/** UTC ISO instant -> local HH:MM in `timeZone`. */
export function utcToLocalTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}
