/**
 * Persistence seam — PLACEHOLDER FOR SPACETIMEDB.
 *
 * Agent 2's SpacetimeDB schema does not exist yet (contracts/decisions.md,
 * open questions). Until it lands, the backend talks to this repository
 * interface, whose record shapes are VERBATIM the entity shapes in
 * contracts/types.ts. The bundled implementation (jsonFileRepository.ts)
 * keeps everything in memory with optional JSON-file persistence.
 *
 * Swap plan (AGENTS.md 5.1 / §4 boundary):
 *  - Agent 2 publishes table definitions; Agent 5 implements reducers for
 *    the mutation methods below and subscription/query access for the reads.
 *  - Each mutation method here maps to one reducer call; each read maps to a
 *    query/subscription. The service layer never changes.
 *  - Gemini requests and object-storage network I/O stay in the service
 *    layer (ingestionService, objectStorage) and must NEVER move into a
 *    transactional reducer. Reducers only receive already-verified object
 *    references and already-validated analysis results.
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
  CameraCalibration,
  MeasurementSettings,
} from '../types.js';

export interface CaptureEventFilter {
  hallId?: string;
  serviceId?: string;
  /** Admin panel only: also return hidden captures. */
  includeHidden?: boolean;
}

export interface Repository {
  /** Readiness probe (GET /api/ready): throws when the store is unreachable. */
  ping?(): Promise<void>;

  // --- menus (MealService + MenuItem[], joined as MenuBundle) ---
  upsertMenu(menu: MenuBundle): Promise<void>;
  getMenuByService(serviceId: string): Promise<MenuBundle | undefined>;
  /** Resolve by hall + local service date (+ optional meal label). */
  findMenus(hallId: string, serviceDate: string, mealLabel?: string): Promise<MenuBundle[]>;
  listServices(hallId?: string): Promise<MealService[]>;
  /** Any stored menu_item row with this stable itemId (display-name lookup for older menu versions). */
  getMenuItem(itemId: string): Promise<MenuItem | undefined>;

  // Replace one version's full snapshot atomically; retain earlier menu versions.
  replacePortionsServed(serviceId: string, menuVersion: number, portions: PortionsServed[]): Promise<void>;
  listPortionsServed(serviceId: string, menuVersion: number): Promise<PortionsServed[]>;

  // --- reference portions (baselines) ---
  upsertReferencePortion(ref: ReferencePortion): Promise<void>;
  getReferencePortion(baselineId: string): Promise<ReferencePortion | undefined>;
  /** Latest baselineVersion per itemId; optionally filtered to one item. */
  listReferencePortions(itemId?: string): Promise<ReferencePortion[]>;
  deleteReferencePortion(baselineId: string): Promise<boolean>;

  // --- image objects (references + metadata only; bytes live in object storage) ---
  upsertImageObject(obj: ImageObject): Promise<void>;
  getImageObject(objectId: string): Promise<ImageObject | undefined>;
  listImageObjects(state?: ImageObject['state']): Promise<ImageObject[]>;
  deleteImageObject(objectId: string): Promise<boolean>;

  // --- capture events (idempotency key: eventId) ---
  upsertCaptureEvent(event: CaptureEvent): Promise<void>;
  getCaptureEvent(eventId: string): Promise<CaptureEvent | undefined>;
  /** Hidden captures (admin curation) are left out unless includeHidden is set. */
  listCaptureEvents(filter?: CaptureEventFilter): Promise<CaptureEvent[]>;

  // --- admin curation: which captures the dashboard shows (no record = shown) ---
  /** Event ids of captures an admin has hidden. */
  listHiddenCaptureIds(): Promise<Set<string>>;
  /** Hide or show existing captures; rejects unknown event ids. */
  setCaptureVisibility(eventIds: string[], hidden: boolean, updatedAt: string): Promise<void>;

  // --- analysis attempts (append-only per event) ---
  addAnalysisAttempt(attempt: AnalysisAttempt): Promise<void>;
  listAnalysisAttempts(eventId: string): Promise<AnalysisAttempt[]>;
  /** Append an attempt and its measurements together (one reducer call = one transaction). */
  recordAnalysis(attempt: AnalysisAttempt, measurements: FoodMeasurement[]): Promise<void>;

  // --- food measurements (owned by one attempt) ---
  addMeasurements(measurements: FoodMeasurement[]): Promise<void>;
  listMeasurementsByAttempt(attemptId: string): Promise<FoodMeasurement[]>;
  listMeasurementsByEvent(eventId: string): Promise<FoodMeasurement[]>;

  // --- attendance (one per hall/date/service; written by Agent 6's generator) ---
  upsertAttendance(att: Attendance): Promise<void>;
  getAttendance(serviceId: string): Promise<Attendance | undefined>;

  // --- insights (written by Agent 6's suggestion service) ---
  upsertInsight(insight: Insight): Promise<void>;
  listInsights(hallId?: string): Promise<Insight[]>;

  // --- IT_4: camera calibrations (immutable once succeeded/failed) + per-hall settings ---
  upsertCameraCalibration(calibration: CameraCalibration): Promise<void>;
  getCameraCalibration(calibrationId: string): Promise<CameraCalibration | undefined>;
  listCameraCalibrations(hallId?: string): Promise<CameraCalibration[]>;
  /** Rejects an active calibration that is not a succeeded calibration of the hall. */
  upsertMeasurementSettings(settings: MeasurementSettings): Promise<void>;
  getMeasurementSettings(hallId: string): Promise<MeasurementSettings | undefined>;
}
