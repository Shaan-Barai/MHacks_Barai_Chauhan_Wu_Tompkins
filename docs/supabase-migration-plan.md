# Supabase migration: inventory and old → new mapping

Scrap Saver moved from **SpacetimeDB + local-dev image storage** to **Supabase** (Postgres + Storage +
Realtime) on branch `supabase-migration` (continued on `overnight-supabase`). Cloudflare R2 code existed
but was never connected: this Mac's `.env` used `OBJECT_STORAGE_PROVIDER=local-dev`. SpacetimeDB and R2
code, and the local SpacetimeDB data folder, are still in place until the owner approves their removal
(see "Removing SpacetimeDB and R2" below).

## What was there

### SpacetimeDB module (`db/spacetimedb/src/`)

- **20 tables.** Public (readable by any client): `meal_service`, `menu_item`, `menu_item_revision`,
  `reference_portion`, `capture_event`, `food_measurement`, `attendance`, `portions_served`, `insight`,
  `camera_calibration`, `measurement_settings`. Private (module owner only): `image_object`,
  `analysis_attempt`, `capture_count`, `segmentation_region`, `attempt_calibration`,
  `capture_visibility`, `dashboard_view`, `scan_info`, `demo_marker`.
- **17 reducers:** `upsert_menu`, `upsert_reference_portion`, `delete_reference_portion`,
  `upsert_image_object`, `delete_image_object`, `upsert_capture_event`, `set_capture_visibility`,
  `set_dashboard_view`, `record_analysis`, `upsert_camera_calibration`, `upsert_measurement_settings`,
  `replace_portions_served`, `upsert_attendance`, `upsert_insight`, `upsert_scan_info`,
  `record_demo_markers`, `clear_demo_data`.
- **Subscriptions: none.** The backend read tables with SQL over HTTP
  (`backend/src/repo/spacetimeRepository.ts`); the dashboard only called the backend's `/api` routes and
  had no automatic refresh.
- All database access went through one interface, `Repository` (`backend/src/repo/repository.ts`).

### Object storage (`backend/src/storage/`)

- `ObjectStorageAdapter` with three implementations: `local-dev` (files under
  `backend/.local-storage/<container>/`, the one actually used), `r2` (never configured) and now
  `supabase`.
- Key naming (unchanged): `[prefix]captures/<date>/<eventId>.<ext>`, `originals/…`,
  `references/<date>/<id>_<rand>.<ext>`, `calibrations/…`, `masks/<date>/<regionId>.png`,
  `overlays/<date>/<eventId>_<attemptId>.jpg`. New: `production-sheets/<date>/<id>.<ext>`.
- Upload = authorize (server) → client PUTs bytes to a signed URL → finalize (server checks the object
  exists and its size). Read = short-lived signed URL. Rows hold the path, never bytes.

## Old → new

| SpacetimeDB | Supabase (Postgres, `public`) | Notes |
|---|---|---|
| — | `hall` | New FK target, created automatically by triggers; holds timezone and menu-cycle start |
| — | `dish` | New: stable dish identity for forecasting (`menu_item.dish_id`) |
| `meal_service` | `meal_service` | `service_date` is a `date` |
| `menu_item` | `menu_item` | + `position` (upload order), + `dish_id` |
| `menu_item_revision` | `menu_item_revision` | |
| `reference_portion` | `reference_portion` | geometry as jsonb |
| `image_object` | `image_object` | provider `supabase`, container = bucket; same object keys |
| `capture_event` | `capture_event` | geometry flattened into columns |
| `analysis_attempt` | `analysis_attempt` | baseline versions and error as jsonb |
| `food_measurement` | `food_measurement` | mask count and physical estimate as jsonb |
| `capture_count` | `capture_count` | |
| `segmentation_region` | `segmentation_region` | boxes as `double precision[]` |
| `attempt_calibration` | `attempt_calibration` | |
| `camera_calibration` | `camera_calibration` | intrinsics as jsonb |
| `measurement_settings` | `measurement_settings` | |
| `attendance` (simulated, per service) | **`simulated_attendance`** | renamed: `attendance` now holds real swipes |
| `portions_served` | `portions_served` | unique per service × menu version × item |
| `insight` | `insight` | metrics as jsonb |
| `capture_visibility` | `capture_visibility` | |
| `dashboard_view` | `dashboard_view` | |
| `scan_info` | `scan_info` | |
| `demo_marker` | `demo_marker` | |
| — | `menu_cycle`, `production_log`, `attendance`, `context_day`, `forecast`, `forecast_outcome` | Forecasting (new) |

| Reducer | Now |
|---|---|
| `upsert_menu`, `record_analysis`, `replace_portions_served`, `set_capture_visibility`, `upsert_camera_calibration`, `upsert_measurement_settings`, `clear_demo_data` | Postgres functions of the same name (one transaction each, same checks and error messages), called with the service role |
| the other 10 | Primary-key upserts/deletes from `SupabaseRepository`; their invariants are CHECK constraints |

Storage: the private bucket **`scrap-images`** (JPEG/PNG/WebP, 10 MB). `createSignedUploadUrl` replaces
the presigned PUT (upsert, so a retried capture overwrites its deterministic key); `createSignedUrl`
(10 minutes) replaces the presigned GET.

## Security model

- **Row Level Security is on for every table.** The publishable (anon) key and signed-in users may only
  `SELECT` the dashboard tables (the formerly public ones + hall, dish, forecasting). Private tables have
  no policy, so they are invisible to them. Nobody but the service role can write or call the write
  functions. TODO: per-hall manager policies once logins exist.
- The service role key is used only by the backend and workers. The dashboard bundle gets the URL and
  the publishable key through an explicit allow-list in `frontend/vite.config.ts`, which refuses to
  build with a secret key; `tests/integration/bundle-secrets.test.mjs` scans the built bundle.
- The dashboard still reads its numbers through the backend API (the math stays in `analytics/`);
  Supabase Realtime only tells it when to refresh.

## What the migration found

- This Mac's SpacetimeDB data was written by an **older module**: it lacks seven later tables and the
  `food_measurement.mask_count_json` column, so the current backend could not serve most dashboard
  endpoints from it. Supabase serves them all.
- All 23 imported measurements use the old method name `sam2_mask_pixel_count`; they are kept verbatim
  so the dashboard computes what it computed before (current analytics count only
  `mask_pixel_count`).
- Supabase-specific behaviors handled: the API role loads `safeupdate` (no `DELETE` without `WHERE`);
  Realtime drops changes made within ~1 s of subscribing; numeric output is rounded to 15 significant
  digits (values are stored exactly).

## Re-running the import (e.g. the offsite server's copy)

```bash
# 1. Serve a COPY of the SpacetimeDB data folder (never the original) on a spare port.
# 2. Import (re-runnable: upserts only; prints old vs. new counts and exits 1 if any differ):
cd backend && npm run build
SPACETIMEDB_URI=http://127.0.0.1:3901 node scripts/import-spacetime-to-supabase.mjs --dry-run
SPACETIMEDB_URI=http://127.0.0.1:3901 node scripts/import-spacetime-to-supabase.mjs
# 3. Optional parity check (366 reads on this Mac's data, 0 differences):
cd ../tests && PARITY_SPACETIMEDB_URI=http://127.0.0.1:3901 node --env-file=../.env --test system/supabase-parity.test.mjs
```

## Removing SpacetimeDB and R2 (only after approval)

Re-checked against the code on 2026-10-25. Do the steps in this order; step 1 must come first because
the import script and the parity test use the SpacetimeDB repository.

0. **Before removing anything:** import the offsite server's SpacetimeDB copy too, if it differs from
   this Mac's (`backend/scripts/import-spacetime-to-supabase.mjs` against a copy served on a spare
   port; then `tests/system/supabase-parity.test.mjs`).
1. **Delete the one-time migration tools** (they import `spacetimeRepository.ts`):
   `backend/scripts/import-spacetime-to-supabase.mjs`, `tests/system/supabase-parity.test.mjs`.
2. **Delete the SpacetimeDB and R2 code and their tests:**
   - Code: `db/spacetimedb/` (and `db/README.md`), `backend/src/repo/spacetimeRepository.ts`,
     `backend/src/storage/r2Storage.ts`.
   - Tests: `backend/test/spacetimeRepository.live.test.ts`, `backend/test/r2Storage.test.ts`, the
     SpacetimeDB case in `backend/test/demoControls.test.ts` ("SpacetimeDB module without
     dashboard_view…"), `tests/system/spacetime.test.mjs`, `tests/system/r2.test.mjs`.
   - In `tests/support/stack.mjs`: the R2 and SpacetimeDB helpers (`r2Available`, `r2ObjectStorage`,
     `listR2`, `cleanR2Prefix`, `spacetimeAvailable`, `spacetimeRepo`, `publishThrowaway`,
     `deleteThrowaway`, `sql`, `callReducer`).
3. **Make Supabase the only path:**
   - `backend/src/config.ts` and `wiring.ts`: drop the `spacetime` and `r2` options and branches,
     and the `R2_KEY_PREFIX` fallback.
   - `backend/src/storage/objectStorage.ts` and `localDevStorage.ts`: drop the R2 comments.
   - `backend/package.json`: remove `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.
   - `tests/live/images.test.mjs`: make `LIVE_STACK=supabase` the only mode.
   - `tests/e2e/*`, `tests/camera/run.mjs`, `tests/scripts/unit.mjs`: replace R2 and SpacetimeDB setup
     with Supabase.
   - `test-all.sh` live suites (`stack`, `e2e-*`, `demo`): move them to Supabase.
   - `.github/workflows/agent8-verify.yml`: move it to Supabase.
   - `backend/test/supabaseRepository.live.test.ts`: change its fixture's `provider: 'r2'` to
     `'supabase'`.
   - `contracts/types.ts`: drop `'r2'` from `ImageObject.provider` once no stored row uses it (none
     do).
4. **Deploy and demo:**
   - `deploy/local.sh`: stop starting SpacetimeDB.
   - Delete `deploy/server/scrap-spacetimedb.service` and `deploy/r2-cors.*.json`.
   - `deploy/server/deploy.sh`: remove `sync-db`; the read-only server just needs the Supabase
     variables and `READ_ONLY=1`, which now refuses every write.
   - `demo.py` and `capture/scripts/live_camera_test.py` (`--spacetime-db`): move to Supabase.
   - `capture/src/http.ts` comments.
5. **Config and docs:**
   - Drop `SPACETIMEDB_*` and `R2_*` from `.env.example` and your `.env`.
   - Remove the README's "Legacy setup" section.
   - Update the other docs that mention SpacetimeDB or R2 (`git grep -l "SpacetimeDB\|R2" -- "*.md"`;
     about 34 files).
6. **Run `./test-all.sh` and the live Supabase tests** (README "Verify").
7. **Only then, and separately:** archive or delete `~/.local/share/spacetime/data` (and the offsite
   server's copy). The Cloudflare R2 bucket was never used, so there is nothing to delete there.
