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
# live SpacetimeDB check (per-run ids; demo data untouched):
set -a; . ../.env; set +a; npm test   # runs test/spacetimeRepository.live.test.ts too
npm run seed       # load data/seed/demo-seed.json through the API (backend running)
```

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
| `SPACETIMEDB_MODULE` | `scrap` | Database name |
| `SPACETIMEDB_TOKEN` | – | Bearer token of the identity that published the module (reads private tables) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | *(unset = mock analyzer)* | Read by `@scrap/vision`; set ⇒ live Gemini analysis and suggestions |
| `BACKEND_DATA_FILE` | *(unset = in-memory)* | Optional JSON snapshot file for the offline repository |
| `ATTENDANCE_MIN/MAX/SEED` | `300`/`1200`/– | Passed through for Agent 6's generator |

`npm start` loads the repo-root `.env` (real environment variables win).

## Endpoints

Every error returns the shared envelope `{ "error": { code, message, details?, retryable } }`
(contracts `ApiError`) with a matching HTTP status.

### Menus
- `POST /api/menus` — upload a validated menu bundle.
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

### Dashboard read models (formulas from `@scrap/analytics`)
- `GET /api/dashboard/daily?hallId=…&start=…&end=…` — per local date: eligible `observedRemainingAreaPx` (null = no analyzed plate), captured/analyzed dishes.
- `GET /api/dashboard/cards?hallId=…&today=…` — today / this week (Mon start) / this month totals and the same-length previous window (null = no data).
- `GET /api/dashboard/meal?hallId=…&date=…&meal=…` — analytics `ServiceSummary`, the persisted simulated attendance (generated once on first read), and an `Insight` (Gemini, or labeled `fallback_rules`; null when no item counted). Insights are stored per data version; a stored fallback is retried with Gemini.

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

`GeminiAnalyzer` (`src/analysis/geminiAnalyzer.ts`) adapts `@scrap/vision`'s
`analyzeCapture` to the `Analyzer` seam and is used when the Gemini gateway is
live; otherwise the deterministic `MockAnalyzer` runs. Mock gateway text is
never used for suggestions.

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
