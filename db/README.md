# db — SpacetimeDB schema (Agent 2)

Table definitions, schema evolution, and seed definitions for the Scrap
prototype (AGENTS.md 2.4). Reducer/procedure implementations belong to
Agent 5; shared module assembly and generated client bindings to Agent 1.

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

# create/update the database
spacetime publish --module-path . --server local scrap
# (the backend must be the publishing identity — see root README setup step 3)

# client bindings (Agent 1 decides the committed location)
spacetime generate --lang typescript --out-dir ../../frontend/src/module_bindings --module-path .

# sanity checks
spacetime sql --server local scrap "SELECT * FROM meal_service"
spacetime logs --server local scrap
```

Schema changes: additive changes (new tables, new optional columns) publish
in place; breaking changes need `spacetime publish -c on-conflict` (destroys
data) or a migration plan. For the hackathon, re-publish + re-seed from
`data/seed/demo-seed.json` is the agreed recovery path.

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
| `attempt_calibration` | AnalysisAttempt.calibration + overlayObjectId (BIG-PLAN D2/D7) | `attemptId` | `eventId` | **no — server-only** |

`attempt_calibration` (2026-10-03, additive) holds one row per attempt that
reported a `PlateCalibration` and/or a segmented overlay: `calibration`
(`method`, `plateDiameterCm`, `plateDiameterPx`, `cm2PerPx`, `dishType?`,
`fullyVisible?`, `flags`) and `overlayObjectId` (an `image_object` with
association kind `overlay` whose id is the capture's eventId; the JPEG itself
is in object storage). It is written by `record_analysis` in the same
transaction as its attempt, which rejects `cm2PerPx` ≠ (cm/px)², unknown
methods/flags, a `configured-default` without `calibration_default`, and an
overlay id that is not this capture's overlay. Grams/impact are never stored
(D3). A separate table rather than new `analysis_attempt` columns keeps the
change additive (publishes in place over existing rows). The BIG-PLAN demo
database is `scrap-bigplan`.

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
| `upsertMenu(bundle)` | reducer: upsert `meal_service` row + replace `menu_item` rows for `menuId` (validate + version with `data/` `planMenuRevision`) |
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
America/Detroit) and 45 `manual_area` reference portions in the shared
1024×1024 `topdown-normalized-v1` geometry. Load it through Agent 5's
validated upload path (`POST /api/menus`, `POST /api/reference-portions`) or,
once reducers exist, a `seed_demo_data` reducer that replays the same JSON.
Keeping the seed in `data/` keeps one source of truth for backend fixtures,
analytics, and the published database.

## Assumptions / open items

- TypeScript module language (above) — needs Agent 1's entry in
  `contracts/decisions.md`.
- Private vs public table split is a proposal; Agents 5/7 confirm before the
  dashboard subscribes.
- `sizeBytes` is `u64` (bigint in bindings); all pixel areas are `f64`
  because Gemini estimates may be fractional.
- Local `spacetime start` is the dev target; the hosted/maincloud decision is
  an Agent 1 open question.
