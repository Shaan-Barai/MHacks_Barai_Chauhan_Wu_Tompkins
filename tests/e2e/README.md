# tests/e2e

Owner: Agent 8 — end-to-end demo flow against a running stack.

## Status

Live HTTP e2e is implemented (`demo-flow.test.mjs`) and **skipped unless
`SCRAP_E2E=1`**, so CI never claims a live path from fixtures alone. Last live
run: 2026-10-03, 5/5 pass (SpacetimeDB + live Gemini).

## Flow

Against a running backend (`API_URL`, default `http://localhost:8787`), using a
fresh `hall-e2e-<timestamp>` so demo numbers are untouched:

1. Upload a dinner menu via `POST /api/menus/upload`; identical re-upload → `unchanged`.
2. Store reference portions.
3. Authorize → (finalize-before-upload refused 409) → PUT bytes → finalize → `POST /api/captures`.
4. Analysis is not `failed`; measurements are `ai_estimate` and only use menu item IDs.
5. Re-submitting the capture is deduplicated; one observation exists.
6. Dashboard meal detail: attendance `simulated` and stable across reads; the
   suggestion's `topItemId` matches the top item (or no tip without counted items).

Restart persistence is checked by hand (docs/runbook.md).

## Scrap v2 live flow (`scrap-live.test.mjs`)

Also skipped unless `SCRAP_E2E=1`. Against a running backend on database **`scrap`** (Gemini key,
`OBJECT_STORAGE_PROVIDER=r2`) plus the SAM worker (`SAM_WORKER_URL`, default `http://127.0.0.1:8790`).
It asserts the v2 rules (BIG-PLAN §7): pixels only, relative impact points, target-dish counting.

1. `GET /api/health` (provider `r2`) and SAM `GET /health`.
2. The dinner service (`SCRAP_E2E_SERVICE`, default `svc_hall-main_2026-10-03_dinner`) exists;
   otherwise `backend/scripts/seed.mjs --live-dinner` runs once.
3. `simulate-camera` writes `SCRAP_E2E_PHOTOS` (1–4, default 3) `test2/` photos into a temp inbox;
   `ingest-inbox --no-dedupe --state-dir <tmp>` runs once → exactly one capture per photo; a rerun
   ingests nothing. (`--no-dedupe` because every simulated photo is a different plate: deterministic
   count, no same-dish Gemini calls. `SCRAP_E2E_DEDUPE=1` uses Gemini grouping instead.)
4. Polls `GET /api/captures/:id` until analysis is terminal: not `failed`, source `replay`, 1024²
   geometry, segmentation with `countingRuleVersion = target-dish-v1`, **no** `attempt.calibration`,
   integer per-food pixels (`mask_pixel_count`) that add up to the capture union when the count is
   complete. Attempts flagged `neighbor_food_excluded` are collected (`SCRAP_E2E_EXPECT_NEIGHBOR=1`
   requires at least one). `GET /api/captures` lists each event once with integer `pixelsWasted` and no
   grams.
5. `GET /api/captures/:id/images` (`CaptureImages`): original + overlay + masks; every read URL
   fetches with HTTP 200 and an image content type (URLs are never printed).
6. With `SPACETIMEDB_URI` set: `capture_event`, `image_object` (provider `r2`, `finalized`,
   association kinds `capture`/`overlay`/`mask`, keys not URLs, no blobs), `analysis_attempt`,
   `attempt_calibration` (overlay id, calibration empty), `capture_count` (`target-dish-v1`) and
   `food_measurement` rows via the SpacetimeDB SQL HTTP API.
7. `GET /api/dashboard/impact` (`ImpactDashboard`): integer pixel total; `co2Points`/`waterPoints`/
   `impactPoints`/`nutritionPoints` numbers or null; no `grams`/`kgCo2e`/`impactUsd` keys;
   `labels.relativeImpact = true`; `mostWasted` ranked by pixels; `targets` ranked by pixels per portion
   (= pixels ÷ portions served); unknown food has no rate; `coverage.capturesWithNeighborFoodExcluded`.
8. `GET /api/recommendation` (`Recommendation`): non-empty text, source `gemini` or `fallback`; the
   fallback text never mentions grams, kg, litres, CO2e or dollars.

```bash
cd tests
SCRAP_E2E=1 npm run test:e2e:scrap   # loads ../.env (SPACETIMEDB_MODULE=scrap); shell vars win
# worktree without ../.env: node --env-file=/path/to/.env --test e2e/scrap-live.test.mjs
# SCRAP_E2E_PHOTO_DIR=<dir> picks the photos; SCRAP_E2E_EVENT_IDS=cap_…,cap_… re-checks an earlier
# run without new captures; SCRAP_E2E_START/END=2026-10-03 pins the dashboard window
```

Last live run: 2026-10-03, as the v1 `bigplan-live.test.mjs` against the retired `scrap-bigplan`
(8/8 after a helper fix; see `docs/verification-report.md`). The v2 version has not run live yet: it
needs the v2 vision/backend code and working Gemini billing.

The real-hardware counterpart is `capture/scripts/live_camera_test.py` (board + C920 + bridge
`--watch`, `source = camera`); this E2E swaps only the board for `simulate-camera` and goes on to
assert the analysis, storage, and dashboard results.

`test:e2e:scrap` uses `node --env-file-if-exists` (Node ≥ 22.9). Always pass test **files** to
`node --test`: `node --test tests/e2e` treats the folder as one script and fails; use
`node --test tests/e2e/*.test.mjs` or the npm scripts.

## IT_4 calibration flow (`calibration-live.test.mjs`)

Skipped unless `SCRAP_E2E=1`; skips itself when the backend has no `/api/settings/measurement`.
`npm run test:e2e:calibration` (loads `../.env`; mutations need `SCRAP_INGEST_TOKEN` in production mode).

1. `simulate-camera --calibrate` with the **synthetic** card fixture → `POST /api/calibrations`:
   `succeeded`, 1024² geometry, `k = knownAreaCm2 / referencePixels`, N_ref within 15% of the drawn
   card, crop-aware fx ≈ 1289.7 px, geometric height ≈ 45 cm; activated with DAv2 off.
2. Depth OFF capture (one `test2/` photo): `physicalMethod = area-calibrated-v1`, `areaCm2 = pixels × k`
   (±1%), grams / kg CO2e / L water numbers or null, unknown food null; some food has grams, so the
   overlay legend carries the `g · kg CO2e · L water (est.)` suffix (the JPEG text is not OCR'd); overlay
   downloads.
3. Depth ON capture (skipped when the calibration has no DAv2 scale): `volume-dav2-v1` with volumes, or
   the area method with `depth_unavailable`/`depth_invalid`.
4. `GET /api/dashboard/impact`: `kgCo2e`/`waterLitres` totals and `physicalCoverage`.

The hall's previous measurement settings are restored afterwards. Last live run: 2026-10-04, 4/4
(docs/verification-report.md, IT_4 section).

The fake-backend counterpart (no services needed) is `tests/integration/calibrate-capture.test.mjs`.

## Run

```bash
cd tests
npm test                          # fixture + placeholder
SCRAP_E2E=1 npm run test:e2e      # needs the running stack (README setup)
SCRAP_E2E=1 npm run test:e2e:calibration   # IT_4 calibration → area/volume → totals
```
