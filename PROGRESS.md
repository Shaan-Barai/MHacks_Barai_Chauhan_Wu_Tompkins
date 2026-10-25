# PROGRESS — Supabase migration + overnight run

## Resume here

- **Branch:** `supabase-migration` (Part A). Part B moves to `overnight-supabase`, branched from `supabase-migration`.
- **Last commit:** `cee58a0` gitignore the Supabase CLI cache
- **Next step:** A4, Step 7: tests (upload→Storage+Postgres path, RLS with the publishable key, totals = sum of scan rows, migration harness in repo), then the live test2 run.
- **Gemini calls used so far:** 0 of 150.
- **Long-running processes to restart:** the SpacetimeDB **copy** on `127.0.0.1:3901`. If it's down:
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
- [ ] Step 7: tests, and the live test2 run

### Part B: overnight run (`overnight-supabase`)
- [ ] Phase 0: setup
- [ ] Phase 1: migration gaps (plan doc, forecasting additions)
- [ ] Phase 2: production sheet reader
- [ ] Phase 3: baseline forecast and prep buffer
- [ ] Phase 4: prep sheets and forecast dashboard
- [ ] Phase 5: cleanup and report

## Gemini call log

| When | What | Calls | Running total |
|---|---|---|---|
| — | — | 0 | 0 |

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
