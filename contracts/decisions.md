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
- **Vision flow (updated 2026-10-03):** Gemini API for food classification
  first, then a separate segmentation-mask stage, then foreground pixel
  counting in application code. The planned segmentation model is Meta SAM 2.1;
  [MVP_AI.md](../MVP_AI.md) proposes SAM 2.1 Small with Gemini boxes for initial
  evaluation. Exact checkpoint/host selection remains provisional. SAM 3
  implementation and evaluation are deferred. No custom model training.
- **Frontend:** React + Tailwind, "Kitchen Garden" palette mapped to Tailwind
  theme tokens, single-dashboard layout per `UI.md`. All mock data in one file
  so it can be swapped for live queries later.
- **Primary metric (updated 2026-10-03): Pixels wasted**, the integer count
  of foreground pixels in validated leftover-food masks in the shared
  normalized geometry. This supersedes primary percentages, servings, piece
  counts, and numeric area guesses. The current UI's "waste units" scaling
  is legacy implementation behavior. See `contracts/measurement.md`.
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

- Exact Meta SAM checkpoint, execution host, localization method, mask
  serialization/alignment, processing settings, and quality criteria. The
  [MVP AI plan](../MVP_AI.md) proposes initial choices, pending evaluation.
- Coordinated migration of shared types, vision, persistence, analytics,
  fixtures, and dashboards from scalar estimates to mask provenance/counts.
- The earlier conditional mean-percentage recommendation request remains
  auxiliary; define its compatible reference denominator before implementing
  it. It does not gate the primary pixel metric.

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

## 2026-10-03: portions served and recommendation benchmark

- User request: normalize waste by the number of portions served for each food,
  and use **Pixels wasted per portion** for recommendations. Raw Pixels wasted
  stays the primary measured quantity; the rate does not prove dislike/causes.
- Prototype input decision: manual per-meal entry and a downloadable CSV
  template (`service_id,menu_version,item_id,portions_served`). Existing-system
  integrations are deferred until their source/API is known. Counts represent
  actual full-service portions served, including seconds; serving definitions
  must be consistent. Do not use attendance, prepared amounts, plate counts,
  or uneaten baselines as this denominator.
- Persist replacement snapshots per service/menu version/item ID, with source
  and update timestamp. Blank means missing; 0 means none served and makes the
  rate unavailable. Validate an entire batch before any write. Retain previous
  menu versions; refuse stale imports. Re-import/retry never adds counts.
- Additive contract: `PortionsServed`, `MaskPixelCount`, and the optional
  `FoodMeasurement.maskCount` with `method: mask_pixel_count`. The mask metadata
  is small provenance, not image bytes. Exclusive attribution must be established
  by vision before counting; decoding, serialization, SAM host/checkpoint, and
  inference are still pending. Legacy estimated areas cannot enter the new rate.
- Implementation in the root application (`frontend/`, `backend/`, `data/`,
  `analytics/`, `db/spacetimedb/`): portion entry/CSV, both persistence adapters,
  downstream mask-count calculator, ranked benchmarks and cached recommendations.
  The separate `mhacks/` preview is outside this feature's runtime scope.
- Recommendations use available rates, show missing items and coverage, and
  invalidate when counts/sources/menu/measurements change. Until mask data exists,
  return an input/setup action instead of ranking legacy area estimates. Simulated
  attendance remains separate. Incompatible capture geometries make the benchmark
  unavailable; selecting geometry groups is future UI work.
- One agent filled the contract, schema, backend, analytics, UI, and verification
  roles sequentially for this request. No parallel writers or dependencies added.
- Open: actual serving-system source, consistent portion sizes, representative
  capture coverage, and the separate pending segmentation integration. Across
  compatible service windows use sum(pixels)/sum(portions), not the mean of rates.

## 2026-10-03: classification first, mask-counted Pixels wasted

- The user's latest measurement decision is **Gemini CLASSIFICATION →
  SEGMENTATION MASK → code-counted Pixels wasted**. Quantity must come from
  the validated mask, not Gemini's guessed pixel count, piece count, or
  serving percentage. Separate stage failures and metadata remain visible.
- Per-food counts use assigned foreground pixels; per-capture totals count
  their union, and reporting totals include each capture once. Normalized
  dimensions and plate geometry must be compatible; unknown edible leftovers
  remain in an unclassified bucket and non-food pixels are excluded.
- Uneaten baselines are auxiliary. Missing or exceeded baselines do not
  prevent otherwise valid mask-derived pixel totals. Failed/missing masks
  are unavailable; a validated empty mask establishes a zero-pixel capture.
- Store mask assets in external object storage if retained, with durable
  references and small count/provenance records in SpacetimeDB.
- Camera placement/conveyor integration remain deferred; use uploaded or
  replayed images for the current prototype.
- This assignment updates context only. Existing Gemini scalar-area and
  countable/uncountable assessment paths, runtime types, and dashboard
  calculations are not migrated by this change. Previous smoke/evaluation
  results do not verify the proposed segmentation/counting pipeline.

## 2026-10-03: future DepthAnythingV2 volume extension

- The user requests a future volume-data extension documented in root `AI.md`:
  classify food, obtain segmentation masks, estimate per-pixel depth with
  DepthAnythingV2, then integrate food height above the plate over physical
  area to estimate leftover volume.
- Depth and volume are deferred explicitly. Pixels wasted remains the current
  primary metric. This assignment adds documentation only; no model weights,
  dependencies, inference code, runtime contracts, or volume fields are added.
- Metric depth or validated scale calibration, empty-plate geometry, camera
  calibration, mask/depth alignment, and volume validation are prerequisites
  for implementation. Their exact setup and checkpoint remain open.

## 2026-10-03: Meta SAM segmentation and localization plan

- The user requests a Meta SAM segmentation plan and bounding-box model
  research. Root [MVP_AI.md](../MVP_AI.md) records the proposal and sources.
- Proposed first evaluation: Gemini classification plus boxes → SAM 2.1
  Hiera Small masks → validated code-counted Pixels wasted. Grounding DINO is
  the first dedicated detector to compare if Gemini localization is inadequate;
  YOLO-World is a speed-oriented alternative.
- Model choice, runtime host, and quality thresholds remain provisional.
  Compare manual-box segmentation with the complete path on annotated dish
  images before selecting the implementation. No food accuracy is established.
- This assignment adds planning/context documentation only. No model weights,
  packages, inference code, runtime-contract migration, or depth/volume work
  are implemented.

## 2026-10-03: defer SAM 3

- The user explicitly excludes SAM 3 for now because of setup complexity.
  Remove SAM 3 from the MVP alternatives, evaluation phases, and implementation
  plan. Its previously proposed text-prompt route is superseded.
- The MVP remains Gemini classification and boxes → SAM 2.1 Small masks →
  code-counted Pixels wasted. Grounding DINO and YOLO-World remain optional
  bounding-box alternatives. No SAM 3 setup, downloads, or evaluation are in
  the current scope.

## 2026-10-03: SAM 2.1 mask pipeline implemented

Executes [MVP_AI.md](../MVP_AI.md) steps 1, 4, 5 and a preliminary 2–3.
Choices the plan left open, now made (provisional until the annotated
evaluation and team thresholds):

- **Checkpoint / host:** `facebook/sam2.1-hiera-small` (SAM 2.1 Small), Meta
  `sam2` at `2b90b9f`, torch 2.14.1, on the team MacBook M1 Max via MPS
  (CPU fallback). Worker: `vision/sam/worker.py` (Python, stdlib HTTP,
  127.0.0.1:8790), one serialized predictor. Gemini stays in the TS gateway.
- **Localization:** Gemini (`gemini-3.8-flash`, prompt `scrap-localize-v1`)
  returns menu item IDs or `unknown`, a visual label, and one or more
  `[ymin, xmin, ymax, xmax]` 0–1000 boxes per item, plus explicit
  `plateEmpty`/`ambiguous`. No quantities are requested. Grounding DINO was
  not needed for the images tested; revisit if localization dominates errors.
- **Box conversion:** `gemini-yxyx-1000_to_xyxy-px_v1` — `[xmin·W/1000,
  ymin·H/1000, xmax·W/1000, ymax·H/1000]`; nonfinite, out-of-range,
  reversed, and sub-pixel boxes fail their region. Both forms are stored.
- **Mask settings `sam2-box-v1`:** `multimask_output=False`, logit threshold
  0.0, no hole filling or small-component removal. **Format:** lossless
  8-bit PNG at the analyzed image's exact size, 255 food / 0 background;
  rejected unless exactly that size and strictly binary.
- **Counting rule `union-v1`:** item pixels = union of that item's regions;
  a pixel claimed by two different items goes to the unclassified bucket and
  the capture is flagged `overlapping_masks`; unknown-food regions feed the
  unclassified bucket; capture total = union of all valid masks = sum of
  item + unclassified counts (enforced by the backend and the SpacetimeDB
  reducer).
- **Stage outcomes:** classification failure → attempt `failed`, nothing
  counted. Explicit `plateEmpty` → `succeeded`, count status `empty`, 0
  pixels (no SAM call). Some regions fail → `needs_review`, `partial`
  (lower bound, excluded from totals). All segmentation fails / worker down
  → `failed`, retryable, never zero. There is no fallback to Gemini-guessed
  areas; the legacy `GeminiAnalyzer` was removed.
- **Contracts:** `AnalysisAttempt.segmentation` (`SegmentationResult` with
  `ClassificationRegion[]`), `MeasurementMethod` `mask_pixel_count`,
  `FoodMeasurement.regionIds`, image association kind `mask`, quality flags
  `segmentation_failed` / `overlapping_masks`. All additive; legacy
  attempts stay readable and are excluded from pixel totals as
  `legacy_estimate`.
- **Persistence:** additive SpacetimeDB tables `capture_count` (stage
  provenance + union count) and `segmentation_region` (boxes, status, mask
  object id); published in place. Masks are stored through the backend's
  storage adapter (`masks/<date>/<regionId>.png`, R2 or local-dev) — never in
  rows.
- **Analytics/dashboard:** `summarizePixels` counts captures with
  `complete` or `empty` counts once each; exclusions by reason; geometry
  groups not pooled. Dashboard API and UI report **Pixels wasted** in pixels;
  the "waste units" ÷1,000 scaling is gone. Suggestions cite measured pixels
  (`suggest-pixels-v1`).
- **Integration with portions served (merge of `main`, 2026-10-03):** the
  method is named `mask_pixel_count` (one name for both features). Vision
  returns one exclusive mask per measurement (the pixels `union-v1` assigned
  to that item or to the unclassified bucket, so masks are disjoint and sum to
  the capture union). The backend stores each PNG
  (`masks/<date>/<measurementId>.png`) and fills `FoodMeasurement.maskCount`
  (classification `model/prompt`, segmentation `model/checkpoint/settings`,
  processing `union-v1`). Ingestion validates count provenance; quality-flag
  eligibility stays an aggregation-time decision. The dashboard tip is the
  Pixels-wasted-per-portion recommendation (AGENTS.md 7); `summarizePixels`
  still drives totals, items, and coverage.
- **Still open:** the annotated 20–30-image evaluation set and held-out split
  (step 2); acceptable error/latency thresholds; point-prompt refinement
  policy; a second detector only if localization errors dominate.
