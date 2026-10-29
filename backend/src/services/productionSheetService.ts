/**
 * Production sheets -> production_log (forecasting, overnight Phase 2).
 *
 *   1. The dashboard uploads the photo through the normal upload flow
 *      (associationKind 'production_sheet' -> production-sheets/<date>/…).
 *   2. extract(): Gemini reads the sheet (vision/src/productionSheet.ts). Every
 *      line is saved as an UNCONFIRMED row with per-field confidence, review
 *      flags, and the photo's storage path. Nothing is confirmed automatically.
 *   3. A person reviews: edit() fixes values (an edited field counts as fully
 *      confident, and flags are recomputed); confirm() records who checked it;
 *      reject() keeps the row out of forecasting.
 *
 * Gemini is used only when live: mock text is never turned into rows.
 */

import {
  DEFAULT_MEAL_WINDOWS,
  extractProductionSheet,
  reviewFlagsFor,
  type ExtractedProductionRow,
  type GeminiGateway,
  type SheetMeal,
} from '@scrap/vision';
import { HttpError, apiError, badRequest, conflict, notFound } from '../errors.js';
import type { Repository } from '../repo/repository.js';
import type { ObjectStorageAdapter } from '../storage/objectStorage.js';
import {
  localTimeToUtc,
  utcToLocalTime,
  type MealLabel,
  type ProductionLogRow,
  type ProductionPatch,
  type ProductionStore,
} from '../repo/productionStore.js';

const MEALS = ['breakfast', 'lunch', 'dinner'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Flags a person must resolve before confirming (low confidence only needs their eyes). */
const BLOCKING = ['missing_dish', 'unknown_dish', 'missing_meal', 'missing_date', 'leftover_exceeds_prepped', 'missing_prepped_amount'];
const isBlocking = (flag: string) => BLOCKING.includes(flag) || flag.startsWith('negative_value:') || flag.startsWith('not_a_number:');

/** A row as the dashboard sees it: ran-out time in the hall's local HH:MM as well. */
export type ProductionRowView = ProductionLogRow & { ranOutTime: string | null; blockingFlags: string[] };

export interface ExtractRequest {
  objectId: string;
  hallId: string;
  serviceDate?: string;
  mealLabel?: SheetMeal;
}

export class ProductionSheetService {
  constructor(
    private readonly repo: Repository,
    private readonly storage: ObjectStorageAdapter,
    private readonly store: ProductionStore,
    /** Live Gemini only; undefined = sheet reading is unavailable on this server. */
    private readonly gateway: GeminiGateway | undefined,
  ) {}

  get available(): boolean {
    return this.gateway !== undefined;
  }

  private async view(rows: ProductionLogRow[], hallId: string): Promise<ProductionRowView[]> {
    const tz = await this.store.hallTimezone(hallId);
    return rows.map((r) => ({
      ...r,
      // Staff names stay in the private production_log table (audit); the API, which the
      // public site reads without signing in, never returns them. confirmedAt shows it was checked.
      confirmedBy: null,
      ranOutTime: r.ranOutAt ? utcToLocalTime(r.ranOutAt, tz) : null,
      blockingFlags: r.reviewFlags.filter(isBlocking),
    }));
  }

  async extract(req: ExtractRequest): Promise<{ readable: boolean; notes: string | null; model: string; promptVersion: string; rows: ProductionRowView[] }> {
    if (!this.gateway) {
      throw new HttpError(503, apiError('SHEET_READER_UNAVAILABLE', 'Reading sheets needs live Gemini (GEMINI_API_KEY) on this server.', false));
    }
    if (!req.hallId) throw badRequest('MISSING_PARAMETER', "'hallId' is required.");
    if (req.serviceDate !== undefined && !DATE_RE.test(req.serviceDate)) throw badRequest('INVALID_PARAMETER', "'serviceDate' must be YYYY-MM-DD.");
    if (req.mealLabel !== undefined && !(MEALS as readonly string[]).includes(req.mealLabel)) throw badRequest('INVALID_PARAMETER', "'mealLabel' must be breakfast, lunch or dinner.");

    const image = await this.repo.getImageObject(req.objectId);
    if (!image || image.association.kind !== 'production_sheet') {
      throw notFound('SHEET_NOT_FOUND', 'Upload the sheet photo first (associationKind production_sheet).', { objectId: req.objectId });
    }
    if (image.state !== 'finalized') throw conflict('UPLOAD_NOT_COMPLETED', 'The sheet photo has not finished uploading.', { objectId: req.objectId });
    // Re-reading the same photo would duplicate its rows.
    const existing = await this.store.list({ hallId: req.hallId, sheetImageObjectId: req.objectId });
    if (existing.length > 0) {
      return { readable: true, notes: null, model: existing[0]!.extractionModel ?? '', promptVersion: '', rows: await this.view(existing, req.hallId) };
    }

    const [dishes, aliases] = await Promise.all([this.store.listDishes(), this.store.dishAliases(req.hallId, req.serviceDate)]);
    const known = dishes.map((d) => ({
      dishId: d.dishId,
      displayName: d.displayName,
      aliases: aliases.filter((a) => a.dishId === d.dishId).map((a) => a.name),
    }));
    const { bytes, mimeType } = await this.storage.getObjectBytes(image.objectKey);
    const result = await extractProductionSheet(this.gateway, {
      image: { kind: 'bytes', bytes, mimeType },
      dishes: known,
      expected: { ...(req.serviceDate ? { serviceDate: req.serviceDate } : {}), ...(req.mealLabel ? { mealLabel: req.mealLabel } : {}) },
    });
    if (!result.ok) throw new HttpError(result.error.retryable ? 502 : 422, result.error);

    const tz = await this.store.hallTimezone(req.hallId);
    const inserted = await this.store.insert(
      result.rows.map((r) => ({
        hallId: req.hallId,
        serviceDate: r.serviceDate,
        mealLabel: r.mealLabel,
        dishId: r.dishId,
        dishNameRaw: r.dishNameRaw,
        station: r.station,
        preppedLb: r.preppedLb,
        preppedPortions: r.preppedPortions,
        panLeftoverLb: r.panLeftoverLb,
        ranOutAt: r.ranOutTime && r.serviceDate ? localTimeToUtc(r.serviceDate, r.ranOutTime, tz) : null,
        source: 'sheet_photo' as const,
        status: 'unconfirmed' as const,
        fieldConfidence: r.fieldConfidence,
        reviewFlags: r.reviewFlags,
        sheetImageObjectId: image.objectId,
        sheetPhotoPath: image.objectKey,
        extractionModel: `${result.model}|${result.promptVersion}`,
      })),
    );
    return { readable: result.readable, notes: result.notes, model: result.model, promptVersion: result.promptVersion, rows: await this.view(inserted, req.hallId) };
  }

  async list(hallId: string, filter: { status?: ProductionLogRow['status']; start?: string; end?: string } = {}): Promise<ProductionRowView[]> {
    if (!hallId) throw badRequest('MISSING_PARAMETER', "'hallId' is required.");
    return this.view(await this.store.list({ hallId, ...filter }), hallId);
  }

  async dishes() {
    return this.store.listDishes();
  }

  private async unconfirmed(id: number): Promise<ProductionLogRow> {
    const row = await this.store.get(id);
    if (!row) throw notFound('PRODUCTION_ROW_NOT_FOUND', 'That production row does not exist.', { productionLogId: id });
    if (row.status !== 'unconfirmed') {
      throw conflict('PRODUCTION_ROW_LOCKED', `This row is already ${row.status}.`, { productionLogId: id, status: row.status });
    }
    return row;
  }

  /** A person's corrections. Edited fields become fully confident; flags are recomputed from the values. */
  async edit(id: number, body: Record<string, unknown>): Promise<ProductionRowView> {
    const row = await this.unconfirmed(id);
    const patch: ProductionPatch = {};
    const touched: string[] = [];
    const num = (key: 'preppedLb' | 'panLeftoverLb' | 'preppedPortions') => {
      if (!(key in body)) return;
      const v = body[key];
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (key === 'preppedPortions' && !Number.isInteger(v)))) {
        throw badRequest('INVALID_PARAMETER', `'${key}' must be ${key === 'preppedPortions' ? 'a whole number' : 'a number'} of 0 or more, or null.`);
      }
      patch[key] = v as number | null;
      touched.push(key);
    };
    num('preppedLb');
    num('panLeftoverLb');
    num('preppedPortions');
    if ('dishId' in body) {
      const v = body.dishId;
      if (v !== null && (typeof v !== 'string' || !(await this.store.listDishes()).some((d) => d.dishId === v))) {
        throw badRequest('UNKNOWN_DISH', 'Choose one of the hall’s dishes.', { dishId: v });
      }
      patch.dishId = v as string | null;
      touched.push('dish');
    }
    if ('station' in body) {
      const v = body.station;
      if (v !== null && typeof v !== 'string') throw badRequest('INVALID_PARAMETER', "'station' must be text or null.");
      patch.station = v === null ? null : (v as string).trim().slice(0, 80) || null;
      touched.push('station');
    }
    if ('mealLabel' in body) {
      if (!(MEALS as readonly unknown[]).includes(body.mealLabel)) throw badRequest('INVALID_PARAMETER', "'mealLabel' must be breakfast, lunch or dinner.");
      patch.mealLabel = body.mealLabel as MealLabel;
      touched.push('mealLabel');
    }
    if ('serviceDate' in body) {
      if (typeof body.serviceDate !== 'string' || !DATE_RE.test(body.serviceDate)) throw badRequest('INVALID_PARAMETER', "'serviceDate' must be YYYY-MM-DD.");
      patch.serviceDate = body.serviceDate;
      touched.push('serviceDate');
    }
    const tz = await this.store.hallTimezone(row.hallId);
    let ranOutTime = row.ranOutAt ? utcToLocalTime(row.ranOutAt, tz) : null;
    if ('ranOutTime' in body) {
      const v = body.ranOutTime;
      if (v !== null && (typeof v !== 'string' || !TIME_RE.test(v))) throw badRequest('INVALID_PARAMETER', "'ranOutTime' must be HH:MM (24-hour) or null.");
      ranOutTime = v as string | null;
      touched.push('ranOutTime');
    }
    if (touched.length === 0) throw badRequest('INVALID_PARAMETER', 'Nothing to change.');

    const next = { ...row, ...patch };
    const serviceDate = next.serviceDate;
    patch.ranOutAt = ranOutTime && serviceDate ? localTimeToUtc(serviceDate, ranOutTime, tz) : null;
    const fieldConfidence = { ...(row.fieldConfidence ?? {}) } as Record<string, number>;
    for (const f of touched) fieldConfidence[f] = 1;
    patch.fieldConfidence = fieldConfidence;
    const values: Omit<ExtractedProductionRow, 'reviewFlags'> = {
      dishNameRaw: next.dishNameRaw,
      dishId: next.dishId,
      station: next.station,
      mealLabel: next.mealLabel,
      serviceDate: next.serviceDate,
      preppedLb: next.preppedLb,
      preppedPortions: next.preppedPortions,
      panLeftoverLb: next.panLeftoverLb,
      ranOutTime,
      fieldConfidence: fieldConfidence as ExtractedProductionRow['fieldConfidence'],
    };
    // A dish picked by a person is no longer "unknown", whatever the sheet said.
    patch.reviewFlags = reviewFlagsFor(values, DEFAULT_MEAL_WINDOWS);
    return (await this.view([await this.store.update(id, patch)], row.hallId))[0]!;
  }

  async confirm(id: number, confirmedBy: unknown): Promise<ProductionRowView> {
    if (typeof confirmedBy !== 'string' || confirmedBy.trim().length === 0) {
      throw badRequest('MISSING_PARAMETER', "'confirmedBy' (who checked this row) is required.");
    }
    const row = await this.unconfirmed(id);
    const blocking = row.reviewFlags.filter(isBlocking);
    if (blocking.length > 0) {
      throw conflict('PRODUCTION_ROW_NEEDS_FIXES', 'Fix the flagged values before confirming.', { productionLogId: id, flags: blocking });
    }
    const updated = await this.store.update(id, { status: 'confirmed', confirmedBy: confirmedBy.trim().slice(0, 80), confirmedAt: new Date().toISOString() });
    return (await this.view([updated], row.hallId))[0]!;
  }

  async reject(id: number): Promise<ProductionRowView> {
    const row = await this.unconfirmed(id);
    return (await this.view([await this.store.update(id, { status: 'rejected' })], row.hallId))[0]!;
  }
}
