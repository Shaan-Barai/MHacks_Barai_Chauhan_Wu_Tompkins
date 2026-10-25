# PROGRESS — Supabase migration + overnight run

## Resume here

- **Branch:** `overnight-supabase` (Part B), branched from `supabase-migration` at `350a034`.
- **Last commit:** `cee58a0` gitignore the Supabase CLI cache
- **Next step:** Phase 2 frontend: the "Production sheets" page (upload, review table with flagged cells, edit, confirm). The backend and vision parts are committed.
- **Gemini calls used so far:** 32 of 150.
- **Long-running processes to restart:** the SAM worker (`.venv/bin/python vision/sam/worker.py`, :8790; `sam2` was pip-installed into `.venv` tonight from the pinned commit) and the SpacetimeDB **copy** on `127.0.0.1:3901`. If it's down:
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
- [ ] Phase 2: production sheet reader
- [ ] Phase 3: baseline forecast and prep buffer
- [ ] Phase 4: prep sheets and forecast dashboard
- [ ] Phase 5: cleanup and report

## Gemini call log

| When | What | Calls | Running total |
|---|---|---|---|
| 21:35 | Live test2 run on Supabase (13 photos: classify + box passes; 1 recommendation) | 32 | 32 |

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
