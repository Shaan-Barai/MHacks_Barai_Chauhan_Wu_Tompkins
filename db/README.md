# db — SpacetimeDB schema (Agent 2)

Table definitions, schema evolution, and seed definitions for the Scrap
prototype (AGENTS.md 2.4). Reducer/procedure implementations belong to
Agent 5; shared module assembly and generated client bindings to Agent 1.

**Database: `scrap`** (BIG-PLAN v2, 2026-10-04). Everything lives there;
`scrap-bigplan` is retired. Schema changes are published **additively in
place** and the database is never wiped. v2 stores pixel counts only: there is
no plate calibration, and relative impact points are derived by `analytics/`
at read time, never stored.

## Module language/version decision

Checked against the official SpacetimeDB docs (spacetimedb.com/docs,
2026-10-03): current SpacetimeDB **2.10.2** supports **Rust, C#, and
TypeScript** server modules (plus experimental C++).

**Chosen: TypeScript** (`spacetimedb` npm package **2.10.2**,
`spacetimedb/server` API). `contracts/decisions.md` said "default to Rust if
nothing argues otherwise" — the stack argues otherwise: every other module in
this repo is Node 20 + TypeScript, TypeScript modules are first-class in
2.10.x, and Agent 5 can write reducers in the same language without a Rust
toolchain. Flagged for Agent 1 to record in `contracts/decisions.md`.

## Verification status (verified, not just docs)

With the SpacetimeDB CLI 2.10.2 on 2026-10-03, from `db/spacetimedb/`:

- `npm run typecheck` — passes against the real `spacetimedb@2.10.2` types.
- `spacetime build --module-path .` — **module compiles successfully**.
- `spacetime publish --module-path . --server local --yes scrap` against a
  local `spacetime start` server — **published**; all 9 tables exist
  (`spacetime sql scrap "SELECT * FROM meal_service"` etc. return the
  expected columns).
- `spacetime generate --lang typescript --out-dir <tmp> --module-path .` —
  **client bindings generate successfully** (not committed; Agent 1 owns
  generated bindings and their location).

Note: SpacetimeDB snake_cases column names in SQL (`serviceId` →
`service_id`); the TypeScript API and generated bindings keep camelCase.

## Layout

```
db/
├── README.md
└── spacetimedb/          # the module project (`spacetime publish -p db/spacetimedb`)
    ├── package.json      # dependency: spacetimedb ^2.10.2
    ├── tsconfig.json     # typecheck only; the CLI does the real build
    └── src/
        ├── index.ts      # module entry (Agent 1): re-exports schema + reducers
        ├── schema.ts     # TABLE DEFINITIONS (Agent 2) + schema export
        └── reducers.ts   # REDUCERS (Agent 5): one per backend Repository mutation
```

## Publish / generate

```bash
cd db/spacetimedb
npm install
npm run typecheck

# local dev server (keep running in another terminal)
spacetime start

# create/update the database: additive, in place, never deleting data
spacetime publish --module-path . --server local --delete-data=never --yes=migrate,break-clients scrap
# (the backend must be the publishing identity — see root README setup step 3)
# If the CLI reports that the change needs a data wipe, stop: make the change additive instead.

# client bindings (Agent 1 decides the committed location)
spacetime generate --lang typescript --out-dir ../../frontend/src/module_bindings --module-path .

# sanity checks
spacetime sql --server local scrap "SELECT * FROM meal_service"
spacetime logs --server local scrap
```

Schema changes: additive changes (new tables) publish in place. Breaking
changes would need `--delete-data`, which is **not allowed on `scrap` or
`scrap-bigplan`**; add a new table instead (the pattern used by
`capture_count`, `segmentation_region`, `attempt_calibration`,
`menu_item_revision`). Try risky changes on a throwaway local database name
first and delete only that one.

## Tables (mirroring contracts/types.ts)

| Table | Contract entity | Primary key | Btree indexes | Client-visible (public) |
| --- | --- | --- | --- | --- |
| `meal_service` | MealService | `serviceId` | `hallId`, `serviceDate`, `menuId` | yes |
| `menu_item` | MenuItem | `itemId` | `menuId` | yes |
| `reference_portion` | ReferencePortion | `baselineId` | `itemId` | yes |
| `image_object` | ImageObject | `objectId` | `associationId`, `state` | **no — server-only** |
| `capture_event` | CaptureEvent | `eventId` | `hallId`, `serviceId` | yes |
| `analysis_attempt` | AnalysisAttempt | `attemptId` | `eventId` | **no — server-only** |
| `food_measurement` | FoodMeasurement | `measurementId` | `eventId`, `attemptId` | yes |
| `attendance` | Attendance | `serviceId` | `hallId` | yes |
| `insight` | Insight | `insightId` | `hallId` | yes |
| `portions_served` | PortionsServed | `recordId` | `serviceId` | yes |
| `capture_count` | SegmentationResult (minus regions) | `attemptId` | `eventId` | **no — server-only** |
| `segmentation_region` | ClassificationRegion | `regionId` | `attemptId`, `eventId` | **no — server-only** |
| `attempt_calibration` | AnalysisAttempt.overlayObjectId (+ legacy calibration) | `attemptId` | `eventId` | **no — server-only** |
| `menu_item_revision` | MenuItem of a superseded menu version | `revisionItemId` (`<itemId>@v<version>`) | `itemId`, `menuId` | yes |
| `camera_calibration` | CameraCalibration (IT_4) | `calibrationId` | `hallId` | yes |
| `measurement_settings` | MeasurementSettings (IT_4, one per hall) | `hallId` | – | yes |

**IT_4 (2026-10-04, additive, published in place to local `scrap`).** SpacetimeDB
2.10 migrates **appended columns that declare a default** without a wipe
(verified on a throwaway copy, then on `scrap`: existing rows read the default).
So the physical fields are columns, not side tables:

- `food_measurement.physical: Option<PhysicalEstimate>` (default none): calibrationId,
  method, areaCm2, volumeCm3?, meanHeightMm?, maxHeightMm?, depthSettingsVersion?,
  plateReference?, flags. Absent = no compatible calibration (never a zero).
- `analysis_attempt.calibrationId / physicalMethod / depthObjectId` (Options, default
  none): the hall's settings snapshotted per attempt (I9), so activating another
  calibration never rewrites history.
- `camera_calibration` (immutable once `succeeded`/`failed`) and `measurement_settings`.
- `image_object.associationKind` gains `calibration`, `calibration_overlay` (id =
  calibrationId) and `depth` (id = capture eventId or calibrationId); it is a string
  column, so no schema change.

Reducers: `upsert_camera_calibration` (k = knownAreaCm2 / N_ref re-checked; image ids
must be this calibration's registered objects), `upsert_measurement_settings` (the
active calibration must be a succeeded calibration of the same hall), and
`record_analysis` now validates `physical` (known method/flags, the area method has no
volume, a volume method has one) and that the attempt's calibration is succeeded,
every measurement's `physical.calibrationId` equals it, and `depthObjectId` is this
capture's `depth` object. The publish disconnects WebSocket clients (column
additions count as breaking for clients); the backend uses HTTP and the dashboard
does not subscribe, so nothing is affected.

`attempt_calibration` (2026-10-03, additive) holds one row per attempt with a
segmented overlay: `overlayObjectId` (an `image_object` with association kind
`overlay` whose id is the capture's eventId; the JPEG itself is in object
storage). It is written by `record_analysis` in the same transaction as its
attempt, which rejects an overlay id that is not this capture's overlay. Its
`calibration` column (`PlateCalibration`) is **deprecated in v2**: the v2
pipeline does not produce one (no plate-size calibration), so new rows leave
it empty; it stays so the column and any legacy rows keep parsing. A separate table rather than new
`analysis_attempt` columns keeps the change additive.

`menu_item_revision` (2026-10-04, additive) archives the items of superseded
menu versions. `menu_item` holds only the live version of each menu (the
classification vocabulary). When `upsert_menu` stores a higher `menuVersion`
it first copies the outgoing items here (insert-only, keyed
`<itemId>@v<oldVersion>`, with `supersededAt`), so food measurements from
analyses that froze the older version still resolve their itemId to a name.
`upsert_menu` also rejects a `menuVersion` lower than the stored one (no
silent rollback). Items replaced before this table existed are not archived.

Target-dish counting (v2, `target-dish-v1`) needs no schema change: the rule
version is `capture_count.countingRuleVersion`, and the attempt-level flags
`neighbor_food_excluded` / `target_dish_unavailable` are ordinary
`analysis_attempt.qualityFlags` strings.

### Representation choices (schema ⇄ contract mapping)

- **No image bytes, ever.** `image_object` stores provider/container/
  `objectKey` (stable identity), MIME type, size, dimensions, upload state —
  references and metadata only. Bytes live in external object storage;
  temporary read URLs come from the backend API and are never stored.
- **String unions as strings.** `mealLabel`, `source`, `state`, `status`,
  `method`, `qualityFlags` are stored as the contract's literal strings;
  reducers validate them with the pure helpers in `data/` before insert.
  This keeps bindings simple and contract evolution non-breaking.
- **Timestamps** are the contract's UTC ISO 8601 strings verbatim (lossless
  round-trip with the backend repository). `serviceDate` stays a hall-local
  `YYYY-MM-DD` string by design.
- **Maps.** `AnalysisAttempt.baselineVersions` (itemId → frozen version)
  becomes `t.array(BaselineVersionEntry)`; `Insight.metrics` and
  `ApiError.details` become small JSON strings (`metricsJson`,
  `detailsJson`). SpacetimeDB has no map column type; these are tiny text
  values, not blobs.
- **Optionals** use `t.option(...)`, matching the contract's optional fields
  (notably `food_measurement.itemId`: none = unknown/non-menu result, kept
  with its area but excluded from menu percentages).
- **Append-only history.** `reference_portion` rows are versioned inserts
  (never updates) and `analysis_attempt` freezes `menuVersion` +
  `baselineVersions`, so menu/baseline revisions never silently rewrite
  historical results (AGENTS.md 2.5/5.4). A missing baseline is the absence
  of a row — never a zero-area row (§7.1).

## Subscription-visible fields (to confirm with Agents 5 and 7)

Public tables are small records only — safe for subscriptions. The proposed
minimal dashboard subscriptions:

- `meal_service`, `menu_item` — hall/date/meal selection and menu display.
- `food_measurement` + `capture_event` — waste numbers, coverage counts, and
  exclusion counts (quality flags/states travel with the rows).
- `attendance` — simulated label included in the row (`source`).
- `insight` — suggestion text with grounding metadata.

Server-only (private) tables: `image_object` (clients fetch temporary read
URLs via `GET /api/images/:objectId/access`, never subscribe to object keys)
and `analysis_attempt` (dashboard consumes counted measurements, not raw
attempt history; expose later if Agent 7 needs it). No table contains image
bytes, base64, or signed URLs, so no subscription can leak them.

## Swap plan (matches backend/src/repo/repository.ts)

The backend's `Repository` interface was written to map 1:1 onto this schema:

| Repository method | SpacetimeDB operation |
| --- | --- |
| `upsertMenu(bundle)` | reducer `upsert_menu`: upsert `meal_service` row + replace `menu_item` rows for `menuId`; a higher version archives the old items in `menu_item_revision`, a lower one is rejected (callers plan the version with `data/` `planMenuRevision`) |
| `getMenuByService` / `findMenus` / `listServices` | queries on `meal_service` (pk / `hallId`+`serviceDate` indexes) joined to `menu_item` by `menuId` |
| `upsertReferencePortion` / `get` / `list` / `delete` | reducer inserting a **new version** row; queries on `reference_portion` (pk / `itemId` index) |
| `upsertImageObject` / `get` / `list` / `delete` | reducers + queries on `image_object` (`state` index drives orphan cleanup) |
| `upsertCaptureEvent` / `get` / `list` | idempotent-by-`eventId` reducer; queries via `hallId`/`serviceId` indexes |
| `addAnalysisAttempt` / `listAnalysisAttempts` | append-only insert; `eventId` index |
| `addMeasurements` / `listMeasurementsBy*` | batch insert in the same reducer call as its attempt (atomic); `eventId`/`attemptId` indexes |
| `upsertAttendance` / `getAttendance` | first-write-wins reducer on pk `serviceId` |
| `upsertInsight` / `listInsights` | reducer + `hallId` index query |

Rules carried over from the backend placeholder: one mutation method = one
reducer; reads become queries/subscriptions; Gemini calls and object-storage
network I/O stay **outside** reducers (service layer) — reducers only receive
verified object references and validated analysis results.

Agent 5's reducers live in `src/reducers.ts` (importing the schema from
`src/schema.ts`): `upsert_menu`, `upsert_reference_portion`,
`delete_reference_portion`, `upsert_image_object`, `delete_image_object`,
`upsert_capture_event`, `record_analysis` (attempt + measurements, one
transaction), `upsert_attendance` (source must be `simulated`), and
`upsert_insight`. Each takes the contract entity as a JSON string and
re-checks the invariants a bad write would break (§7.1 baseline > 0, finite
non-negative areas, `above_baseline` on fractions > 1). Table definitions
change only through Agent 2.

## Seeds

Demo seed data lives in **`data/seed/demo-seed.json`** (labeled DEMO DATA;
provenance in `data/README.md`): 9 menus (3 days × 3 meals, `hall-main`,
America/Detroit; each dinner is the 26-food factor menu), 99 `manual_area`
reference portions, and 69 demo portions served (dinners). Keeping the seed in
`data/` keeps one source of truth for backend fixtures, analytics, and the
published database.

Load it with `cd backend && npm run seed` (`backend/scripts/seed.mjs`, through
the backend's validated API, so it lands in `scrap` when the backend uses it):

- Each menu is planned with `data/` `planMenuRevision`: a new service is
  created, an identical menu is left alone, and a menu whose items changed
  (the old 5-item dinners in `scrap`) becomes `menuVersion + 1`. Old analyses
  keep the version they froze; the old items move to `menu_item_revision`.
- Demo portions are saved as a replacement snapshot for each dinner's
  **current** version.
- `--live-dinner[=YYYY-MM-DD]` also seeds the 26-food dinner plus demo portions
  for that hall-local date (default: today in America/Detroit) so live camera
  captures resolve to `svc_hall-main_<date>_dinner`.
- IT_4: creates default `measurement_settings` (depth off, no calibration,
  plate 1.5 cm) for each seeded hall that has none; an existing row is kept.
- Idempotent: a second run creates and revises nothing.

`scrap` after `npm run seed -- --live-dinner=2026-10-04` (2026-10-04): 10
services (2026-10-01..03 × 3 meals + the 10-04 dinner), 122 menu items, 13
archived items, 92 demo portions, and the 6 earlier captures with their
attempts, measurements and image objects unchanged.

## Assumptions / open items

- TypeScript module language (above) — needs Agent 1's entry in
  `contracts/decisions.md`.
- Private vs public table split is a proposal; Agents 5/7 confirm before the
  dashboard subscribes.
- `sizeBytes` is `u64` (bigint in bindings). `food_measurement.remainingAreaPx`
  is `f64` because legacy Gemini-estimated rows may be fractional; v2 mask
  counts written there are integers (`capture_count` / `segmentation_region`
  use `u32`).
- Local `spacetime start` is the dev target; the hosted/maincloud decision is
  an Agent 1 open question.
