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
  [MVP_AI.md](../docs/plans/MVP_AI.md) proposes SAM 2.1 Small with Gemini boxes for initial
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
  [MVP AI plan](../docs/plans/MVP_AI.md) proposes initial choices, pending evaluation.
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

- The user requests a future volume-data extension documented in `docs/plans/AI.md`:
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
  research. Root [MVP_AI.md](../docs/plans/MVP_AI.md) records the proposal and sources.
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

## 2026-10-03: monochrome MVP dashboard

- The user requests a simpler MVP look: black, white, and Times New Roman
  everywhere. This supersedes UI.md's "Kitchen Garden" palette and the
  Inter/Fraunces fonts. Greys remain for borders, secondary text, disabled
  controls, and the medium severity dot.
- Implemented by remapping the existing Tailwind tokens, so component class
  names are unchanged. Severity dots are outlined so the white "low" dot shows.

## 2026-10-03: Uno Q capture without OpenCV

- The user requests removal of the Arduino camera's OpenCV dependency.
  Both manual Enter/`--once` and automatic capture now use the shared FFmpeg
  native-MJPEG reader plus Python's standard library. The camera must support
  MJPEG; actual dimensions are read from the JPEG header.
- Manual capture still warms up for each new request and caches the validated
  JPEG/metadata bundle by capture ID. Interrupted transfers reuse cached bytes
  without recapturing. Empty/malformed packets remain explicit failures.
- Setup uses `python3 ffmpeg v4l-utils usbutils` on the Uno Q. Copy the updated
  board script again when upgrading. No application contracts, storage flow,
  or dish-tracking behavior change. See [the capture guide](../capture/uno-q/README.md)
  and [FFmpeg's Linux camera reference](https://ffmpeg.org/ffmpeg-devices.html#video4linux2_002c-v4l2).
- Verification uses simulated FFmpeg/SSH with OpenCV imports blocked. The
  previous automatic hardware smoke check does not verify the new manual path.

## 2026-10-03: ScrapSaver, simpler dashboard for kitchen staff

User-directed changes (UI.md has the full spec):
- Product name is **ScrapSaver**. Pure black and white, Times New Roman.
- Plain-language copy with no technical terms, em dashes, emoji, or listed
  filler words. The menu "API" connector and the closing setup card are removed.
- Dashboard: daily chart only; lookback presets Today / 7 / 30 / 90 days only.
- The right-hand panel is gone. Day details and suggestions move to a new
  **Schedule** tab (click a calendar day).
- New **Behind the scenes** tab shows every plate photo with its labels
  (`GET /api/dashboard/plates`; photos via the existing temporary read links).
- Settings hold several meal-time sets by weekday plus special events
  (browser storage only for now; not sent to the backend).
- Summary cards add **average plate waste percent**: per plate,
  `sum(min(leftover, full serving)) / sum(full serving)` over known menu foods
  with a reference serving; a scanned plate with no leftovers is 0%; a food
  above a full serving counts as 100%; unknown food is ignored; failed plates
  are excluded, not 0%. Auxiliary AI-estimated percent; Pixels wasted stays the
  primary measurement. Formula in `analytics/src/plateWaste.ts`.
- Suggestions: per-portion rates still rank suggestions when they exist. Until
  validated mask counts exist, the meal endpoint falls back to the
  waste-share suggestion (`generateInsight`) so each meal gets a usable tip.
  Prompts and fallback text use plain words for kitchen staff.
- Item names: when a menu no longer lists a measured item (for example after a
  menu edit), display a readable name derived from its stable ID.

## 2026-10-03: Uno Q camera bridge counts each dish once

- `capture/scripts/ingest-inbox.mjs` ingests `images/arduino-inbox/` captures
  as `source: 'camera'`. Frames are grouped into dishes before anything is
  uploaded; one representative frame per dish becomes one `CaptureEvent`.
- Same-dish decisions: an RGB pre-filter (`prefilter-v1`, mean absolute
  difference < 4/255) for unchanged frames, otherwise Gemini via the additive
  `POST /api/dish-match` contract (`DishMatchRequest` / `DishMatchResult`,
  prompt `dish-match-v1`). `unsure` merges: missing a dish is preferred over
  counting one twice. Without Gemini the bridge pauses; it never guesses.
- Verdicts and minted event IDs persist in gitignored state files, so reruns
  never regroup frames or add dishes. Provisional thresholds (3 s no-plate
  grace, 10 s idle) need tuning on real conveyor footage. Details: BRIDGE.md.

## 2026-10-03: SAM 2.1 mask pipeline implemented

Executes [MVP_AI.md](../docs/plans/MVP_AI.md) steps 1, 4, 5 and a preliminary 2–3.
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

## 2026-10-03: merge of the SAM 2.1 mask pipeline with the ScrapSaver dashboard

- `menu-source-experiment` (mask pipeline, Pixels wasted) merged into the
  `main` line (Uno Q bridge, dish match, ScrapSaver redesign). Both feature
  sets are kept.
- Dashboard API: `DailyPoint` = `pixelsWasted`, `capturedDishes`,
  `countedDishes`, plus main's `plateWastePercents`; `PeriodTotal` =
  `pixelsWasted`, `previousPixelsWasted`, plus main's auxiliary
  `averagePlateWastePercent` / `platesCounted` / `platesWithoutPercent`. The
  meal `summary` is the `PixelServiceSummary`. `GET /api/dashboard/plates`
  stays; its `leftoverPx` is the counted mask pixels for mask measurements.
- Meal suggestion: the Pixels-wasted-per-portion insight when any rate
  exists; otherwise a Pixels-wasted suggestion (`generatePixelInsight`, data
  version `pixel-summary-v1|…`) replaces main's legacy waste-share fallback,
  so tips are never grounded in Gemini-guessed areas. Its fallback text no
  longer uses an em dash.
- Frontend keeps main's ScrapSaver layout and plain-language copy, labels the
  metric **Pixels wasted** (unscaled pixels), and shows clean plates, plates
  not counted, and food not on the menu (unclassified pixels) in day details.

## 2026-10-03: waste impact, waste per portion, images, recommendation (BIG-PLAN.md)

User request (2026-10-03): camera → R2/SpacetimeDB → Gemini + SAM → waste
impact → dashboard. Full plan and tracker: [BIG-PLAN.md](../docs/plans/BIG-PLAN.md).

- **D1 score without nutrition:** `waste_impact_usd_per_kg = 0.19·C + 1.50·W`
  (C kg CO2e/kg, W m³ freshwater/kg, `menu_waste_factors_EastQuad.csv`). Nutrition
  (nutrient-days) moves to `menu_nutrition_factors_EastQuad.csv` and is reported
  separately as "nutrition lost", never added to the score.
- **D2 pixels → grams (estimate):** per-capture `cm²/px = (26.7 /
  plate_diameter_px)²` from the `plate-fit-v1` calibration (Gemini plate box →
  SAM plate mask → rim circle fit), falling back to `PLATE_DIAMETER_PX`
  (flag `calibration_default`); `grams = px × cm²/px × weight_g_per_cm2`.
  This is the independently specified calibration AGENTS.md §2/§7 required;
  grams, CO2e, water and $ are always labeled estimates. Pixels wasted stays
  the raw stored measurement.
- **D3** grams/impact are derived in `analytics` at read time
  (`wasteFactorsVersion` stamp); only pixels + calibration are persisted.
- **D4** menu item ↔ factor row via `factorKey = slug(displayName)`; items
  without a factor show "no impact factor", never zero.
- **D5 waste per portion:** Σ estimated grams ÷ Σ portions served (same
  hall/date/service/menu version), plus pixels and $ per portion. "Foods to
  target" ranks by grams per portion; "Most wasted" by total grams. Missing or
  zero portions ⇒ unavailable.
- **D6** demo dinner menu = the 23 factor-table foods (26 since 2026-10-04: + Halal Rice, Tomatoes, Lettuce; see menu_waste_factors_README.md) with Gemini visible
  descriptions; dummy portions are seeded, source `demo`, labeled.
- **D7** R2 holds photo, per-food masks, and a segmented overlay JPEG per
  capture (`image_object.association.kind = 'overlay'`); dashboard reads via
  short-lived URLs from `GET /api/captures/:id/images`.
- **D8** AI recommendation via the Gemini gateway, grounded in the
  per-portion ranking/totals/impact, citing numbers; labeled rule-based
  fallback; never claims a cause.
- Contract additions: `PlateCalibration`, `WasteFactor`, `NutritionFactor`,
  `WasteImpact`, `PerPortion`, `ItemImpactRow`, `ImpactDashboard`,
  `CaptureListItem`, `SignedImage`, `CaptureImages`, `Recommendation`;
  `AnalysisAttempt.calibration` / `overlayObjectId`; association kind `overlay`.

## 2026-10-04: BIG-PLAN v2: pixels only, relative impact, target-dish counting, `scrap` database

User direction (2026-10-04):

- **No plate-size calibration.** Plates come in several sizes, so a 26.7 cm
  plate fit can't give a reliable scale. `PlateCalibration` /
  `AnalysisAttempt.calibration` are deprecated (kept so legacy rows parse).
  There are no grams, kg CO2e, litres or dollars.
- **Pixels are the headline unit.** Total waste, waste per portion (pixels ÷
  portions served, sum then divide) and most wasted are all in pixels.
- **Relative impact points** (user-chosen option): `points = pixels/1000 ×
  weight_g_per_cm2 × factor`, with `co2Points` (C), `waterPoints` (W) and
  `impactPoints` (0.19·C + 1.50·W). They are unitless, comparable only with
  each other, and always labeled relative. They let beef weigh more than rice.
  `nutritionPoints` (nutrient-days/kg) stays separate and is never in the score.
- **Neighboring plates (target-dish counting).** Each capture counts only the
  dish being scanned. Gemini identifies the target dish (the plate or bowl
  most centered and most fully in frame) and assigns each food box to the
  target or to another dish. Food on other dishes is dropped. As a pixel-level
  safety, the remaining food masks are clipped to the target dish's region
  (SAM mask of the dish, holes filled, slightly dilated). If the dish can't be
  found, nothing is clipped and the attempt carries a flag. A neighboring
  plate gets counted when it is the centered dish in its own capture. The
  bridge's same-dish judgment still makes sure each physical plate is counted
  once.
- **Database:** everything lives in the `scrap` database (additive schema
  publish in place, menu revision for the dinners whose items changed).
  `scrap-bigplan` is retired.

## 2026-10-04: IT_4: production deploy, calibrated area, Depth Anything V2 volume

Full plan and rationale: [IT_4.md](../docs/plans/IT_4.md) §2 (I1–I12). Summary:

- **Physical units via calibration (I1).** A per-camera calibration (user-entered known reference area,
  `reference-area-v1`) plus per-food density factors is the independently specified conversion
  AGENTS.md §2 asked for. Pixels wasted stays the stored raw measurement and is always shown. Grams,
  kg CO2e and litres of water are **estimates**, derived in `analytics` at read time, and `null` (never
  0) without a compatible calibration, factor or density.
- **Calibration (I2/I3).** `k = knownAreaCm2 / N_ref` (cm²/px at the base plane), tied to one camera and
  one resolution. Logitech C920s nominal intrinsics: `f ≈ 1360 px` at 1920 wide (78° diagonal FOV).
  Geometric camera height `f·√k`. With Depth Anything V2 on, `scale = height / DAv2 reference depth`
  and a table plane. Focus must be locked on the C920s.
- **Depth model (I4).** `Depth-Anything-V2-Metric-Indoor-Small-hf` only (Apache-2.0; Base/Large are
  non-commercial), served by `vision/depth/worker.py` on :8791.
- **Volume (I5) / area (I6).** `volume-dav2-v1`: heights above a plate plane fitted to the dish ring
  outside food masks, integrated with per-pixel footprints. `area-calibrated-v1`: `pixels × k`. Bowls
  and liquids flag `bowl_volume_unreliable` and use area for grams.
- **CO2 / water (I7/I8).** volume × `density_g_per_cm3` (new CSV column) or area × `weight_g_per_cm2`
  → grams. `kgCo2e = g/1000 × C`, `L = g × W`. Shown next to each food label and as totals with
  calibrated-plate coverage.
- **Setting (I9).** Per hall `depthEnabled` + `activeCalibrationId`, snapshotted on each analysis
  attempt.
- **Production (I10–I12).** Fly.io: `scrap-api` (backend + built dashboard, one origin) and private
  `scrap-ml` (SAM 2.1 + DAv2 CPU). SpacetimeDB maincloud, R2 prod prefix. Public reads; mutations need
  `SCRAP_INGEST_TOKEN` or an admin passcode session. Custom domain (user is buying it) via `fly certs`.

**Update (2026-10-04, user):** Fly.io is dropped for now. SAM 2.1 and Depth Anything V2 run locally on the Mac, and so does the whole stack (local SpacetimeDB `scrap`, with the backend in production mode serving the dashboard via `deploy/local-up.sh`). The custom domain will later point at it through a Cloudflare Tunnel.

## 2026-10-04: Depth Anything V2 removed (user decision)

The user is not using Depth Anything V2. The depth worker, the depth client, the volume method
(`volume-dav2-v1`), the depth part of calibration, the per-hall depth toggle and plate thickness, the
`density_g_per_cm3` factor column and the `'depth'` image association are all removed. Calibration
stays `reference-area-v1`: known area → cm²/px plus the geometric C920s camera height. Grams =
`areaCm2 × weight_g_per_cm2`; CO2e and water follow from grams. SpacetimeDB columns added for depth
stay in the `scrap` schema (they can't be dropped without a wipe) but are unused and written with
defaults. Legacy rows from the brief depth trial are read as area estimates.

## 2026-10-04: 500-common-foods fallback factor table (user decision)

`menu_waste_factors_500.csv` (500 common dining-hall foods, same columns as the hall table) is a
**fallback**. The hall's own table (`menu_waste_factors_EastQuad.csv`) wins; a menu item it doesn't
cover gets its factors from the 500-food table by exact `factorKey = slug(displayName)`, no fuzzy
matching. Each factor row carries `table: 'east-quad' | 'common-500'`. `ItemImpactRow.factorTable`
tells the dashboard, which labels fallback rows "factors: common foods table". The fallback has no
nutrition rows, so those foods have null nutrition points. Unmatched foods stay "no impact factor",
never 0. Factor version `waste-factors-v5`.

## 2026-10-04: Halal Bros factor table in the main app

`menu_waste_factors_halal_bros.csv` (Halal Bros 2 Go, 810 S State St, Ann Arbor: Halal Chicken, Yellow
Rice, Diced Tomatoes, Shredded Lettuce) was read only by `upload_demo/`. It is now a second restaurant
table in `data/` (`HALAL_BROS_WASTE_FACTORS`, `HALAL_BROS_NUTRITION_FACTORS`), looked up after East Quad
and before the 500-food fallback, so calibrated Halal Bros plates get estimated grams, CO2e and water.
Rows carry `table: 'halal-bros'`; its keys may not overlap another table's. The East Quad dinner seed is
unchanged (`WASTE_FACTORS` stays East Quad only). The restaurant publishes no nutrition data, so the
CSV's nutrition labels remain made-up test values and its g/cm² values unverified estimates. Factor
version `waste-factors-v6`.

## 2026-10-04: End-to-end pipeline ported onto main (main's calibrated design wins)

The `end-to-end-pipeline` work was written against the pixels-only plan. It is ported feature by
feature onto main; where the two disagree, main's IT_4 design wins (calibrated `reference-area-v1`
estimates in grams, kg CO2e and litres, labeled est., null not 0; the ingest-token/admin auth gate;
`geminiCap`; hidden captures; the East Quad → Halal Bros → 500-food factor tables). Ported:

- One ingest path for camera photos: the raw original is uploaded as image kind `'original'` and a
  `scan_info` row (device ID, `timestampBasis` from the laptop clock, never the board clock, SHA-256,
  source name) is written beside the capture. A backend whose `scrap` module lacks
  `upsert_scan_info` logs a warning once and continues; republish the module to store scan rows.
- `POST /api/camera/take-photo` (behind the auth gate and `geminiCap`) and `GET /api/camera/status`
  run `capture/scripts/take-photo.mjs` over key-only SSH (`CAMERA_HOST`, `CAMERA_USER`,
  `CAMERA_SSH_KEY` in `.env`), with a photo quality check (valid JPEG, size, brightness, Laplacian
  sharpness) before upload.
- Sample history: `DEMO_SEED=1` or `POST /api/demo/seed` adds ~14 days of `source: 'demo'` captures in
  `svc_demo_*` services, tracked in `demo_marker`; `POST /api/demo/clear` (`clear_demo_data`) removes
  them with their attendance and visibility rows. Demo portions served use category ranges (pizza
  200–400, entrée 80–200, side/soup 60–150, dessert 50–150; `demo-portions-v2`).
- `GET /api/dashboard/totals` (today/week/month Pixels wasted, plus the estimate line when calibrated
  captures exist). The dashboard ranks foods per portion, by total pixels or by impact points.
- Recommendations `impact-rec-v4` / `impact-rec-v4-physical`: 2–3 bullets, a bullet citing a food's
  number names that food, an earlier/later-half trend fact; saved in `insight`, regenerated with
  `POST /api/recommendation/regenerate`, and on Gemini failure the last saved one is returned with
  `stale: true`.
- Impact points = 0.19 × CO2 points + 1.50 × water points from the unrounded parts.
- Test levels in `tests/`: `test:unit`, `test:integration`, `test:images` (`RUN_LIVE=1`),
  `test:camera` (`RUN_CAMERA=1`), `test:smoke` (Playwright); detection scoring is skipped when
  `ground_truth.csv` is absent. See `docs/testing.md`.

The pixels-only wording of that branch (no cm², everything relative) is superseded by the
calibrated-estimate decisions above; Pixels wasted stays the primary measured metric.

## 2026-10-04 — Dashboard redesign (product owner request)

- Landing page at `/` (ScrapSaver + Get started); dashboard moves to `/dashboard`. Helvetica site-wide.
  Subtitles, helper paragraphs and visible "Loading" text are removed.
- Dashboard: Today / This week. Headline cards and the per-day chart lead with **estimated carbon
  emissions** (kg CO2e, calibrated plates only, "est." badge, "—" when unavailable) instead of pixels.
  New `GET /api/dashboard/impact/daily?start&end[&hallId]` → `{ days: DailyImpactPoint[] }`
  (`contracts/types.ts`; ≤ 366 days). Pixels wasted remain the stored measurement and are shown per
  plate on Behind the scenes and in the per-portion rankings on Statistics.
- The Schedule page is replaced by **Statistics** (Last 30 / 90 days: cards, carbon chart,
  recommendations, foods to target, most wasted, nutrition lost). `/schedule` redirects there.
- The plates gallery moves to Behind the scenes.
- No staff sign-in in the UI. Editors are always shown; the backend still enforces
  `SCRAP_ADMIN_PASSCODE` when set (a 401 opens a passcode prompt). `/admin` is unlisted and unlocks
  inline with the passcode.
