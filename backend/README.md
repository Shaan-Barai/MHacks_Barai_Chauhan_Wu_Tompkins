# backend

Owner: Agent 5 — REST API, object-storage adapter, persistence orchestration.
Built against `contracts/` (types verbatim) and AGENTS.md §5.5/§6/§7.

Self-contained Node 20+ / TypeScript / Express package. No root files are
touched; dependencies live in `backend/package.json` only.

## Run

```bash
cd backend
npm install
npm start          # build + run; default http://localhost:8787
npm test           # build + node --test (13 tests)
```

## Environment (see root `.env.example`; all server-side, no secrets in code)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | API port |
| `OBJECT_STORAGE_PROVIDER` | `local-dev` | Only `local-dev` implemented until a provider is chosen |
| `OBJECT_STORAGE_CONTAINER` | `scrap-images` | Bucket/container name |
| `OBJECT_STORAGE_LOCAL_DIR` | `.local-storage` | local-dev bytes root (gitignored) |
| `UPLOAD_ALLOWED_MIME_TYPES` | `image/jpeg,image/png,image/webp` | Comma-separated allowlist |
| `UPLOAD_MAX_BYTES` | `10485760` | Upload size limit |
| `UPLOAD_URL_TTL_SECONDS` | `900` | Upload-URL expiry |
| `READ_URL_TTL_SECONDS` | `600` | Read-URL expiry |
| `ORPHAN_MAX_AGE_SECONDS` | `3600` | Age after which unfinalized uploads count as orphans |
| `BACKEND_DATA_FILE` | *(unset = in-memory)* | Optional JSON snapshot file for the placeholder repository |
| `ATTENDANCE_MIN/MAX/SEED` | `300`/`1200`/– | Passed through for Agent 6's generator |

`GEMINI_*` and `SPACETIMEDB_*` from `.env.example` belong to Agent 4 and the
future SpacetimeDB integration; this package does not read them yet.

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

## Persistence: PLACEHOLDER for SpacetimeDB (swap plan)

Agent 2's SpacetimeDB schema does not exist yet. `src/repo/repository.ts`
defines the repository interface — record shapes verbatim from
`contracts/types.ts` — and `src/repo/jsonFileRepository.ts` implements it
in-memory (optional JSON snapshots via `BACKEND_DATA_FILE`). When the schema
lands:

1. Each mutation method maps to one reducer (Agent 5 owns reducer sources);
   each read maps to a query/subscription.
2. Only the `Repository` implementation changes; services and routes do not.
3. Gemini calls and object-storage network I/O already live in service code
   (`ingestionService`, `imageService`) and must stay **outside** transactional
   reducers (AGENTS.md 5.1): reducers only receive verified object references
   and validated analysis results.

## Object storage: `local-dev` adapter

`src/storage/objectStorage.ts` is the provider-neutral interface
(requestUpload → upload → finalize → getReadAccess, plus stat/delete for
orphan cleanup). `localDevStorage.ts` stores bytes under
`OBJECT_STORAGE_LOCAL_DIR/<container>/…` and uses opaque expiring tokens as a
stand-in for presigned URLs. An R2/S3/Supabase/Firebase adapter replaces only
this class once the provider decision lands (contracts/decisions.md); the
two-step register/finalize orchestration in `imageService.ts` is provider-
independent.

## Assumptions (recorded per working rule 5)

- Menu upload body is the `MenuBundle` JSON shape above; Agent 2's richer
  parsing/validation helpers will replace the basic shape checks in
  `src/services/validation.ts` when they exist.
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

- Swap `JsonFileRepository` for SpacetimeDB reducers/queries (blocked on Agent 2).
- Real object-storage provider adapter + CORS for browser direct upload
  (blocked on provider decision).
- Wire Agent 4's real Gemini analyzer and Agent 6's analytics/suggestion and
  attendance-generation services in place of the mock/stubs.
