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

## BIG-PLAN live flow (`bigplan-live.test.mjs`)

Also skipped unless `SCRAP_E2E=1`. Against a running backend (Gemini key, `OBJECT_STORAGE_PROVIDER=r2`,
SpacetimeDB) plus the SAM worker (`SAM_WORKER_URL`, default `http://127.0.0.1:8790`):

1. `GET /api/health` (provider `r2`) and SAM `GET /health`.
2. The demo dinner service (`SCRAP_E2E_SERVICE`, default `svc_hall-main_2026-10-03_dinner`) exists;
   otherwise `backend/scripts/seed.mjs` runs once.
3. `simulate-camera` writes `SCRAP_E2E_PHOTOS` (1–4, default 3) `test2/` photos into a temp inbox;
   `ingest-inbox --no-dedupe --state-dir <tmp>` runs once → exactly one capture per photo; a rerun
   ingests nothing. (`--no-dedupe` because every simulated photo is a different plate: deterministic
   count, no same-dish Gemini calls. `SCRAP_E2E_DEDUPE=1` uses Gemini grouping instead.)
4. Polls `GET /api/captures/:id` until analysis is terminal: not `failed`, source `replay`, 1024²
   geometry, segmentation present, `attempt.calibration` (`PlateCalibration`) present.
   `GET /api/captures` lists each event once (`CaptureListItem`).
5. `GET /api/captures/:id/images` (`CaptureImages`): original + overlay + masks; every read URL
   fetches with HTTP 200 and an image content type (URLs are never printed).
6. With `SPACETIMEDB_URI` set: `capture_event`, `image_object` (provider `r2`, `finalized`,
   association kinds `capture`/`overlay`/`mask`, keys not URLs, no blobs), `analysis_attempt`, `attempt_calibration` (calibration + overlay id), and
   `food_measurement` rows — via the SpacetimeDB SQL HTTP API.
7. `GET /api/dashboard/impact` (`ImpactDashboard`): totals, `targets`, `mostWasted` populated.
8. `GET /api/recommendation` (`Recommendation`): non-empty text, source `gemini` or `fallback`.

```bash
cd tests
SCRAP_E2E=1 SPACETIMEDB_MODULE=scrap-bigplan npm run test:e2e:bigplan   # loads ../.env; shell vars win
```

The real-hardware counterpart is `capture/scripts/live_camera_test.py` (board + C920 + bridge
`--watch`, `source = camera`); this E2E swaps only the board for `simulate-camera` and goes on to
assert the analysis, storage, and dashboard results.

`test:e2e:bigplan` uses `node --env-file-if-exists` (Node ≥ 22.9). Always pass test **files** to
`node --test`: `node --test tests/e2e` treats the folder as one script and fails; use
`node --test tests/e2e/*.test.mjs` or the npm scripts.

## Run

```bash
cd tests
npm test                          # fixture + placeholder
SCRAP_E2E=1 npm run test:e2e      # needs the running stack (README setup)
```
