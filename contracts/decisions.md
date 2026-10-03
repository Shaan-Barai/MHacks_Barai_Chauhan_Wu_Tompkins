# Decisions and open questions

Owner: Agent 1 (coordinator). Decisions here gate dependent implementation
(AGENTS.md §10). Provisional items are explicitly labeled and may change when
pending details arrive; agreed items came from the team or AGENTS.md.

## Agreed

- **Storage architecture:** SpacetimeDB for application records + external
  object storage for image bytes (AGENTS.md §2). No image bytes/base64 in
  SpacetimeDB tables or subscriptions.
- **Object-storage provider: Cloudflare R2** (team decision, 2026-10-03).
  Private bucket; backend `R2Storage` (S3 API via `@aws-sdk/client-s3`,
  endpoint `https://<account>.r2.cloudflarestorage.com`, region `auto`,
  path-style). Uploads use presigned PUT URLs signed over Content-Type and
  Content-Length (15 min default); finalize verifies with HeadObject; reads
  use presigned GET URLs (10 min default); analysis reads bytes server-side.
  Credentials (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`)
  never leave the server. `local-dev` stays as the offline/test adapter.
  Browser CORS policy for direct upload/display: `backend/r2-cors.json`.
  Retention: unfinalized uploads older than `ORPHAN_MAX_AGE_SECONDS` are
  removable via `POST /api/images/cleanup-orphans`; finalized images are kept.
- **Vision provider:** Gemini API for classification and pixel-area estimates.
  No custom model training.
- **Frontend:** React + Tailwind, "Kitchen Garden" palette mapped to Tailwind
  theme tokens, single-dashboard layout per `UI.md`. All mock data in one file
  so it can be swapped for live queries later.
- **Terminology:** UI "waste units" = observed estimated leftover area
  (pixels). See `contracts/README.md`.
- **Workflow:** commit and push incrementally to `main`; PRs are resolved
  automatically by the agents (confirmed in workspace chat, 2026-10-03).

## Provisional (labeled, revisit when details arrive)

- **Frontend tooling:** Vite + React 18 + TypeScript + Tailwind.
- **Backend:** Node.js 20+, TypeScript, Express. Smallest setup that can host
  the storage adapter, Gemini gateway, and REST API.
- **SpacetimeDB module language: TypeScript** (`spacetimedb@2.10.2`), chosen by
  Agent 2 over the earlier conditional Rust default — v2.10.2 supports TS
  modules and the whole team stack is TS. Compile-, publish-, and
  table-verified against a local `spacetime start` server (see `db/README.md`).
  Supersedes the previous provisional entry.
- **`menuId` is per hall + local date + meal** (e.g.
  `menu_hall-main_2026-10-03_lunch`), not per date: `MenuItem` joins by
  `menuId` alone, so a per-date ID could not resolve per-service item lists.
  `contracts/samples.json` updated accordingly. Older per-date strings inside
  module-local test fixtures are internally consistent and unaffected.
- **Gemini model:** `gemini-3.8-flash` via the official `@google/genai` SDK,
  server-side only. `gemini-2.5-flash` is no longer offered to new API keys
  (the API answered 404 "no longer available to new users" on 2026-10-03).
  Short text requests (suggestions) run with `thinkingBudget: 0` because
  thinking tokens count against `maxOutputTokens` and truncated answers;
  image classification keeps the model's default thinking.
- **Live Gemini smoke test: PASSED 2026-10-03**, model `gemini-3.8-flash`
  (`cd vision && npm run smoke`): live mode, text generation, untruncated
  short tip, `analyzeCapture` on a synthetic top-down plate against the
  demo-seed menu (contract-valid, `ai_estimate`-flagged), and a bad key →
  `GEMINI_AUTH_FAILED` with no retry. Synthetic images only — not evidence of
  real-world measurement accuracy.
- **Above-baseline handling:** an above-baseline item is flagged
  (`above_baseline` on the measurement and the attempt) and excluded from
  aggregates by that flag, but the attempt stays `succeeded` so the plate's
  other valid items still count (AGENTS.md §7.2 excludes the value, not the
  plate). Ambiguous plates still go to `needs_review`.
- **SpacetimeDB integration (local):** `spacetime` CLI 2.10.2, database
  `scrap` on `spacetime start` (127.0.0.1:3000). Module entry
  `db/spacetimedb/src/index.ts` (Agent 1 assembly) re-exports `schema.ts`
  (Agent 2 tables) and `reducers.ts` (Agent 5, one reducer per Repository
  mutation, contract entities passed as JSON strings). The backend uses
  `SpacetimeRepository` (reducer calls + SQL over the HTTP API) when
  `SPACETIMEDB_URI` is set, authenticating as the module-owner identity
  (`SPACETIMEDB_TOKEN`) so it can read the private tables; otherwise it falls
  back to the in-memory/JSON repository (tests, fixture-only machines).
  No generated client bindings are committed: the dashboard reads through the
  backend API, not subscriptions, so nothing consumes them yet.
- **Cross-package code:** the backend depends on `data`, `vision`, and
  `analytics` through `file:` dependencies; `npm run build` in `backend/`
  builds them first (`backend/scripts/build-deps.mjs`). No root workspace.
- **Dashboard read models:** `GET /api/dashboard/{daily,cards,meal}` compute
  everything with `analytics/` (summaries, item shares, attendance, insights).
  The UI's "waste units" = 1,000 px² of observed estimated leftover area
  (`frontend/src/data/liveApi.ts` `PX_PER_WASTE_UNIT`). The older
  `GET /api/dashboard/summary` (backend `SummaryService`) is kept for API
  compatibility; both implement §7 and are checked against hand calculations.
- **Simulated attendance** is generated on first dashboard read of a service
  (analytics `generateAttendance`) and persisted once — never re-rolled.
- **Suggestions** are generated on dashboard read when the service's data
  version changes and stored as `Insight` rows. A stored `fallback_rules`
  insight is retried with Gemini on the next read; Gemini insights are reused.
- **Demo replay images** are AI-generated (`gemini-3.1-flash-image`) synthetic
  plates — no real diners or halls (`capture/fixtures/replay/README.md`).
- **Deployment:** local-only demo (SpacetimeDB standalone + backend + Vite dev
  server on one machine).
- **Object storage (offline):** the `local-dev` filesystem adapter remains for
  tests and machines without R2 credentials (`OBJECT_STORAGE_PROVIDER=local-dev`).
- **Hall timezone:** `America/Detroit` (MHacks/UMich) until a hall config says
  otherwise.
- **Simulated attendance bounds:** 300–1,200 per service (AGENTS.md 6.2),
  configurable via env.

## Open questions

- R2 account/bucket provisioning for the team and a long-term retention
  policy for finalized images (currently kept indefinitely).
- Camera hardware, capture trigger, conveyor conditions, plate sizes.
- Menu upload CSV column format and the mock "menu API" response shape
  (UI.md setup step 2).
- How uneaten reference areas are supplied and reviewed for real menus.
- Gemini rate limits and production timeout/retry budget (key provisioned;
  defaults 30 s timeout, 2 retries).
- Hosted deployment (maincloud or other) if the demo must run off one laptop.
- Reference-area calibration: the demo-seed `manual_area` baselines are
  hand-assigned, and live Gemini often estimates leftovers above them on the
  synthetic plates (flagged `above_baseline`, excluded). Real baselines need
  reference photos or measured portions.
