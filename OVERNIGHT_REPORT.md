# Overnight report: Supabase migration + forecasting (2026-10-24, 21:01–22:20 EDT)

**Branches.** `supabase-migration` (Part A, from `origin/main` `208c2d7`) → `overnight-supabase`
(Part B, from `supabase-migration` at `350a034`). 13 commits, **not pushed or merged, and `main` is
untouched**. The step-by-step log, with every number, is in [PROGRESS.md](PROGRESS.md).

**Final test run.**
- `./test-all.sh`: **ALL PASSED** (data 41, vision 99, analytics 77, capture 66, backend 124 + 2
  opt-in skipped, frontend 137 + build, db typecheck, tests 26, python 70, forecast 27, scripts 28).
- Live Supabase checks: 13/13 system tests and 13/13 repository round trips.

**Gemini calls: 32 of 150** (all from the live test2 run).

---

## 6. What to check first in the morning (ranked)

1. **Fix `SUPABASE_URL` in `.env`.** It is still a dashboard link (`https://supabase.com/dashboard/org/…`),
   not the API address. Set it to `https://<project-ref>.supabase.co` (Project Settings → API). I
   didn't edit `.env`; every live command tonight passed the correct URL on the command line, derived
   from the project ref in `SUPABASE_DB_URL`. Until this is fixed, the backend refuses
   `DATABASE_PROVIDER=supabase`, the Supabase tests skip, and the dashboard's live refresh stays off.
2. **Switch the app over.** Your `.env` has no `DATABASE_PROVIDER` line and still says
   `OBJECT_STORAGE_PROVIDER=local-dev`, so `deploy/local.sh`, `demo.py` and a plain `npm start` still
   run on SpacetimeDB and local files. Add `DATABASE_PROVIDER=supabase` and
   `OBJECT_STORAGE_PROVIDER=supabase` (bucket `scrap-images` is the default) to `.env`, then restart.
3. **Look at the new pages:** `/forecast` and `/production`.
   - Forecast shows **SIMULATED** numbers on `hall-main`.
   - Remove them any time with `python3 -m forecast.simulate remove --hall hall-main`.
4. **Imported scans don't count on the dashboard, and they didn't before either.**
   - All 23 imported measurements use the old method name `sam2_mask_pixel_count`.
   - Current code counts only `mask_pixel_count`, so the 6 hall-main scans from Oct 2–4 show in Scanned
     plates as "Not counted… lack validated mask provenance", and "Plates scanned" is 0.
   - I kept the rows verbatim on purpose, so numbers match the old data exactly (parity: 366 reads, 0
     differences).
   - If you want them counted, re-run those photos through the current pipeline (about 2–3 Gemini calls
     each).
5. **Self-serve dishes run short about 55% of the time by design.**
   - With the default costs in `forecast/config.toml`, self-serve gets q ≈ 0.42, on the assumption that
     staff refill it.
   - If running out of soup or salad is worse than that, raise `running_out_usd_per_lb.self_serve`.
   - Entrées are q ≈ 0.85 and sides q ≈ 0.60, as asked.
6. **No production-sheet photo exists in the repo**, so the sheet reader was tested only with mocked
   Gemini answers. Upload one real sheet on `/production` to see how it reads handwriting.
7. **This Mac's SpacetimeDB data is from an older module version.** It lacks seven later tables, so the
   current backend returned errors on most dashboard endpoints when pointed at it. If the offsite
   server's copy is newer, import it too (same script; see `docs/supabase-migration-plan.md`).

## 1. What got done

**Part A: migrate to Supabase (`supabase-migration`)**
- **Schema** (`supabase/migrations/`, 12 files, all applied to the live project with `supabase db push`
  after a dry run on an empty project):
  - One table per SpacetimeDB table, plus `hall` and `dish`.
  - Foreign keys, CHECK constraints, and indexes on hall, date, dish and captured-at.
  - The 7 multi-row reducers rewritten as transactional Postgres functions with the same checks and
    error messages.
  - **RLS on all 28 tables:** the publishable key can read only the 19 dashboard tables and cannot
    write anything.
  - A **private** `scrap-images` bucket.
  - Realtime on scans.
- **Storage:** `SupabaseStorage` adapter.
  - Same object-key naming as before.
  - Signed upload URLs that overwrite on retry, so uploads stay idempotent.
  - 10-minute signed read URLs.
  - Rows store paths only.
- **Backend:** `SupabaseRepository` (the same `Repository` interface, so no service changes), selected
  by `DATABASE_PROVIDER=supabase`. The service role key stays on the server; the dashboard build takes
  only the URL and publishable key through an allow-list and refuses a secret key.
- **Dashboard:** Supabase Realtime triggers a refetch of the existing `/api` data, so every number is
  computed exactly as before. Verified live: an anon subscriber receives INSERT and UPDATE events.
- **Data copy:** `backend/scripts/import-spacetime-to-supabase.mjs`, re-runnable. It upserts, checks
  for orphaned rows first, and prints old vs. new counts. **Every count matches** (section 5).
  Re-running creates no duplicates.
- **Tests:**
  - Upload → Storage, with only the path in Postgres.
  - RLS blocks every write and RPC with the publishable key.
  - **Dashboard totals equal the sum of the scan rows.**
  - Migrations on an in-memory Postgres (offline, in `test-all.sh`).
  - Realtime delivery and a secret scan of the built bundle.
  - Repository parity: 366 reads, 0 differences.
  - **Live test2 run on Supabase: 13/13 photos succeeded; dashboard 1,582,804 px = scan rows; 32
    Gemini calls; everything it created was deleted afterwards.**

**Part B: overnight phases (`overnight-supabase`)**
- **Phase 0–1:** branch and setup; `docs/supabase-migration-plan.md`.
  - Forecasting schema additions: `is_simulated` everywhere; `forecast_outcome` keyed by dish × hall ×
    date × meal; review fields on `production_log`; the menu-cycle anchor; per-dish cost and impact
    metadata.
- **Phase 2, sheet reader:** photo → Gemini (strict JSON, a confidence for every field) → UNCONFIRMED
  `production_log` rows with the photo's storage path.
  - Doubtful values are flagged, never corrected: low confidence, leftover > prepped, impossible
    numbers, unknown dish, ran-out outside the meal, date mismatch.
  - New **Production sheets** page: review, edit, then confirm (with a name) or reject. Confirm stays
    disabled until blocking flags are fixed. The database enforces the same rules.
- **Phase 3, forecast worker** (`forecast/`, stdlib Python, CLI + HTTP like the SAM worker):
  - **Baseline:** same cycle day last cycle, with fallbacks, scaled by expected diners.
  - **Expected eaten** = demand × (1 − tray waste share).
  - **Newsvendor prep** at q = Cu / (Cu + Co), where Co includes each dish's Waste Impact Score from the
    factors CSV. The percentile comes from walk-forward errors.
  - **Ran-out meals are treated as censored.**
  - The evaluation harness writes `forecast_outcome` and needs no code changes for real data.
  - One labeled simulated dataset, removable with one command.
  - 27 unit tests, now a `forecast` suite in `test-all.sh`.
- **Phase 4:**
  - Printable prep sheets (one HTML page per station per meal, with a SIMULATED banner when relevant).
  - `GET /api/forecast/summary` (formulas in `analytics/`; reproduces the Python evaluation exactly).
  - New **Forecast** page: ours vs. FSS error and stockouts, pan leftover and tray waste in lb and $,
    per-dish forecast vs. actual, the next 7 days to prep, and the SIMULATED DATA banner. Checked in
    Chrome at desktop and phone width.
- **Phase 5:** README (Supabase setup, env vars, workers, tests, removing simulated data),
  `.env.example` (placeholders only), this report.

**Simulated results.** These are SIMULATED and say nothing about a real hall. Backtest of 336 dish-meals,
2026-09-26 to 10-23:

| | Ours (`baseline-v1`) | FSS |
|---|---|---|
| Forecast error (WAPE) | 18.2% | 40.9% |
| Stockouts | 132 | 58 |
| Pan leftover | would leave 1,838 lb | 4,680 lb ($23,796) |

Our stockout rate matches the configured target for each dish type (entrée 22% vs. 21%, side 39% vs.
35%, self-serve 56% vs. 55%).

## 2. What didn't get done, and why

- **Real production-sheet testing:** there are no sheet photos in the repo (the `images/masks/_sheet*`
  files are mask contact sheets). Mocked-Gemini tests only, so 0 Gemini calls were spent on sheets.
- **Full-API parity against SpacetimeDB:** not possible on this data. The current backend on this Mac's
  older SpacetimeDB data fails with `SpacetimeDB query failed (400): no such table:
  'capture_visibility'`. Publishing the current module to a scratch copy was refused with `Reordering
  table food_measurement requires a manual migration` / `Adding a column mask_count_json … requires a
  default value annotation`. I checked parity at the repository level instead: 366 reads, 0
  differences.
- **Detection scoring in the live test2 run:** skipped because `ground_truth.csv` is not in the repo
  (removed 2026-10-04 per the test).
- **Tray waste in pounds from real scans:** the code path exists, but no calibrated scans exist, so the
  share is 0 (logged by the worker), and the dashboard's tray waste numbers are the simulated ones.
- **Removing SpacetimeDB, R2 and old code:** not done, by instruction (steps below).
- **Not changed:** the read-only offsite server (`deploy/server/`, which reads a SpacetimeDB copy),
  `deploy/local.sh` and `demo.py` (which start SpacetimeDB), and the CI workflow.

## 3. Decisions I made on your behalf

1. **`attendance` naming:** the old per-service simulated attendance became `simulated_attendance`;
   `attendance` now holds real 15-minute swipes. (You approved this.)
2. **Dashboard reads:** numbers still come from the backend API; Realtime only triggers refreshes.
   (Approved.) Anon can read only the formerly public tables plus forecasting tables. (Approved.)
3. **`.env` not edited,** despite the wrong `SUPABASE_URL`. I used a runtime override instead.
4. **Legacy measurements kept verbatim** (`sam2_mask_pixel_count`), with the CHECK constraint widened.
5. **Menu items keep upload order** (new `position` column), and **re-uploads keep `dish_id` links**.
   The old function claimed to do this but didn't.
6. **Two foreign keys adjusted for real behavior:**
   - Dropped `capture_event.image_object_id → image_object`: demo captures use the sentinel
     `'demo:none'`.
   - Kept the mask foreign key: the pipeline registers masks first.
7. **`clear_demo_data` uses `where true`,** because Supabase's API role runs `safeupdate`, which
   refuses a `DELETE` without `WHERE`.
8. **Float output:** Supabase prints numbers to 15 significant digits (`extra_float_digits = 0`). The
   stored values are exact, and I didn't change the platform setting. Recommendation cache keys use
   integer pixel counts only, so nothing regenerates.
9. **The sheet reader uses live Gemini only;** mock text never becomes rows.
   - Re-reading the same photo returns its existing rows.
   - Low confidence doesn't block confirming; impossible or unknown values do.
   - Confirmed rows are locked.
   - `confirmedBy` is a typed name (no logins yet).
10. **Sheet photos are uploaded at full layout,** not cropped to the plate square.
11. **Forecasting choices:**
    - Prep covers *demand* (taken lb); eaten lb is reported alongside.
    - Tray waste share comes only from calibrated scans covering ≥ 80% of diners (no extrapolation).
    - FSS forecasts are stored as `forecast` rows with `model_version='fss'`.
    - WAPE scores our demand forecast; stockouts and leftovers score our prep amount.
    - Expected diners have no exam-week, game or holiday adjustment yet (the data is stored for later).
12. **Simulated data lives on `hall-main`, flagged.** Its assumptions are listed at the top of
    `forecast/simulate.py`, including an FSS that over-preps by about 25%. I recalibrated it once
    because the first version ran out on 38% of meals.
13. **Installed the `sam2` package into `.venv`** (`--no-deps`, at the commit pinned in
    `vision/sam/requirements.txt`) so the live test2 run could use SAM. No other package versions
    changed.
14. **TLS for the Python worker:** python.org Python on this Mac has no CA bundle, so the worker loads
    `/etc/ssl/cert.pem` when Python's own store is empty. Certificate verification stays on.
15. **Cleaned up test leftovers created tonight:**
    - 14 cached fallback insights and 9 simulated-attendance rows created by an early test.
    - 47 demo markers from a failed run.
    - I rebuilt the scratch SpacetimeDB copy, which an early test had also written to; the original
      folder was never served.

## 4. Gemini calls used

| Run | Calls |
|---|---|
| Live test2 run on Supabase (13 photos + 1 recommendation) | 32 |
| Production-sheet tests (mocked) | 0 |
| **Total** | **32 of 150** |

## 5. Migration counts: old vs. new

**Source:** a copy of `~/.local/share/spacetime/data`, plus `backend/.local-storage/scrap-images/`.
Both originals are untouched.

| Table | SpacetimeDB | Supabase |
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
| capture_visibility, dashboard_view, scan_info, demo_marker | 0 | 0 |
| **Rows total** | **431** | **431** |
| **Files:** captures/ | 10 | 10 |
| **Files:** masks/ | 32 | 32 |

The import was re-checked after all of tonight's testing ("every count matches"). R2 was never used, so
there was nothing to copy from it.

**Still pointing at SpacetimeDB or R2** (kept until you approve removal):
- `db/spacetimedb/`, `backend/src/repo/spacetimeRepository.ts`, `backend/src/storage/r2Storage.ts`, and
  their config and wiring branches.
- `deploy/local.sh`, `deploy/server/*`, `demo.py`, `.github/workflows/agent8-verify.yml`,
  `capture/scripts/live_camera_test.py`.
- Tests: `tests/system/{spacetime,r2}.test.mjs`, `tests/e2e/*`, the R2/SpacetimeDB helpers in
  `tests/support/stack.mjs`, and `backend/test/{r2Storage,spacetimeRepository.live}.test.ts`.
- About 34 docs.

**To remove them after approval:** follow "Removing SpacetimeDB and R2" in
`docs/supabase-migration-plan.md`. In short:
1. Delete the code and tests listed above.
2. Remove the `@aws-sdk/*` packages and the SpacetimeDB/R2 options from `backend/src/config.ts` and
   `backend/src/wiring.ts`, and drop those variables from `.env.example`.
3. Repoint `deploy/` and `demo.py` at Supabase.
4. Only then archive `~/.local/share/spacetime/data`.

## 7. Commands

```bash
set -a; . ./.env; set +a                         # after fixing SUPABASE_URL (item 1 above)

# App (Supabase)
.venv/bin/python vision/sam/worker.py            # SAM 2.1 worker, :8790
cd backend && DATABASE_PROVIDER=supabase OBJECT_STORAGE_PROVIDER=supabase npm start     # API, :8787
cd frontend && npm run dev                       # dashboard, :5173 (Production sheets, Forecast)

# Tests
./test-all.sh                                    # everything offline (includes the forecast suite)
cd tests && node --env-file=../.env --test system/supabase-storage.test.mjs system/supabase-rls.test.mjs \
  system/supabase-realtime.test.mjs system/supabase-pipeline.test.mjs system/supabase-production.test.mjs
cd tests && LIVE_STACK=supabase GEMINI_CAP=60 npm run test:images     # live test2 run (~32 Gemini calls)

# Forecast worker
python3 -m forecast.worker run --hall hall-main --start 2026-10-25 --end 2026-10-31
python3 -m forecast.evaluate --hall hall-main --start 2026-09-26 --end 2026-10-23
python3 -m forecast.prep_sheet --hall hall-main --date 2026-10-25     # -> forecast/out/2026-10-25/index.html
python3 -m forecast.simulate remove --hall hall-main                  # delete ONLY the simulated data
```

**Left running tonight** (safe to stop):
- The SAM worker on `:8790`.
- A scratch SpacetimeDB copy on `127.0.0.1:3901`, serving a scratchpad copy rather than your original
  folder.
