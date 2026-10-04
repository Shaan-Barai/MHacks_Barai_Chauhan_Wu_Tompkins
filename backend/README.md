# backend

Owner: Agent 5 — REST API, object-storage adapter, persistence orchestration.
Built against `contracts/` (types verbatim) and AGENTS.md §5.5/§6/§7.

Self-contained Node 20+ / TypeScript / Express package. No root files are
touched; dependencies live in `backend/package.json` only.

## Run

```bash
cd backend
npm install
npm start          # build (data/vision/analytics first) + run; http://localhost:8787
npm test           # build + node --test (in-memory repo, mock analyzer, offline R2)
# live SpacetimeDB repository check: OPT-IN, writes throwaway hall-t… rows to a
# separate test database (SPACETIMEDB_TEST_MODULE, default scrap-test; never scrap):
set -a; . ../.env; set +a; SCRAP_LIVE_REPO_TEST=1 npm test
npm run seed       # load data/seed/demo-seed.json through the API (backend running):
                   # menus (incl. the 23-food demo dinner), reference portions, and
                   # demo portions served (source "demo"); idempotent
```

### Demo against SpacetimeDB `scrap` + R2 (BIG-PLAN v2)

```bash
# the schema is published additively, in place, to `scrap` by the db owner
# (db/README.md); never --delete-data, never clear `scrap`
# SAM worker in its own terminal (vision/sam/README.md)
.venv/bin/python vision/sam/worker.py
# backend: real .env (R2 + Gemini + token); SPACETIMEDB_MODULE defaults to scrap
cd backend && npm start
# seed menus + demo portions (second terminal)
cd backend && npm run seed
```

`.env` must set `OBJECT_STORAGE_PROVIDER=r2`, the `R2_*` credentials,
`GEMINI_API_KEY`, `SPACETIMEDB_URI=http://127.0.0.1:3000`, and the
`SPACETIMEDB_TOKEN` of the identity that published the module. The live
repository check is opt-in and never touches `scrap`: publish the module to a
throwaway database (e.g. `scrap-test`), then
`SCRAP_LIVE_REPO_TEST=1 node --env-file=../.env --test dist/backend/test/spacetimeRepository.live.test.js`
(after `npm run build`; `SPACETIMEDB_TEST_MODULE` picks the database, default
`scrap-test`; `scrap` and `scrap-bigplan` are refused).

## Environment (see root `.env.example`; all server-side, no secrets in code)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | API port |
| `OBJECT_STORAGE_PROVIDER` | `local-dev` | `r2` (Cloudflare R2) or `local-dev` (offline filesystem) |
| `OBJECT_STORAGE_CONTAINER` | `scrap-images` | R2 bucket name (or local-dev folder) |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | – | R2 API token with Object Read & Write on the bucket (provider `r2`) |
| `R2_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | Override, e.g. EU-jurisdiction buckets |
| `OBJECT_STORAGE_LOCAL_DIR` | `.local-storage` | local-dev bytes root (gitignored) |
| `UPLOAD_ALLOWED_MIME_TYPES` | `image/jpeg,image/png,image/webp` | Comma-separated allowlist |
| `UPLOAD_MAX_BYTES` | `10485760` | Upload size limit |
| `UPLOAD_URL_TTL_SECONDS` | `900` | Upload-URL expiry |
| `READ_URL_TTL_SECONDS` | `600` | Read-URL expiry |
| `ORPHAN_MAX_AGE_SECONDS` | `3600` | Age after which unfinalized uploads count as orphans |
| `SPACETIMEDB_URI` | *(unset = in-memory/JSON)* | SpacetimeDB HTTP API, e.g. `http://127.0.0.1:3000` |
| `SPACETIMEDB_MODULE` | `scrap` | Database name (BIG-PLAN v2: everything lives in `scrap`; never wipe it) |
| `SPACETIMEDB_TOKEN` | – | Bearer token of the identity that published the module (reads private tables) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | *(unset = mock analyzer)* | Read by `@scrap/vision`; set ⇒ live Gemini analysis and suggestions |
| `BACKEND_DATA_FILE` | *(unset = in-memory)* | Optional JSON snapshot file for the offline repository |
| `ATTENDANCE_MIN/MAX/SEED` | `300`/`1200`/– | Passed through for Agent 6's generator |
| `SAM_WORKER_URL` | `http://127.0.0.1:8790` | SAM 2.1 worker (`vision/sam/worker.py`) |

`npm start` loads the repo-root `.env` (real environment variables win).

## Endpoints

Every error returns the shared envelope `{ "error": { code, message, details?, retryable } }`
(contracts `ApiError`) with a matching HTTP status.

### Menus
- `POST /api/menus` — upload a validated menu bundle. A `menuVersion` lower than the stored one is `409 MENU_VERSION_CONFLICT` (`retryable: false`); a higher one is a revision, and the superseded items stay resolvable by id (SpacetimeDB `menu_item_revision`).
  ```json
  { "service": { "serviceId": "svc_hall-main_2026-10-03_lunch", "hallId": "hall-main",
      "hallTimezone": "America/Detroit", "serviceDate": "2026-10-03", "mealLabel": "lunch",
      "menuId": "menu_hall-main_2026-10-03", "menuVersion": 1 },
    "items": [ { "itemId": "item_scrambled-eggs", "menuId": "menu_hall-main_2026-10-03",
                 "displayName": "Scrambled Eggs" } ] }
  ```
- `GET /api/menus?hallId=hall-main&date=2026-10-03[&meal=lunch]` — by hall/date/service.
- `GET /api/menus/by-service/:serviceId`
- `GET /api/services[?hallId=…]`

### Reference portions (CRUD-lite)
- `POST /api/reference-portions` — contract `ReferencePortion` body.
- `GET /api/reference-portions[?itemId=…]`, `GET|DELETE /api/reference-portions/:baselineId`

### Actual portions served
- `GET|PUT /api/portions-served?serviceId&hallId`, `POST /api/portions-served/csv`, `GET /api/portions-served/benchmark` — replacement snapshots per service + menu version. `PUT` bodies may carry `"source": "demo"` (seed only); otherwise counts are `manual`.

### Image uploads (two-step; AGENTS.md 5.7/5.8)
- `POST /api/images/uploads` — authorize: `{ associationKind: "capture"|"reference",
  associationId, mimeType, sizeBytes, widthPx?, heightPx? }` →
  `{ objectId, objectKey, uploadUrl, expiresAt }`. MIME/size validated here.
- `PUT <uploadUrl>` — raw bytes (local-dev stand-in for a presigned PUT).
- `POST /api/images/:objectId/finalize` — verifies the object exists, then flips
  the DB record to `finalized`. **Retryable and idempotent**: before the bytes
  arrive it returns `409 UPLOAD_NOT_COMPLETED (retryable: true)`; repeating it
  after success is a no-op.
- `GET /api/images/:objectId/access` — temporary read URL + `expiresAt`.
  Identity is always provider/container/objectKey, never the URL; URLs are never logged.
- `GET /api/images/orphans[?maxAgeSeconds=…]`, `POST /api/images/cleanup-orphans`
  `{ maxAgeSeconds? }` — track and delete uploads never finalized.

### Captures / observations
- `POST /api/captures` — submit the capture event + geometry after finalize:
  ```json
  { "eventId": "cap_01", "hallId": "hall-main", "serviceId": "svc_hall-main_2026-10-03_lunch",
    "capturedAt": "2026-10-03T16:42:09Z", "imageObjectId": "img_…",
    "geometry": { "widthPx": 1024, "heightPx": 1024, "coordinateSpace": "topdown-normalized-v1" },
    "source": "replay" }
  ```
  **Idempotent by `eventId`**: an already-succeeded event is returned unchanged
  (`200`, `deduplicated: true`); a failed/needs_review event is retried with a
  new appended `AnalysisAttempt` on the same event. States:
  `pending → processing → succeeded | needs_review | failed`.
  The image must be finalized and uploaded for *this* event
  (`IMAGE_ASSOCIATION_MISMATCH` otherwise).
- `POST /api/dish-match` — camera bridge only ([BRIDGE.md](../BRIDGE.md)):
  `{ reference, candidate }`, each `{ mimeType, base64 }` (≤ 400 KB), →
  `{ plateVisible, sameDish?, reason, model, promptVersion }`. Thumbnails are
  never stored or logged. `503 DISH_MATCH_UNAVAILABLE` without a Gemini key;
  `502` for a provider error or unusable answer (never a guessed verdict).
- `GET /api/captures/:eventId` — event + all attempts + counted measurements.
- `GET /api/observations?hallId=…&serviceId=…` — events with their counted
  (latest succeeded attempt) measurements only; superseded attempts are history.

### Attendance
- `GET /api/attendance?serviceId=…` — stored simulated record or `ATTENDANCE_NOT_FOUND`.
- `PUT /api/attendance` — write path for Agent 6's generator; first write per
  service wins (never regenerated per request, AGENTS.md 6.3).

### Dashboard summary (§7)
- `GET /api/dashboard/summary?hallId=…&serviceId=…` → totals (captured/analyzed
  dishes, observed estimated leftover area in pixels, **area-weighted**
  `overallWastePercent = 100 * Σremaining / Σbaseline` — never a mean of item
  percentages), per-item breakdown, **visible exclusion counts** (failed /
  needs-review / pending captures; unknown-item, missing-baseline,
  above-baseline, invalid measurements — excluded, counted, never zero waste),
  and simulated-attendance normalization (`null` + reason when missing/zero).

### Menu uploads (manager flow, parsed by `scrap-data`)
- `POST /api/menus/upload` — typed days (`{ hallId, hallTimezone, days: [{ date, breakfast?, lunch?, dinner? }] }`, data/README "Typed/JSON bundle").
- `POST /api/menus/csv?hallId=…&hallTimezone=…` — `text/csv` body (data/README "CSV").
- Both return `{ results: [{ action: 'create'|'revise'|'unchanged', menu }] }`; re-uploads with changed items bump `menuVersion`.
- `GET /api/menus/days?hallId=…&start=…&end=…` — `{ dates }` that have a menu (Menus calendar).

### Dashboard read models — Pixels wasted (formulas from `@scrap/analytics`)
- `GET /api/dashboard/daily?hallId=…&start=…&end=…` — per local date: `pixelsWasted` (null = no counted plate, 0 = only clean plates), `capturedDishes`, `countedDishes`, and `plateWastePercents` (auxiliary). No grams (BIG-PLAN v2).
- `GET /api/dashboard/cards?hallId=…&today=…` — today / this week (Mon start) / this month `pixelsWasted` and `previousPixelsWasted` for the same-length previous window (null = no data).
- `GET /api/dashboard/meal?hallId=…&date=…&meal=…` — analytics `PixelServiceSummary` (total, per-item pixels and share, unclassified pixels, counted/empty/excluded plates with reasons), the persisted simulated attendance (generated once on first read), and an `Insight` citing measured pixels (Gemini, or labeled `fallback_rules`; null when no food pixels are attributed). Insights are stored per data version; a stored fallback is retried with Gemini.
- `GET /api/dashboard/summary` — legacy baseline-percentage summary (`SummaryService`); auxiliary only.

### Waste impact, plates, recommendation (BIG-PLAN v2: pixels + relative impact points)

`start`/`end` are inclusive local service dates (`YYYY-MM-DD`); a bad or
missing window is `400 INVALID_WINDOW`. **Pixels wasted** is the measurement
and the headline unit. There is no plate calibration and there are no grams,
kg CO2e, litres or dollars. **Relative impact points** are derived at read
time by `@scrap/analytics` from the stored pixels and the factor tables in
`scrap-data`: `points = pixels/1000 × weight_g_per_cm2 × factor` →
`co2Points` (C), `waterPoints` (W), `impactPoints` (0.19·C + 1.50·W);
`nutritionPoints` are separate and never in `impactPoints`. Points are
unitless and only compare foods with each other. A legacy attempt's stored
`calibration` is ignored.

- `GET /api/dashboard/impact?start&end[&hallId]` → contracts `ImpactDashboard`:
  `totals` (pixels + points + capture counts), `targets` ranked by pixels per
  portion (Σ px ÷ Σ portions over the same service/menu version), `mostWasted`
  ranked by total pixels, `coverage` (incl. `capturesWithNeighborFoodExcluded`:
  counted attempts flagged `neighbor_food_excluded` by vision's target-dish
  counting) and `labels: { relativeImpact: true, demoPortions }`. Unknown food
  and foods without a factor keep their pixels; their points are `null` with an
  `unavailableReason` (never 0). With no analyzed capture the totals' points are
  `null` (pixels 0); analyzed clean plates give 0. Only counted (latest
  succeeded) mask measurements enter; portions are the services' current-version
  snapshots.
- `GET /api/captures?start&end[&hallId][&limit]` → `CaptureListItem[]`,
  newest first, default 50, max 200: `pixelsWasted` (`null` for partial or
  failed captures, never zero), per-food `items: [{ itemId, displayName, pixels }]`,
  `hasOverlay`. No grams.
- `GET /api/captures/:eventId/images` → `CaptureImages`: short-lived read URLs
  (`READ_URL_TTL_SECONDS`) for the original photo, the segmented overlay
  (`null` when none was stored), and each per-food mask with its `itemId` and
  display name. Missing objects are `null`/omitted; URLs are never logged.
- `GET /api/recommendation?start&end[&hallId]` → `Recommendation` from
  analytics `generateRecommendation` over the impact dashboard, via the live
  Gemini gateway. Bullets cite dashboard metric strings in pixels, pixels per
  portion, and relative impact points; output with physical units or causal
  claims is rejected. Cached in memory by the dashboard's content hash (`inputVersion`
  comes from analytics); without a key, or on a provider error, the labeled
  rule-based `source: "fallback"` is returned (retried with Gemini after 60 s).

### Suggestions
- `GET /api/suggestions?hallId=…` — serves stored `Insight` records. Generation
  belongs to Agent 6; with none stored this returns
  `404 SUGGESTIONS_UNAVAILABLE (retryable: true)` — the agreed stub.
- `POST /api/suggestions` — write path for Agent 6's suggestion service.

### Misc
- `GET /api/health`

## Interfaces exposed to other agents

- **Agent 3 (capture):** the upload flow above (`/api/images/uploads` → PUT →
  finalize → `/api/captures`).
- **Agent 4 (vision):** `src/analysis/analyzer.ts` — the `Analyzer` seam.
  Ingestion resolves the hall/date/service menu and the latest baseline per
  item, **freezes** menu/baseline versions into the `AnalysisAttempt`, and
  passes a lazy image reader (temporary read access, per AGENTS.md 4.7). A
  deterministic `MockAnalyzer` (fixtures by eventId) ships for tests/demo;
  swap via `buildBackend({ analyzer })` in `src/wiring.ts`.
- **Agent 6 (analytics):** `PUT /api/attendance`, `POST /api/suggestions`, and
  read access to observations; canonical aggregate formulas stay in
  `analytics/` — the §7 summary here is the backend's contract-mandated
  aggregate and should be reconciled with Agent 6's module when it lands.
- **Agent 7 (dashboard):** all GET endpoints; images via
  `/api/images/:objectId/access` (renewable temporary URLs).

## Persistence: SpacetimeDB (with an offline fallback)

`src/repo/repository.ts` is the persistence interface (record shapes verbatim
from `contracts/types.ts`). `wiring.ts` picks:

- `SpacetimeRepository` when `SPACETIMEDB_URI` is set: each mutation calls one
  reducer in `db/spacetimedb/src/reducers.ts` over the HTTP API
  (`/v1/database/<db>/call/<reducer>`, entity passed as JSON); reads are SQL
  (`/v1/database/<db>/sql`). `recordAnalysis(attempt, measurements)` is one
  reducer call, so an attempt and its measurements commit atomically.
- `JsonFileRepository` otherwise (in-memory, optional `BACKEND_DATA_FILE`
  snapshots) — used by the test suite and fixture-only machines.

Gemini calls and object-storage I/O stay in the service layer
(`ingestionService`, `imageService`), never inside reducers (AGENTS.md 5.1).

## Analysis

`MaskAnalyzer` (`src/analysis/maskAnalyzer.ts`) runs the
contracts/measurement.md pipeline through `@scrap/vision`
`analyzeCaptureWithMasks`: Gemini classification + boxes (target dish vs
other dishes, BIG-PLAN v2 V3) → SAM 2.1 worker (`SAM_WORKER_URL`,
`vision/sam/`) → validated masks clipped to the target dish → counted Pixels
wasted. No plate calibration is requested or persisted.
Ingestion stores each mask PNG through the storage adapter
(`masks/<date>/<regionId>.png`, image association kind `mask`), stores the
segmented overlay JPEG when the pipeline returns one
(`overlays/<date>/<eventId>_<attemptId>.jpg`, association
`{ kind: 'overlay', id: eventId }`, referenced by `attempt.overlayObjectId`),
and records the attempt, measurements, `capture_count`,
`segmentation_region`, and `attempt_calibration` (now only the overlay id;
the table name and its legacy calibration column are kept for old rows) in one
reducer call. Any calibration an analyzer still sends is dropped, and a
malformed or unstorable overlay is skipped; neither ever fails a valid pixel
count. Vision quality flags (e.g. `neighbor_food_excluded`) are stored on the
attempt as returned; it re-checks that item + unclassified pixels equal the
capture union. If the worker is down, captures fail retryably — there is no
fallback to Gemini-guessed areas. Without a Gemini key the deterministic
`MockAnalyzer` runs (labeled `mock-segmenter`). Mock gateway text is never
used for suggestions.

## Object storage: Cloudflare R2 (and `local-dev` offline)

`src/storage/objectStorage.ts` is the provider-neutral interface
(`authorizeUpload` → client PUT → `statObject` on finalize → `getReadAccess`,
plus `getObjectBytes` for analysis and `deleteObject` for orphan cleanup).
The two-step register/finalize orchestration in `imageService.ts` is
provider-independent.

- **`R2Storage`** (`OBJECT_STORAGE_PROVIDER=r2`): S3 API against
  `https://<account>.r2.cloudflarestorage.com` (region `auto`, path-style).
  `POST /api/images/uploads` returns a presigned PUT URL signed over
  Content-Type and Content-Length plus the `uploadHeaders` the PUT must send;
  finalize checks the object with HeadObject (`409 UPLOAD_NOT_COMPLETED`
  until it exists); `/access` returns a presigned GET URL; analysis reads the
  bytes server-side. Provider failures surface as retryable
  `502 STORAGE_UNAVAILABLE` without credentials or URLs. Bucket setup:
  create a private bucket, an R2 API token with Object Read & Write on it, and
  — only if a browser will upload or fetch images directly — apply
  `r2-cors.json` (`npx wrangler r2 bucket cors set <bucket> --file r2-cors.json`).
- **`LocalDevStorage`** (`local-dev`): bytes under
  `OBJECT_STORAGE_LOCAL_DIR/<container>/…`, with backend routes
  (`/api/storage/upload|read`) and opaque expiring tokens standing in for
  presigned URLs. Used by tests and offline machines.

## Assumptions (recorded per working rule 5)

- `POST /api/menus` keeps the `MenuBundle` shape check (seed/API clients);
  manager uploads go through `scrap-data` parsers on `/api/menus/upload|csv`.
- Menu revisions: every read model names an item from the current menu, else
  its stored row (current `menu_item`, then the `menu_item_revision`
  archive), else a humanized id (`...dinner_jasmine-rice` → "Jasmine Rice"),
  never the raw id (`ItemNameResolver`). The impact dashboard validates each
  capture against the menu version its counted attempt froze and pairs it with
  that version's portions snapshot, so a revision never drops old captures.
- `PUT /api/attendance` and `POST /api/suggestions` are provisional write
  paths for Agent 6 (first-write-wins attendance); Agent 6 may prefer direct
  service invocation later.
- The counted observation for an event is the **latest succeeded** analysis
  attempt; earlier/failed attempts are preserved as history.
- Orphan ages for `pending_upload` records are tracked in-process; after a
  restart, pending uploads are immediately orphanable (their upload tokens are
  gone anyway). Finalized objects are never touched by cleanup.
- No auth: hackathon prototype on a trusted network, like the rest of the demo.

## Remaining work

- Browser-side image upload/display in the dashboard (R2 CORS policy is ready).
- Reducer-level caller auth if the database is ever exposed beyond the backend.
- Retire `SummaryService` in favor of the analytics summary once API consumers
  move to `/api/dashboard/meal`.
