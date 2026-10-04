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
  ScanInfo,
} from '../types.js';

/** A row created by the demo-history seed: SpacetimeDB table name + primary key. */
export interface DemoMarker {
  tableName:
    | 'meal_service'
    | 'menu_item'
    | 'portions_served'
    | 'capture_event'
    | 'scan_info'
    | 'analysis_attempt'
    | 'food_measurement'
    | 'capture_count';
  rowKey: string;
}

export interface Repository {
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
  /** Image objects registered for one association (e.g. a capture's 'original'). */
  findImageObjectsByAssociation(kind: ImageObject['association']['kind'], id: string): Promise<ImageObject[]>;

  // --- scans (one ScanInfo per capture event) ---
  upsertScanInfo(scan: ScanInfo): Promise<void>;
  getScanInfo(eventId: string): Promise<ScanInfo | undefined>;

  // --- sample data (DEMO_SEED): every row the demo seed creates is marked ---
  recordDemoMarkers(markers: DemoMarker[]): Promise<void>;
  /** Delete exactly the marked rows (and their markers); returns how many rows were marked. */
  clearDemoData(): Promise<number>;

  // --- capture events (idempotency key: eventId) ---
  upsertCaptureEvent(event: CaptureEvent): Promise<void>;
  getCaptureEvent(eventId: string): Promise<CaptureEvent | undefined>;
  listCaptureEvents(filter?: { hallId?: string; serviceId?: string }): Promise<CaptureEvent[]>;

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
}
