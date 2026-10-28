# PROGRESS — Supabase migration + overnight run

## Resume here

- **Run 3 (started 2026-10-28 01:42 EDT):** branch `forecast-v2` from `overnight-supabase` (`3e20815`). See "Run 3" at the bottom.
- **Last commit:** `b3d7a33` Run 3 Phase 3 (Phase 1 = `bb99709`).
- **Next step:** Phase 2 runs are in progress (`tests/live/detection-runs.mjs`, 90 s timeout, cap 84); Phase 4 importers are next.
- **Gemini calls this run:** 16 + the Phase 2 runs (see the call log).
- Migrations: `npx supabase db push --db-url "$SUPABASE_DB_URL"` (dry run first) inside a subshell that sources `.env`; never echo it.

### Earlier runs (kept for reference)

- **Branch:** `overnight-supabase` (Part B), branched from `supabase-migration` at `350a034`.
- **Last commit:** `cee58a0` gitignore the Supabase CLI cache
- **Next step:** follow-up complete (task 5 still waits for a real sheet photo). See `MERGE_REVIEW.md`.
- **Gemini calls used so far:** 52 (32 overnight + 20 in follow-up task 4).
- **Long-running processes:** none (both stopped 2026-10-25). For live photo runs, start the SAM worker (`.venv/bin/python vision/sam/worker.py`, :8790; `sam2` was pip-installed into `.venv` tonight from the pinned commit) and the SpacetimeDB **copy** on `127.0.0.1:3901`. If it's down:
  `spacetime start --listen-addr 127.0.0.1:3901 --data-dir <scratchpad>/stdb-copy --jwt-pub-key-path ~/.config/spacetime/id_ecdsa.pub --jwt-priv-key-path ~/.config/spacetime/id_ecdsa --non-interactive`.
  If the scratchpad is gone, re-copy `~/.local/share/spacetime/data` first and delete `spacetime.pid` *in the copy*. Never start a server on the original folder.
- **SUPABASE_URL override:** `.env` still has a dashboard link. Run commands with
  `SUPABASE_URL="https://$(python3 -c "import urllib.parse,re;u=[l.split('=',1)[1].strip() for l in open('.env') if l.startswith('SUPABASE_DB_URL=')][0];print(re.match(r'postgres\.([a-z0-9]+)',urllib.parse.urlsplit(u).username).group(1))").supabase.co"`.
  It only reads the project ref from `SUPABASE_DB_URL`; the password isn't printed.

## Run info

- Started: 2026-10-24 21:01 EDT.
- Plan: `~/.claude/plans/pasted-content-id-beb6-overnight-run-unified-sedgewick.md`.
- Part A runs on `supabase-migration`, which branched from `origin/main` at `208c2d7`. Part B will run on `overnight-supabase`, branched from `supabase-migration`.
- Usage limit: the session may stop when the account hits its usage limit. Send "continue" after it resets; I resume from **Resume here**.

## Checklist

### Part A: finish the migration (`supabase-migration`)
- [x] Step 1: inventory and plan (approved)
- [x] Step 2: schema, write functions and RLS migrations (applied live: 28 tables, RLS on all)
- [x] Step 3: private `scrap-images` bucket and the `SupabaseStorage` adapter (live round trip passes)
- [x] Step 4: backend on Postgres (`SupabaseRepository`, `DATABASE_PROVIDER=supabase`)
- [x] Step 5: dashboard Realtime refresh
- [x] Step 6: one-time import (local SpacetimeDB and `backend/.local-storage` into Supabase). Every count matches.
- [x] Step 7: tests, and the live test2 run (13/13 photos; 32 Gemini calls)

### Part B: overnight run (`overnight-supabase`)
- [x] Phase 0: setup (branch `overnight-supabase` from `supabase-migration`; all keys present)
- [x] Phase 1: the migration was done in Part A; plus `docs/supabase-migration-plan.md` and the forecasting additions migration
- [x] Phase 2: production sheet reader (backend + review page; mocked Gemini only, no sheet photos in the repo)
- [x] Phase 3: baseline forecast and prep buffer (worker, evaluation, simulated dataset, 18 unit tests)
- [x] Phase 4: prep sheets and forecast dashboard
- [x] Phase 5: cleanup and report (README, `.env.example`, `OVERNIGHT_REPORT.md`)

## Gemini call log

| When | What | Calls | Running total |
|---|---|---|---|
| 01:49 | Phase 2 detection run attempt 1 (default 30 s timeout), stopped after 4 photos: IMG_2696 and IMG_2697 each burned 6 calls on GEMINI_TIMEOUT (2 passes × 3 attempts) | 16 | 16 |
| 21:35 | Live test2 run on Supabase (13 photos: classify + box passes; 1 recommendation) | 32 | 32 |
| 10-25 20:15 | Follow-up task 4: re-analyze the 10 imported captures (cap 35) | 20 | 52 |

## Known facts (checked)

- `.env` has `SUPABASE_URL`, `SUPABASE_ANON_KEY` (`sb_publishable_…`), `SUPABASE_SERVICE_ROLE_KEY` (`sb_secret_…`) and `SUPABASE_DB_URL` (session pooler). **`SUPABASE_URL` is a dashboard link, not the API URL.** I'm not editing `.env`; commands use the override above. This is the first thing to fix in the morning.
- No R2 was ever used: `.env` has no R2 credentials and storage was `local-dev`.
- Images to copy: `backend/.local-storage/scrap-images/` has 10 files under `captures/` and 32 under `masks/`. They're not at the repo root.
- SpacetimeDB source of truth: this Mac's `~/.local/share/spacetime/data` (64 MB, server not running). **The offsite server's copy can be imported later with the same re-runnable import script** (point it at that SpacetimeDB instance).
- No production-sheet photos in the repo (the `images/masks/_sheet*` files are mask contact sheets), so the sheet reader will be tested with mocked Gemini.

## Decisions made on the user's behalf

1. **`attendance` naming:** the old simulated per-service table is now `simulated_attendance`; `attendance` holds real 15-minute swipes. The user approved this in Step 1.
2. **Dashboard reads:** through the backend API, with Supabase Realtime only triggering refreshes (approved option A). This keeps the numbers identical, because `analytics/` stays the one place for the math.
3. **Anon access:** anon reads only the formerly public tables plus hall, dish and the forecasting tables. Private tables are service role only (approved).
4. **`.env`:** not edited, even though `SUPABASE_URL` is wrong. Reason: it's the user's secrets file; I pass a runtime override instead.

## Log

- 21:01. Created PROGRESS.md. Steps 1–3 were done earlier this session: commits `cd63176` (schema), `6e80491` (storage) and `cee58a0` (gitignore). The migrations were applied with `supabase db push` after a dry run on an empty project. Backend unit tests: 116 pass, 0 fail, 1 skipped (it was skipped before my changes). The live Storage round trip passes.
- 21:25. Step 4. Added `backend/src/repo/supabaseRepository.ts` (the same `Repository` interface; multi-row writes go through Postgres functions, single-row writes are upserts on the primary key, reads page past PostgREST's 1000-row limit). Selected with `DATABASE_PROVIDER=supabase`; SpacetimeDB and the JSON store are still options.
  - Live test `backend/test/supabaseRepository.live.test.ts` (opt-in with `SCRAP_LIVE_REPO_TEST=1`): **13/13 pass against the real project**, and it deletes its rows afterwards (every table was back to 0 rows).
  - **Decision:** the copied SpacetimeDB live test re-uploaded menu v1 after v2 and expected success. The current reducer (and now Postgres) rejects that, so the old SpacetimeDB test is stale on this point. The Supabase copy asserts the rejection instead.
  - **Decision:** kept the `segmentation_region.mask_object_id -> image_object` foreign key. The real pipeline (`ImageService.storeMask`) registers each mask before `recordAnalysis`; the test now does the same.
  - `./test-all.sh`: ALL PASSED (backend 116 pass / 2 skipped, frontend 128, vision 91, analytics 73, capture 66, data 41, tests 23, python 70, scripts 27).
- 21:15. Step 5, the Realtime refresh.
  - Migration `…06_realtime.sql` (applied live) adds `capture_event` and `food_measurement` to `supabase_realtime`.
  - The frontend `useLiveScans` hook (`frontend/src/lib/liveScans.ts`) subscribes with the publishable key and bumps the existing `dataRevision`. The Dashboard, Statistics and Scanned plates pages then refetch from `/api`, so every number and chart is computed exactly as before. It only adds automatic refresh.
  - **Decision:** Vite reads only `SUPABASE_URL` and `SUPABASE_ANON_KEY` from the root `.env`, through an explicit allow-list (no env prefix), so the service key can't be bundled. The build refuses a key that looks secret. Live refresh stays off until `SUPABASE_URL` is a real API URL, which means **it is off with the current `.env`.**
  - CSP `connect-src`/`img-src` now include the Supabase `https` and `wss` origins.
  - Tests:
    - New live `tests/system/supabase-realtime.test.mjs`: **passes** (anon receives INSERT and UPDATE of a scan).
    - New `tests/integration/bundle-secrets.test.mjs`: **passes** (no `sb_secret_`, no service key value or name in `frontend/dist`; a secret key in the browser slot fails the build).
    - 3 new frontend unit tests (debounce, unsubscribe).
  - Found while testing: Realtime drops writes made within ~1 s of `SUBSCRIBED`. That doesn't affect the dashboard (long-lived subscription); the test waits 3 s.
  - `./test-all.sh`: ALL PASSED (frontend 131, tests 25, backend 116 pass / 2 skipped).
- 21:25. Step 6, the import (`backend/scripts/import-spacetime-to-supabase.mjs`).
  - **Source:** a COPY of `~/.local/share/spacetime/data`, served on `127.0.0.1:3901` with the original JWT keys. The original folder was never opened by a server; its stale `spacetime.pid` is untouched. All 42 files in `backend/.local-storage` are still there.
  - **Result:** dry run first, then the real import, then a second run to prove it's idempotent. All three runs ended "every count matches":

    | Table | Old (SpacetimeDB) | New (Supabase) |
    |---|---|---|
    | meal_service | 14 | 14 |
    | menu_item | 146 | 146 |
    | menu_item_revision | 0 | 0 |
    | image_object | 42 | 42 |
    | reference_portion | 135 | 135 |
    | capture_event | 10 | 10 |
    | camera_calibration | 0 | 0 |
    | analysis_attempt | 10 | 10 |
    | food_measurement | 23 | 23 |
    | capture_count | 10 | 10 |
    | segmentation_region | 32 | 32 |
    | attempt_calibration | 0 | 0 |
    | measurement_settings | 0 | 0 |
    | attendance → simulated_attendance | 5 | 5 |
    | portions_served | 0 | 0 |
    | insight | 4 | 4 |
    | capture_visibility / dashboard_view / scan_info / demo_marker | 0 | 0 |
    | **Files** captures/ | 10 | 10 |
    | **Files** masks/ | 32 | 32 |

  - **Found:** this Mac's SpacetimeDB data was written by an **older module**. It lacks 7 later tables (`attempt_calibration`, `camera_calibration`, `capture_visibility`, `dashboard_view`, `measurement_settings`, `portions_served`, `scan_info`) and `food_measurement.mask_count_json`. The current backend therefore returns HTTP 500 on most dashboard endpoints when pointed at this folder. Publishing the current module to the copy was refused (it needs a manual migration), and nothing changed. Supabase now serves all of them.
  - **Decision:** all 23 imported measurements use the old method name `sam2_mask_pixel_count`. I kept them **verbatim** (migration `…07` widens the CHECK) instead of renaming them, so the dashboard computes exactly what the current code computes from this data. **That means current analytics count only `mask_pixel_count` and leave these 23 rows out of Pixels-wasted totals. This was already true before the migration; worth a look in the morning.**
  - **Found and fixed:** menu item order. SpacetimeDB returns items in upload order; Supabase sorted them by ID. Migration `…08` adds `menu_item.position`, and the import fills it from source order. The same migration fixes `upsert_menu` so a re-upload keeps each item's `dish_id` link (the old comment claimed it did, but delete-then-insert lost it).
  - **Parity test** (`tests/system/supabase-parity.test.mjs`, opt-in with `PARITY_SPACETIMEDB_URI`): **366 repository reads across 5 halls and 14 services, 0 differences.** Allowed differences: timestamps compared as instants; image rows now point at Supabase.
    - Non-integer numbers are compared to 12 significant digits. Postgres stores them exactly, but Supabase's server config (`extra_float_digits = 0`, a platform setting I didn't change) prints 15 digits.
    - Recommendation cache keys use integer pixel counts only, so the 4 stored Gemini insights still match and won't regenerate.
  - **Cleanup:** a first, endpoint-level parity attempt made the Supabase backend cache 14 fallback recommendations as `insight` rows. `GET /api/recommendation` writes a cache row even with `READ_ONLY=1`, which is existing behavior. I deleted exactly those 14 rows (created tonight; IDs not in the source).
  - `./test-all.sh`: ALL PASSED.
- 21:30. Step 7, tests (all green against the live project):
  - **`tests/system/supabase-pipeline.test.mjs`** (the twin of the SpacetimeDB system test; per-run hall and `test/<run>/` prefix, all deleted afterwards; fake Gemini and SAM, so **0 real Gemini calls**): **5/5 pass**.
    - An upload lands in Storage and Postgres stores only its path (provider `supabase`, key under the prefix, row < 800 bytes, no image data).
    - **Dashboard totals equal the sum of the scan rows** (`/api/dashboard/impact` and `/api/dashboard/totals` against `sumScanRows`).
    - `record_analysis` is atomic; portions replace; demo data clears only its own rows.
  - **`tests/system/supabase-rls.test.mjs`** (publishable key): **5/5 pass**.
    - All 28 tables refuse insert, update and delete with a *permission* error.
    - All 7 write functions refuse to run.
    - The 9 private tables are unreadable; the 19 dashboard tables are readable.
    - The bucket refuses list, upload and signed URLs.
  - **`tests/integration/supabase-migrations.test.mjs`** (offline, runs in `test-all.sh`): all migrations applied to an in-memory Postgres (PGlite), 27 checks. A deliberately wrong expectation makes it fail, so the checks are real.
  - **Real bugs the live tests found and fixed:**
    1. **Demo seeding failed:** sample captures use the sentinel `imageObjectId 'demo:none'` (no photo), which the `capture_event.image_object_id` foreign key rejected. Migration `…09` drops that one FK (index kept); the import's orphan check no longer uses it.
    2. **"Clear sample data" failed:** Supabase's API role loads `safeupdate`, which refuses a `DELETE` without `WHERE`. Migration `…10` makes `clear_demo_data` say `where true`. The PGlite harness can't load `safeupdate`, so only the live test catches this class of bug.
  - **Test leftovers cleaned (all created tonight):**
    - 47 demo markers from the run that hit bug 1.
    - **The first endpoint-level parity run wrote to both sides.** Dashboard GETs generate simulated attendance on first view, even with `READ_ONLY=1`. That added 9 rows to Supabase and 9 to the *scratch copy* of SpacetimeDB. I deleted the 9 from Supabase and rebuilt the scratch copy from the original folder (the original was never served). Counts are back to exactly the imported numbers, and parity was re-run on the clean copy: 366 reads, 0 differences.
  - `./test-all.sh`: ALL PASSED (tests 26 now).
- 21:45. Step 7, the live test2 run (`tests/live/images.test.mjs` with the new `LIVE_STACK=supabase` mode, `GEMINI_CAP=60`).
  - Throwaway hall `hall-live-20261025t013228`, Storage prefix `test/live-20261025t013228/`, real Gemini, local SAM 2.1 on MPS.
  - **13/13 photos succeeded.** Each scan is complete in Postgres, with the raw photo and segmented overlay in Storage, signed through `/api/captures/:id/images`.
  - Waste Impact formula check passes. **Dashboard totals = scan rows: 1,582,804 px over 13 plates.**
  - The Gemini recommendation was generated and saved.
  - Cleanup: 208 Storage objects and all of the hall's rows deleted, 0 left.
  - **Gemini calls: 32** (31 for photos + 1 recommendation). Report: `images/live-test/20261025T013228/report.json` (gitignored).
  - Detection scoring was skipped: `ground_truth.csv` isn't in the repo (removed 2026-10-04, per the test).
  - **Setup change:** the SAM worker couldn't start because `.venv` had no `sam2` package. I installed it with `pip install --no-deps` at the commit pinned in `vision/sam/requirements.txt`; no other package versions changed.
  - `./test-all.sh`: ALL PASSED.
- **Part A complete.**
- 21:42. **Part B, Phase 0.** Branch `overnight-supabase` created from `supabase-migration` (`350a034`). `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` and `GEMINI_API_KEY` are all present (values not printed). `SUPABASE_URL` is still the dashboard link (see Known facts).
- 21:50. **Phase 1.** Part A already covered inventory, schema, RLS, storage, backend, Realtime, import and tests. Added:
  - `docs/supabase-migration-plan.md`: inventory, old → new mapping, security model, findings, re-import steps, removal steps.
  - Migration `…11_forecasting_additions.sql` (applied live; forecasting tables were empty, so no data changed):
    - `is_simulated` on dish and all six forecasting tables.
    - `forecast_outcome` re-keyed to dish × hall × date × meal × model, with its actuals and $ columns; an outcome can exist for the FSS forecast alone.
    - `production_log` review fields: `status` unconfirmed/confirmed/rejected, `dish_name_raw`, `field_confidence`, `review_flags`, `sheet_image_object_id`, `extraction_model`. Only confirmed rows must have a dish, leftover ≤ prepped, and be unique.
    - `hall.menu_cycle_start` (a Monday) and `menu_cycle_weeks`.
    - `dish.service_style`, `portion_lb`, `food_cost_usd_per_lb` and `impact_food_name`.
  - **Decision:** the overnight spec lists `attendance` with `is_simulated` and `production_log` with `confirmed at`. Both were added (`confirmed_at` already existed).
  - **Decision:** a sheet line Gemini reads as "leftover > prepped" is stored as unconfirmed and flagged, not rejected. The constraint applies only once a person confirms it.
  - The offline migration test gained 7 forecasting checks. The live RLS test still passes (all tables).
  - `./test-all.sh`: ALL PASSED.
- 22:05. **Phase 2 backend (checkpoint).**
  - `vision/src/productionSheet.ts`: prompt plus a strict JSON schema with `{value, confidence}` for every field (dish, station, meal, date, prepped lb, portions, pan leftover lb, ran-out time).
    - The validator **flags rather than corrects** doubtful values: low confidence (< 0.7), leftover > prepped, negative or implausible numbers, bad date/time, ran-out outside the meal's hours, ran out yet leftover in the pan, an unknown dish, and a date that differs from the one given at upload.
    - Dishes are matched only by exact normalized name or alias, so text on the sheet can't rename anything.
  - Backend:
    - `ProductionStore` (Supabase plus an in-memory version with the same rules) and `ProductionSheetService`.
    - Routes: `POST /api/production-sheets/extract`, `GET /api/production-log`, `PATCH /api/production-log/:id`, `POST …/confirm` and `…/reject`, `GET /api/dishes`.
    - The sheet photo uploads through the normal flow as the new kind `production_sheet` (`production-sheets/<date>/<id>_<rand>.<ext>`). Rows keep its path and object ID.
  - **Decisions:**
    1. **Live Gemini only.** Mock text never becomes rows; without a key the endpoint returns 503 `SHEET_READER_UNAVAILABLE`.
    2. **Re-reading the same photo returns its existing rows** instead of calling Gemini again and duplicating them.
    3. **Some flags block confirmation** (unknown/missing dish, missing date or meal, leftover > prepped, negative values, no prepped amount). **Low confidence doesn't block**: confirming means a person looked.
    4. An edited field counts as fully confident, and flags are recomputed from the values.
    5. **Confirmed rows are locked.**
    6. **`confirmedBy` is a typed name.** There are no user logins yet; the TODO is per-hall manager auth.
    7. **Ran-out time:** entered as hall-local `HH:MM`, stored as a UTC instant using the hall's timezone (DST-safe; tested).
  - **No production-sheet photos are in the repo, so every test uses mocked Gemini answers. 0 Gemini calls. Testing on a real sheet still needs a photo.**
  - Tests:
    - 8 vision tests (clean, smudged, impossible, malformed, injection, uploader date/meal) and 6 backend HTTP tests (extract → flags → edit → confirm/reject, locking, uniqueness, no-live-Gemini, wrong photo kind, DST).
    - Live `tests/system/supabase-production.test.mjs`: the real table enforces "confirmed needs a dish", "leftover ≤ prepped" and one confirmed row per dish × station × meal.
  - `./test-all.sh`: ALL PASSED (vision 99, backend 122 + 2 skipped).
- 22:15. **Phase 2 frontend.** New "Production sheets" page (`/production`, in the nav after Portions served).
  - Upload a sheet photo with its date and meal; the original is kept, not cropped to the plate square, and is re-encoded to JPEG only if needed.
  - The server reads it. Each row shows what was written on the sheet, with editable fields.
  - **Flagged fields are outlined (dashed border) with a written reason and confidence**, e.g. "Check: The AI was not sure it read this correctly. (60% sure)". The theme is black and white, so nothing relies on color.
  - Confirm stays disabled until blocking flags are fixed, changes are saved and a reviewer name is entered. Reject is always available.
  - The read-only site shows rows without the upload or edit controls.
  - 3 new page tests (read → flags; fix → save → confirm → appears in Recently confirmed; reject), and the nav test was updated.
  - **Not visually checked in a browser yet** (jsdom tests only).
  - `./test-all.sh`: ALL PASSED (frontend 134).
- 22:30. **Phase 3, the forecast worker** (`forecast/`; stdlib Python; README in `forecast/README.md`).
  - **Model `baseline-v1`:** same dish, same cycle day, last cycle → fallbacks (dish weekday-meal average → dish meal average → hall weekday-meal average) → scaled by expected/actual diners → expected eaten = demand × (1 − tray waste share) → newsvendor prep at q = Cu / (Cu + Co).
    - Co = food cost + Waste Impact Score from the factors CSVs.
    - The percentile comes from walk-forward relative errors (42 days), with a ±25% normal spread under 5 errors.
    - **Ran-out meals are censored** (lower bounds) in both the baseline and the error spread.
  - `config.toml` defaults: q ≈ 0.85 entrée / 0.60 side / 0.42 self-serve / 0.45 dessert (checked by a test).
  - Worker CLI and HTTP service (`/health`, `POST /run`) in the SAM worker's style. The evaluation harness writes `forecast_outcome` and prints WAPE, stockouts, leftover lb and $, ours vs. FSS.
  - Migration `…12` (applied live): `forecast.demand_lb`, `service_level_q`, `basis` and `why`, so prep sheets and the dashboard can explain each number.
  - **Simulated dataset** (`python3 -m forecast.simulate generate|remove`), hall `hall-main`, 2026-09-12 to 2026-10-23 (6 weeks), lunch and dinner, 15 dishes from the factors table, seed `sim-v1` (no `ATTENDANCE_SEED` set), attendance 300–1200 from `.env`.
    - Written: 15 dishes, 504 menu-cycle rows, 42 context days, 1,260 fifteen-minute swipe rows, 504 confirmed production rows (88 ran out), 588 FSS forecasts. **Every row has `is_simulated = true`.**
    - `remove` deletes only flagged rows; proven by regenerating, which removed exactly the previous set, including resetting `hall.menu_cycle_start`.
  - **Run (all simulated):** 420 forecasts (backtest 2026-09-26 to 10-23 plus next week 10-24 to 10-30) and 336 evaluated outcomes:
    - **Ours:** demand WAPE **18.2%**, 132 stockouts, would leave **1,838 lb**.
    - **FSS:** WAPE **40.9%**, 58 stockouts (= the 58 actual ran-out meals, a consistency check), **4,680 lb** leftover ($23,796 at Co).
    - **Our stockout rate matches the newsvendor target per style** (entrée 22.3% vs 1−q 20.8%; side 39.3% vs 35.0%; self-serve 56.2% vs 54.6%). The extra stockouts are the configured cost trade-off, not a bug.
    - Tray waste: 1,056 lb, **simulated** (no calibrated scans exist).
  - **Decisions:**
    1. **Prep covers demand (taken lb), not eaten lb.** Eaten = demand × (1 − tray waste) is reported alongside.
    2. **Tray waste share only from calibrated scans covering ≥ 80% of diners.** Smaller samples would be an extrapolation (AGENTS.md §7). With no calibrated scans it is 0, logged in the worker's notes.
    3. **FSS forecasts are stored as `forecast` rows with `model_version='fss'`** (there was no other place for them).
    4. **Outcomes score our demand forecast for WAPE, but our prep amount for stockouts and leftover.**
    5. **Simulated data lives on `hall-main`, flagged.** The forecast page shows a SIMULATED banner and `remove` deletes it.
    6. **Expected diners have no context adjustment yet** (exam week, home game, holiday). `context_day` is stored for a later model.
  - **Bugs found and fixed while running:**
    - (a) The first simulated FSS ran out 38% of the time. My expected-demand figure undercounted weekday diners; recalibrated to the week-average diners × 1.25, giving 17%.
    - (b) A stockout metric that missed meals prepped at exactly the forecast that ran out. Fixed, with a test.
    - (c) python.org Python on this Mac has no CA bundle, so TLS failed. The client now loads `/etc/ssl/cert.pem` when Python's store is empty; verification stays on.
  - **For the morning:** the default costs make self-serve run short about 55% of the time (q ≈ 0.42), because self-serve is assumed to be refilled. Raise `running_out_usd_per_lb.self_serve` if that's wrong.
  - `./test-all.sh`: ALL PASSED, now including a **forecast** suite (18 tests).
- 22:45. **Phase 4.**
  - **Prep sheets:** `python3 -m forecast.prep_sheet --hall hall-main --date YYYY-MM-DD` writes `forecast/out/<date>/` (gitignored), one print-styled HTML page per station per meal plus an `index.html` with all of them.
    - Each line shows the dish, recommended lb (large), portions, likely range (10th–90th percentile), the one-line "why" and a "made" checkbox.
    - **Simulated forecasts print a boxed "SIMULATED DATA … Do not prep from this sheet" banner.**
    - Rendered in Chrome print mode and checked visually. Fixed a doubled "))" in the why-line along the way.
  - **API:** `GET /api/forecast/summary?hallId&start&end[&today]` returns `{available, simulated, totals, dishes[], upcoming[]}`.
    - The math is in `analytics/src/forecast.ts` (same definitions as the Python evaluation). **Live, it reproduces the Python numbers exactly** (WAPE 18.2% / 40.9%, stockouts 132 / 58, pan leftover 4,680 lb / $23,796).
  - **Dashboard:** new "Forecast" page (`/forecast`).
    - A boxed **SIMULATED DATA banner** whenever any simulated row is shown.
    - Four stat tiles: forecast error ours vs. FSS, stockouts ours vs. FSS, pan leftover lb and $ (plus what our forecast would have left), tray waste lb and $ with its source.
    - A forecast-vs-actual table per dish, and "What to prep: next 7 days" with each "why".
    - Unknown values show "—", never 0.
    - **Form choice (dataviz skill):** stat tiles and a table, no plotted chart. The job is a few headline comparisons plus a per-dish lookup, and the app's theme is black and white, so no palette was needed.
    - Screenshots at 1280 px and 390 px in Chrome with no console errors. Fixed tile values that wrapped or overflowed on phones, and Dinner listed before Lunch.
  - **Found while checking the dashboard:** with the imported data, "Plates scanned" is 0 for the last 30 days. The 6 imported hall-main scans from Oct 2–4 are listed in Scanned plates as "Not counted in the totals: its pixel counts lack validated mask provenance" (the legacy `sam2_mask_pixel_count` rows). That's how the current code treats this old data; it was **not caused by the migration** (parity verified). Worth deciding whether to re-run those 10 photos through the current pipeline.
  - Tests: analytics +4 (hand-checked WAPE and stockouts), backend +2 (summary route, unavailable, bad params), frontend +3 (tiles, banner, unavailable), forecast +2 (prep sheet banner and escaping).
  - `./test-all.sh`: ALL PASSED (analytics 77, backend 124 + 2 skipped, frontend 137, forecast 20).
- 22:20. **Phase 5.**
  - README: Supabase setup with an env-var table, forecasting commands, removing simulated data, and the live Supabase test commands. The old SpacetimeDB setup is kept as "Legacy setup".
  - `.env.example`: `DATABASE_PROVIDER`, `FORECAST_PORT` and the Vite allow-list note; placeholders only (checked).
  - Final checks: `./test-all.sh` ALL PASSED; live Supabase system tests 13/13; live repository test 13/13; import dry-run "every count matches" after all of tonight's testing.
  - Wrote `OVERNIGHT_REPORT.md`.
  - **Gemini total: 32 of 150.**
- 22:25. **Extra tests for weak spots** (`forecast/tests/test_worker.py`, +7):
  - The worker uses only the past and labels simulated inputs.
  - The menu cycle decides dishes, and unknown dishes are skipped.
  - No history gives no forecast (not 0).
  - Simulated menus are deterministic and balanced; simulated tray waste stays within 4–14%.
  - The client refuses a dashboard URL, a missing key, and an unfiltered DELETE or UPDATE.
  - Forecast suite: 27 tests. `./test-all.sh`: ALL PASSED. **Stopping here.**
- 2026-10-25. The user updated `.env`: `SUPABASE_URL` is now the API address and `DATABASE_PROVIDER=supabase`. Checked with **no command-line overrides**:
  - Live Supabase system tests: 13/13 pass, none skipped.
  - The backend started from `.env` alone reports `persistence: Supabase Postgres`, `storage: supabase`, and `/api/ready` is green (database, Storage, SAM worker, Gemini). Plates and forecast data are served from Supabase.
  - **Open item:** `.env` has `OBJECT_STORAGE_PROVIDER` twice (`local-dev`, then `supabase`). Shell `source` and Node keep the last value; loaders that keep the first (such as `forecast/db.py`'s) get `local-dev`. Delete the `local-dev` line.

## Follow-up (2026-10-25): tasks 2, 3, 4, 6, 7 on `overnight-supabase`

The user confirmed in their own words: do tasks 2–7, task 1 is already done, and **skip task 5** (no production-sheet photo yet). The duplicate `OBJECT_STORAGE_PROVIDER=local-dev` line is gone from `.env` (checked: one line, `supabase`).

- **Decision:** the SAM worker (:8790) and the scratch SpacetimeDB copy (:3901) stay running until the end. Task 4 needs SAM, and task 3 needs the untouched import source to tell imported rows from rows created later by GETs. Both are stopped when the follow-up is done.
- **Task 5 skipped:** there is no production-sheet photo yet. The sheet reader has still only been tested with mocked Gemini answers.
- **Task 2 done: a fair forecast comparison.**
  - **New defaults** (`forecast/config.toml`): service levels are now stated directly, each with a comment explaining it. Entrée 0.95, side 0.90, self-serve 0.85, dessert 0.85, other 0.90.
    - Cu per dish type is derived so a typical dish (reference impact $2.40/kg) gets exactly that q. Higher-impact dishes get slightly lower q; ham's entrée q is 0.936.
    - **The unconfirmed "staff refill self-serve" assumption is removed.** No station is assumed to be refilled mid-meal.
  - **Matched-stockouts mode** (`python3 -m forecast.evaluate`, now `--mode default|matched|both`): one shared log-odds shift of every dish's q, found by bisection as the smallest shift with our stockouts ≤ the comparison forecast's. Leftover lb and $ are then compared with the same formula for both (meals that did not run out). In memory; writes nothing.
  - **Label:** whenever the comparison rows are the simulator's, they are "Simulated FSS (assumed +25% over-prep)" everywhere:
    - evaluation output (`comparisonLabel`);
    - the API (`comparisonLabel`);
    - Forecast page tiles, table header, the next-week list, and a footnote "not real FSS data";
    - the simulator's docstring and the `why` text of its 588 FSS rows (updated in place).
    - **Prep sheets never show the comparison forecast**, so nothing to relabel there.
  - **Re-run (all SIMULATED, 336 dish-meals, 2026-09-26 to 10-23):**

    | | Ours, new defaults (mean q 0.902) | Ours, matched stockouts (shift −0.539, mean q 0.844) | Simulated FSS (assumed +25% over-prep) |
    |---|---|---|---|
    | WAPE | 18.2% | 18.2% | 40.9% |
    | Stockouts | 41 | 58 | 58 |
    | Leftover lb | 3,973 | 3,356 | 4,680 |
    | Leftover $ | $20,054 | $16,715 | $23,796 |

    At matched stockouts, ours leaves 28% fewer lb and 30% fewer $ (simulated, not a real-world claim). At the new defaults ours has **fewer** stockouts (41 vs. 58) and less leftover.
  - Tests: forecast +1 (q shift keeps order and moves together) and the updated defaults test; backend +1 (a real FSS export is labeled "FSS"); frontend: the simulated label replaces "FSS" in tiles and header.
  - The page was checked in Chrome. Fixed numeric cells wrapping ("53.7 / lb").
  - OVERNIGHT_REPORT.md: the results table is replaced (marked "Corrected 2026-10-25"), and the self-serve item is struck through and superseded.
  - `./test-all.sh`: ALL PASSED.
- **Task 3 done: GET requests never write.**
  - **What wrote on a GET:**
    - (a) `GET /api/dashboard/meal` created simulated attendance (`ensureAttendance`).
    - (b) The same route generated (with Gemini when live) and stored a pixel or portion insight.
    - (c) `GET /api/recommendation` called Gemini and stored the result.
    - All three happened even with `READ_ONLY=1` (a and b store rule-based fallbacks there).
  - **Now:**
    - GETs only read. Attendance is read, and missing means "attendance_missing", the existing contract the summary tests already encode.
    - Insights and recommendations return the stored Gemini version for the same inputs, else the last one marked stale, else the labeled rule-based text computed in memory. **No Gemini call and no write on any GET.**
  - **Generation moved to explicit writes:**
    - `POST /api/recommendation/regenerate` (the existing "Ask again" button; still shows the last Gemini answer as stale if Gemini fails).
    - New `POST /api/dashboard/meal/insight`.
    - Demo seeding, which backfills its sample services.
    - **New seed script `backend/scripts/backfill-attendance.mjs`** (`--dry-run`; refuses READ_ONLY).
  - **`READ_ONLY=1` is now enforced in the repository too:** a proxy makes every write method throw 403 `READ_ONLY`.
  - **Decisions:**
    1. Saving a menu does NOT create attendance. Tried first; it broke the "attendance is missing until provided" contract (`PUT /api/attendance` is first-write-wins), so it was reverted.
    2. **No automatic startup backfill.** It would have written attendance for the 9 imported services that have none just by starting the app, changing the imported data. It's an explicit seed step instead.
    3. **UX change:** the Statistics page shows the stored or stale recommendation, or the labeled rule-based text, until someone presses "Ask again". Before, the first page view called Gemini.
  - **Tests:**
    - `backend/test/getsNeverWrite.test.ts` calls **all 43 GET routes** (read from `app.ts`, so a new GET can't be missed) through a repository spy and a Gemini call counter, in normal and READ_ONLY mode: 0 writes, 0 Gemini calls.
    - Verified it catches a regression: reintroducing the old attendance write made it fail with "GETs wrote: upsertAttendance".
    - Plus a READ_ONLY guard test.
    - **Live `tests/system/supabase-gets-readonly.test.mjs`:** counts all 28 tables and every Storage folder, calls all 43 GETs and loads **all 9 dashboard pages in Chrome** on the real backend and Supabase, then counts again: **unchanged (30 counts)**.
    - 6 existing tests were updated from "GET generates or stores" to "POST generates, GET reads". Read-only tests now seed through a writable repository while the app sees the guarded one.
  - **Cleanup:** none needed. Supabase still matches the import exactly (import dry-run: every count matches; `simulated_attendance` 5, `insight` 4), so no GET-created rows exist.
  - Note: `./test-all.sh` doesn't load `.env`, so the live `tests/system/supabase-*` tests skip there. Run them as documented in the README.
  - `./test-all.sh`: ALL PASSED (backend 128 + 2 skipped).
- **Task 4 done: the old scans now count.**
  - New explicit re-analysis path: `IngestionService.reanalyze(eventId)` and `POST /api/captures/:eventId/reanalyze` (ingest token or admin; Gemini rate cap). It **appends a new attempt to the same capture**; earlier attempts and their measurements stay, and the newest succeeded attempt is the one counted.
    - A plain resubmit still never re-analyzes (unit-tested).
    - Script: `backend/scripts/reanalyze-captures.mjs --legacy|--event <id> [--max-gemini N] [--dry-run]`.
  - **Run:** 10/10 captures succeeded with the current pipeline (Gemini classification + SAM 2.1 masks), **2 Gemini calls each = 20 of the 35 budget**. The 1 imported capture that had *failed* (`cap_e2e_musw2fuw`) succeeded this time.
  - **Before → after** (dashboard API, 2026-09-01 to 10-31):

    | Hall | Plates scanned | Excluded | Pixels wasted |
    |---|---|---|---|
    | hall-main | 0 → **6** | 6 → 0 | 0 → **748,986** |
    | hall-e2e-musw1war | 0 → 1 | 1 → 0 | 0 → 172,870 |
    | hall-e2e-musw2fuw | 0 → 1 | 1 → 0 | 0 → 172,870 |
    | hall-e2e-musw3a06 | 0 → 1 | 1 → 0 | 0 → 172,870 |
    | hall-e2e-musw3m68 | 0 → 1 | 1 → 0 | 0 → 172,870 |

    hall-main's 748,986 = the sum of its 6 captures' new mask counts (196,563 + 108,678 + 173,240 + 2,814 + 83,763 + 183,928).
  - **The 23 legacy `sam2_mask_pixel_count` rows are kept** (count verified), plus 24 new `mask_pixel_count` rows.
  - **Found:** the 4 `hall-e2e-*` captures are **the same photo** (identical 289,794-byte images), replayed into 4 throwaway test halls by earlier e2e runs that ended up in this Mac's SpacetimeDB data. They're test data, not real scans; hide or delete them if they shouldn't appear (the user's call).
- **Task 6 done: context adjustments and `ground_truth.csv`.**
  - **Context adjustments** (`forecast/model.py` `context_multiplier`, `[context]` in `config.toml`): **OFF by default** (`enabled = false`).
    - When on, the hall's exam week, home game and holiday flags from `context_day` adjust expected diners. Each flag's ratio is **estimated from the hall's own past flagged days** (vs. the same weekday and meal without flags).
    - Needs ≥ `min_days` (2) examples, flags multiply, the result is clamped to [0.3, 2.0], and only days before the target are used.
    - The why-line says e.g. "diners adjusted for home game x0.60 (estimated from past days)".
    - 8 unit tests (off by default, estimation, too little history, multiply and clamp, no look-ahead, disabled = unchanged forecasts, applied = scaled and explained). **No accuracy gain is claimed.**
  - **`ground_truth.csv` found:** added in git `b62ed8c`, deleted `174c2d4` (2026-10-04); an identical copy is at `~/Desktop/MHacks/scrap/ground_truth.csv` (12 photos).
    - Restored to **`images/ground_truth.csv`** (gitignored; confirmed not tracked).
    - `tests/live/images.test.mjs` now looks for `GROUND_TRUTH_CSV`, then `images/ground_truth.csv`, then the repo root.
  - **Scored last night's live run offline** (from its saved report, 0 Gemini calls): **recall 94.4%, precision 81.0%** (17 correct, 1 missed, 4 wrong over 12 photos) vs. the recorded baseline of 100% / 92.3%, **so the live test would now report a REGRESSION.**
    - Misses and extras: IMG_2696 +Cheese Bread; IMG_2700 +Lettuce; IMG_2702 Cheese Bread instead of Pepperoni Pizza; IMG_2703 +Halal Rice.
    - Detection is the vision pipeline, which the migration didn't change. The cause isn't investigated (Gemini run-to-run variation is one possibility). Logged for the user.
- **Task 7 done.**
  - `MERGE_REVIEW.md`: how the branches relate (`overnight-supabase` contains all of `supabase-migration`; 20 commits ahead of `origin/main`, 0 behind, merges cleanly), a plain-English summary of the diff (103 files), 9 ranked risks, and a verdict: **ready for one draft PR**, with 4 things to settle before merging.
  - **Removal steps re-checked; they were out of date.** The import script and the parity test now depend on `spacetimeRepository.ts`, and they missed `demoControls.test.ts`'s SpacetimeDB case, the live test's R2 mode, the e2e/camera tests, `demo.py`, CI and the test-all live suites. `docs/supabase-migration-plan.md` now has ordered steps 0–7, with "import the offsite copy first" as step 0.
  - **New risk found while writing the review:** `production_log` is anon-readable, so "confirmed by" names and sheet photo paths are visible with the publishable key. Flagged as risk #2 (a one-line fix if names should be private); not changed without the user's say.
  - Stopped the SAM worker (:8790) and the scratch SpacetimeDB copy (:3901). Confirmed each was the process I started; the original `~/.local/share/spacetime/data` was never served.
- **Follow-up Gemini total: 20** (task 4). **Overall: 52.**

## Run 3: forecast-v2 (2026-10-28, unattended)

Plan: `~/.claude/plans/pasted-content-id-88eb-long-unattended-sequential-pony.md`.

### Checklist
- [x] Setup: branch `forecast-v2`, keys present (values not printed)
- [x] Phase 1: production_log private, hide hall-e2e-* halls, backfill simulated attendance
- [ ] Phase 2: detection regression (≤ 100 Gemini calls)
- [x] Phase 3: real context data (calendar, football, weather, holidays)
- [x] Phase 4: importers for M-Dining data + docs/data-intake.md
- [x] Phase 5: pixels → pounds (plate scale)
- [ ] Phase 6: forecasting models + walk-forward evaluation
- [ ] Phase 7: docs/forecasting-methods.md
- [ ] Phase 8: secret scan, then push/draft PR only if clean
- [ ] RUN3_REPORT.md

### Gemini call log (Run 3, cap 150)

| When | What | Calls | Running total |
|---|---|---|---|

### Decisions made on my behalf

1. The model name `GEMINI_MODEL=gemini-3.8-flash` is recorded (a model name, not a secret). No other `.env` value was printed.
2. **production_log private:** the migration drops its anon `"dashboard read"` policy and revokes `select` from anon/authenticated. Dropping a policy changes access, not data, so I treated it as additive. The frontend never reads `production_log` directly (it goes through the backend's service role), so nothing in the UI changes.
3. **Hiding the test halls:** I used the existing `capture_visibility` mechanism (`set_capture_visibility`, hidden = true) and added no `hall.hidden` column. The dashboard has no hall list (the hall comes from Settings, default `hall-main`), so hiding the 4 captures removes them from every dashboard number. The `hall` rows and all their data stay.
4. **Attendance backfill scope:** I ran the existing script as is. It filled only services with no row, all 9 on `hall-main` (the hall-e2e services already had attendance).
5. **Detection timeout (Phase 2):** the 3 variation runs use `GEMINI_TIMEOUT_MS=90000` (default 30000). At the default, 2 of the first 4 photos failed both passes on timeout and were unscored, which wasted calls and measured nothing. All 3 runs use identical settings.
6. **Context sources (Phase 3):**
   - The registrar's 2026-27 calendar is the Google Doc linked as "Academic Year Calendar" on ro.umich.edu/calendars (fetched as text).
   - Football comes from the 2026-01-27 MGoBlue release table.
   - Religious holidays: Hebcal API (Jewish) and Aladhan API (Islamic, calculated dates).
   - **Not included, no fetchable source:** Diwali, Easter/Good Friday, Lunar New Year, Holi. timeanddate.com returned 403 and the Provost's religious-holiday Google Calendar ICS returned 404.
   - "Between terms" break days (Dec 22–Jan 12, May 10) are derived (no classes or exams listed) and marked `derived` in the source file.
7. **Context rows never overwrite simulated rows:** hall-main's 42 simulated days (2026-09-12..10-23) were skipped. After `python3 -m forecast.simulate remove`, re-run the importer to fill them.
8. **Only non-test halls get context:** the only one is `hall-main`. The hall-e2e-*, hall-live-*, hall-test and hall-smoke halls are skipped.
9. **Weather:**
   - Open-Meteo archive for dates up to 5 days ago (observed).
   - The forecast API for the next 16 days; its days before today are marked observed.
   - Later dates have null weather, never a guess.

10. **Mapping files are TOML, not YAML:** Python's built-in `tomllib` reads them, so no new dependency. XLSX is read with a small standard-library reader (no openpyxl).
11. **Importers never overwrite simulated rows:** intervals or FSS rows that already hold `is_simulated = true` rows are skipped and reported. The fix is to remove the simulated data first. Nothing is deleted by an import.
12. **Swipe validation thresholds:**
   - More than 1,500 swipes at a hall in 15 minutes counts as impossible (configurable per mapping).
   - Hourly-looking exports are imported with a warning, not refused.
   - Swipes outside every meal's hours are rejected when the file names no meal.
13. **FSS:**
   - Matching uses exact normalized names: dish names, menu item names linked to a dish, and mapping aliases. That is the same normalization rule as the sheet reader.
   - Portions convert to pounds only with the dish's `portion_lb`.
   - A duplicate row in one file: the later one wins (warned).
   - The "FSS" label rule stays as it was: plain "FSS" only when no simulated FSS rows are in the hall's comparison.
14. **Sheet batch:**
   - It goes through the running backend's HTTP API (upload → finalize → extract), so it uses the exact same reader, flags and dedupe as the page.
   - Date and meal come from a `YYYY-MM-DD_<meal>` file-name prefix when present.
   - `--max-gemini` counts photos sent (one request each); server-side retries can add more.

15. **Plate scale despite AGENTS.md:** AGENTS.md says plate-size calibration was dropped in BIG-PLAN v2 because plates vary. The user asked for it explicitly in Run 3, so it is built as a **separate, labeled estimate** (`plate-scale-v1`). The camera calibration path stays, and is preferred where both exist.
16. **Where the plate size comes from:** the mean of the width and height of Gemini's target-dish box. It is used only for `dishType = plate`, fully visible, with box ratio ≤ 1.25. I didn't use SAM's dish region because it is dilated and hull-filled (it would overstate the plate).
17. **Storage:**
   - A new private table `plate_scale_estimate` holds one row per attempt with the pixel diameter and the **assumed cm at the time** (`PLATE_DIAMETER_CM`, default 26.7 = 10.5").
   - `food_measurement`, the `record_analysis` SQL function and SpacetimeDB are untouched. Redefining `record_analysis` overnight was judged too risky.
   - Pounds are computed at read time.
18. **No re-analysis for old scans:** the 6 hall-main scans have no plate record, and adding one would cost about 12 Gemini calls. Their pounds show "—".
19. **The estimate card is on Statistics, not the Dashboard:** a Dashboard test encodes the product decision "no pixels on the Dashboard", and the card states pixels beside pounds.

### Log

- 01:42. Created branch `forecast-v2` from `overnight-supabase` (`3e20815`). `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL` and `DATABASE_PROVIDER` are each present once. The `supabase` CLI isn't on PATH; migrations go through `npx supabase` as in the README.
- 01:50. **Phase 1.**
  - Migration `20261028000013_production_log_private.sql`: dry run, then applied live. The live RLS test (`tests/system/supabase-rls.test.mjs`) now lists `production_log` as private: **5/5 pass**. The offline PGlite test checks "anon cannot read production_log": passes.
  - **Hidden (not deleted):** captures `cap_e2e_musw1war`, `cap_e2e_musw2fuw`, `cap_e2e_musw3a06`, `cap_e2e_musw3m68` in halls `hall-e2e-musw1war`, `hall-e2e-musw2fuw`, `hall-e2e-musw3a06`, `hall-e2e-musw3m68` (one photo replayed by old e2e runs). Repository view (`listCaptureEvents`): before, hall-main 6 + 4 × 1 e2e; after, hall-main 6 only. `includeHidden` still returns all 10. Undo: the admin Scanned plates page, or `setCaptureVisibility(ids, false)`.
  - `backfill-attendance.mjs`: dry run found **9** services without attendance, all on hall-main (2026-10-01 to 10-04). **Created 9, labeled simulated.** A second dry run finds 0; `simulated_attendance` has 14 rows.
  - `./test-all.sh`: ALL PASSED.
- 02:10. **Phase 3.**
  - Migration `20261028000014_context_day_sources.sql` (additive: `source_urls`, `academic_note`, `class_day`, `study_day`, `break_day`, `first_class_day`, `weather_kind`, `imported_at`): dry run, then applied live.
  - **Sources fetched:**
    - Registrar Google Doc (via ro.umich.edu/calendars);
    - mgoblue.com 2026 schedule;
    - Hebcal JSON for 2026 and 2027;
    - Aladhan hToG (1 Ramadan 1448 = 2027-02-08; 1 Shawwal 1448 = 2027-03-09);
    - Open-Meteo archive and forecast.
  - **Not reachable:** timeanddate.com (403) and the Provost religious-holiday ICS (404); skipped.
  - `forecast/context_import.py`: re-runnable, `--dry-run`. Two real runs upserted the same 262 rows (`is_simulated = false`).
  - Summary (hall-main, 2026-08-01..2027-05-31, excluding the 42 simulated days):

    | hall | days | with weather (observed/forecast) | class days | exam days | study days | break days | home games | holiday days |
    |---|---|---|---|---|---|---|---|---|
    | hall-main | 262 | 61 (46/15) | 124 | 12 | 5 | 37 | 4 | 42 |

    The other 4 home games (Sep 12, 19, 26; Oct 17) fall on simulated days and were not written. All 8 are in the source file and tested.
  - 8 new unit tests (`forecast/tests/test_context_import.py`).
- 02:25. **Phase 4.** `forecast/importers/`:
  - `common.py`: TOML mapping, CSV/XLSX reader, date/time parsing, report.
  - `swipes.py`, `fss.py`, `sheets_batch.py`.
  - Mapping examples and `samples/sample_SIMULATED_*` (swipes CSV, FSS CSV, 3 grey PNG "sheets").
  - **Tests:** 14 new (`forecast/tests/test_importers.py`), using a fake DB and a mock backend HTTP server. **0 Gemini calls.** They cover the validation report, dry run, UTC 15-minute intervals, per-swipe counting, the simulated-row guard, units, alias/menu-item matching, the review list, the FSS label switch, and the sheet batch's cap/resume/retry/dry run.
  - **Live dry runs against Supabase** (samples mapped to hall-main): the swipes guard skipped the 5 intervals that hold simulated attendance, and the FSS run put all 5 sample names into review (none match real dishes). Nothing was written.
  - `docs/data-intake.md`: formats and what to ask M-Dining for.
  - `./test-all.sh`: ALL PASSED (forecast 58).
- 02:55. **Phase 5: pixels to pounds.**
  - **Inventory:**
    - Camera calibration: credit-card reference area → `camera_calibration`, `area-calibrated-v1` → `food_measurement.physical.areaCm2` → grams in `analytics/src/physical.ts`.
    - `reference_portion` is auxiliary baselines, not a scale. `attempt_calibration` is the camera calibration snapshot. `measurement_settings` holds per-hall settings.
    - The legacy `PlateCalibration` (plate-fit-v1) is deprecated and no longer persisted.
    - **None of these is used today: there are 0 camera calibrations in Supabase.**
  - **Built:**
    - `vision` `measurePlate`, plus `targetDish.plate` in every mask analysis;
    - backend: `AnalysisResult.plate` → `plate_scale_estimate` (migration `20261028000015`, applied live, private; live RLS test 5/5) → `GET /api/dashboard/estimated-weight`;
    - `analytics/src/plateScale.ts` (`cm2PerPixel`, `plateScaleEstimate`, `plateScaleWeights`);
    - a Statistics page card, "Food left on plates (estimate)", with an assumptions tooltip and coverage;
    - forecast `tray_grams` uses plate-scaled scans too, still under the ≥ 80% coverage rule;
    - a demo.py line in the stats step;
    - `.env.example` `PLATE_DIAMETER_CM`;
    - a `docs/calibration.md` section.
  - **Tests:** analytics +6 (hand-computed: 100,000 px on an 890 px plate = 90 cm² → 72 g at 0.8 g/cm² = 0.1587 lb), vision +2, backend +3 (API payload, pixels unchanged, ingestion records the assumed diameter), frontend +2, forecast +3 (hand-computed tray grams, camera-first no double count, 80% rule at 4/5 vs 4/6 diners).
  - **Not run live:** `demo.py` (needs the local stack); its syntax and `--list` are checked by test-all.
  - `./test-all.sh`: ALL PASSED.
