/**
 * Basic shape validation for API payloads. Agent 2 owns the full menu
 * parsing/validation helpers (AGENTS.md 2.1/2.5); until those land, these
 * checks enforce the contract shapes so garbage never reaches persistence.
 * Treat all input as untrusted (working rule 8): values are checked, never
 * interpreted or executed.
 */

import { badRequest } from '../errors.js';
import type {
  Attendance,
  CaptureSource,
  ImageGeometry,
  Insight,
  MealLabel,
  MenuBundle,
  QualityFlag,
  ReferencePortion,
} from '../types.js';

const MEAL_LABELS: MealLabel[] = ['breakfast', 'lunch', 'dinner'];
const REFERENCE_SOURCES = ['reference_photo', 'manual_area', 'gemini_estimate'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isFinitePositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

export function validateGeometry(g: unknown, field = 'geometry'): ImageGeometry {
  const geo = g as Partial<ImageGeometry> | undefined;
  if (
    !geo ||
    !isFinitePositive(geo.widthPx) ||
    !isFinitePositive(geo.heightPx) ||
    geo.coordinateSpace !== 'topdown-normalized-v1'
  ) {
    throw badRequest(
      'INVALID_GEOMETRY',
      `${field} must include positive widthPx/heightPx and coordinateSpace 'topdown-normalized-v1'.`,
    );
  }
  return geo as ImageGeometry;
}

export function validateMenuBundle(body: unknown): MenuBundle {
  const b = body as Partial<MenuBundle> | undefined;
  const s = b?.service;
  if (
    !s ||
    !isNonEmptyString(s.serviceId) ||
    !isNonEmptyString(s.hallId) ||
    !isNonEmptyString(s.hallTimezone) ||
    !isNonEmptyString(s.serviceDate) ||
    !DATE_RE.test(s.serviceDate) ||
    !MEAL_LABELS.includes(s.mealLabel as MealLabel) ||
    !isNonEmptyString(s.menuId) ||
    !Number.isInteger(s.menuVersion) ||
    (s.menuVersion as number) < 1
  ) {
    throw badRequest(
      'INVALID_MENU',
      'The menu needs a service with serviceId, hallId, hallTimezone, serviceDate (YYYY-MM-DD), mealLabel (breakfast/lunch/dinner), menuId and menuVersion >= 1.',
    );
  }
  if (!Array.isArray(b.items) || b.items.length === 0) {
    throw badRequest('INVALID_MENU', 'The menu needs at least one item.');
  }
  const seen = new Set<string>();
  for (const item of b.items) {
    if (!isNonEmptyString(item?.itemId) || !isNonEmptyString(item?.displayName)) {
      throw badRequest('INVALID_MENU', 'Every menu item needs an itemId and a displayName.');
    }
    if (item.menuId !== s.menuId) {
      throw badRequest('INVALID_MENU', 'Every menu item must belong to the menuId of its service.', {
        itemId: item.itemId,
      });
    }
    if (seen.has(item.itemId)) {
      throw badRequest('INVALID_MENU', 'Menu item IDs must be unique.', { itemId: item.itemId });
    }
    seen.add(item.itemId);
  }
  return b as MenuBundle;
}

export function validateReferencePortion(body: unknown): ReferencePortion {
  const r = body as Partial<ReferencePortion> | undefined;
  if (
    !r ||
    !isNonEmptyString(r.baselineId) ||
    !Number.isInteger(r.baselineVersion) ||
    (r.baselineVersion as number) < 1 ||
    !isNonEmptyString(r.itemId) ||
    !isFinitePositive(r.expectedAreaPx) ||
    !REFERENCE_SOURCES.includes(r.source as string)
  ) {
    throw badRequest(
      'INVALID_REFERENCE_PORTION',
      'A reference portion needs baselineId, baselineVersion >= 1, itemId, expectedAreaPx > 0, geometry, and a valid source.',
    );
  }
  validateGeometry(r.geometry);
  return r as ReferencePortion;
}

export interface CaptureSubmission {
  eventId: string;
  hallId: string;
  serviceId: string;
  capturedAt: string;
  imageObjectId: string;
  geometry: ImageGeometry;
  source: CaptureSource;
  qualityFlags?: QualityFlag[];
  /** Per-scan details (contracts ScanInfo minus eventId/demo). */
  scan?: ScanSubmission;
}

export interface ScanSubmission {
  deviceId: string;
  timestampBasis: 'laptop_trigger' | 'laptop_received' | 'laptop_ingest';
  originalImageObjectId?: string;
  originalSha256?: string;
  sourceName?: string;
}

/** Sources a client may submit; 'demo' rows come only from the demo-history seed. */
const SUBMITTABLE_SOURCES: CaptureSource[] = ['camera', 'replay', 'manual_upload'];

export function validateCaptureSubmission(body: unknown): CaptureSubmission {
  const c = body as Partial<CaptureSubmission> | undefined;
  if (
    !c ||
    !isNonEmptyString(c.eventId) ||
    !isNonEmptyString(c.hallId) ||
    !isNonEmptyString(c.serviceId) ||
    !isNonEmptyString(c.capturedAt) ||
    Number.isNaN(Date.parse(c.capturedAt)) ||
    !isNonEmptyString(c.imageObjectId) ||
    !SUBMITTABLE_SOURCES.includes(c.source as CaptureSource)
  ) {
    throw badRequest(
      'INVALID_CAPTURE',
      'A capture needs eventId, hallId, serviceId, capturedAt (UTC ISO 8601), imageObjectId, geometry, and source (camera/replay/manual_upload).',
    );
  }
  validateGeometry(c.geometry);
  if (c.qualityFlags !== undefined && !Array.isArray(c.qualityFlags)) {
    throw badRequest('INVALID_CAPTURE', 'qualityFlags must be a list when present.');
  }
  if (c.scan !== undefined) validateScan(c.scan);
  return c as CaptureSubmission;
}

function validateScan(scan: unknown): void {
  const s = scan as Partial<ScanSubmission> | null;
  const optionalString = (v: unknown) => v === undefined || isNonEmptyString(v);
  if (
    !s ||
    typeof s !== 'object' ||
    !isNonEmptyString(s.deviceId) ||
    !['laptop_trigger', 'laptop_received', 'laptop_ingest'].includes(String(s.timestampBasis)) ||
    !optionalString(s.originalImageObjectId) ||
    !optionalString(s.sourceName) ||
    (s.originalSha256 !== undefined && !/^[0-9a-f]{64}$/.test(String(s.originalSha256)))
  ) {
    throw badRequest(
      'INVALID_SCAN',
      "scan needs deviceId, timestampBasis ('laptop_trigger', 'laptop_received' or 'laptop_ingest'), and optional originalImageObjectId, originalSha256 (64 hex), sourceName.",
    );
  }
}

export function validateAttendance(body: unknown): Attendance {
  const a = body as Partial<Attendance> | undefined;
  if (
    !a ||
    !isNonEmptyString(a.hallId) ||
    !isNonEmptyString(a.serviceId) ||
    !isNonEmptyString(a.serviceDate) ||
    !Number.isInteger(a.count) ||
    (a.count as number) < 0 ||
    a.source !== 'simulated' ||
    !Number.isInteger(a.configuredMin) ||
    !Number.isInteger(a.configuredMax) ||
    !isNonEmptyString(a.generatorVersion)
  ) {
    throw badRequest(
      'INVALID_ATTENDANCE',
      "Attendance needs hallId, serviceId, serviceDate, integer count >= 0, source 'simulated', configuredMin/Max, and generatorVersion.",
    );
  }
  return a as Attendance;
}

export function validateInsight(body: unknown): Insight {
  const i = body as Partial<Insight> | undefined;
  if (
    !i ||
    !isNonEmptyString(i.insightId) ||
    !isNonEmptyString(i.hallId) ||
    !isNonEmptyString(i.windowStart) ||
    !isNonEmptyString(i.windowEnd) ||
    typeof i.metrics !== 'object' ||
    i.metrics === null ||
    !isNonEmptyString(i.dataVersion) ||
    !isNonEmptyString(i.recommendation) ||
    (i.source !== 'gemini' && i.source !== 'fallback_rules') ||
    !isNonEmptyString(i.generatedAt)
  ) {
    throw badRequest(
      'INVALID_INSIGHT',
      'An insight needs insightId, hallId, window, metrics, dataVersion, recommendation, source (gemini/fallback_rules), and generatedAt.',
    );
  }
  return i as Insight;
}
