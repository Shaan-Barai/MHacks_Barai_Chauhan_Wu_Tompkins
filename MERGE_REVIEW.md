# Merge review: `overnight-supabase` (draft PR #25)

## How the branches relate

```
origin/main (208c2d7)
   └── supabase-migration     8 commits: the Supabase migration (schema, storage, backend, Realtime, import, tests)
         └── overnight-supabase   forecasting (sheet reader, forecast worker, Forecast page) + 2026-10-25 fixes
               └── forecast-v2 → run4 → run5   Runs 3–5 (2026-10-28/29), merged back into overnight-supabase
```

`overnight-supabase` now contains everything from Runs 3–5 (`run5` was merged into it on 2026-10-29), so it is still the only branch to review. It is 0 commits behind `origin/main`, nothing has been merged to `main`, and the PR stays a draft.

**Size:** 174 files, about 17,900 lines added and 190 removed. Most of that is new: SQL migrations, the Python `forecast/` package, tests and docs.

**Supabase matches the branch.** Migrations `…01`–`…18` are all in `supabase/migrations/` here, and all are applied to the live project. Before this merge, `…13`–`…18` were live but missing from the PR.

## What the diff does, in plain English

### Supabase migration and forecasting (before Run 3)

1. **Supabase becomes the database and image store** (opt-in with `DATABASE_PROVIDER=supabase` and `OBJECT_STORAGE_PROVIDER=supabase`).
   - SQL migrations create a Postgres table for each SpacetimeDB table, plus the forecasting tables.
   - SpacetimeDB's multi-step "reducers" become Postgres functions that run as one transaction each.
   - Row Level Security is on everywhere: the public dashboard key can only read, and only the server can write.
   - Images go to a private bucket and are shown through 10-minute signed links.
   - A new `SupabaseRepository` plugs into the existing `Repository` interface.
2. **Live refresh** through Supabase Realtime. All the math stays where it was.
3. **Data was copied over** from this Mac's SpacetimeDB and image folder: 431 rows and 42 images, with 0 differences in a 366-read comparison. The 10 old scans were re-analyzed (appended; old rows kept).
4. **Production sheets:** staff photograph the handwritten sheet and Gemini reads it into rows. Nothing counts until a person confirms each row.
5. **Forecasting:** a Python worker forecasts pounds per dish with a prep buffer, writes prep sheets, and scores itself against what happened and against FSS. There is a Forecast page. **All forecasting data so far is SIMULATED** and labeled that way.
6. **Reading never writes:** dashboard GETs no longer create attendance rows or call Gemini, and `READ_ONLY=1` is enforced at the database layer.

### Run 3 (2026-10-28)

| Change | Migration |
|---|---|
| `production_log` is private: the anon key can no longer read it (it held reviewer names and sheet photo paths) | `…13` |
| Real, sourced calendar context for hall-main: registrar calendar, football, Hebcal/Aladhan holidays, Open-Meteo weather; each row keeps its source URLs | `…14` |
| Importers for M-Dining data (swipes, FSS export, production-sheet batches), each with a dry run and a validation report | — |
| Plate-scale pounds (`plate-scale-v1`): an **estimate** beside Pixels wasted, assuming every plate is 26.7 cm / 10.5". Pixel totals unchanged | `…15` (private table) |
| Five forecasting models, walk-forward backtest with a no-look-ahead test, and a "Model comparison" table on the Forecast page (**SIMULATED**) | `…16` |
| The 4 `hall-e2e-*` test captures are **hidden, not deleted**; 9 services got simulated attendance | — |

### Run 4 (2026-10-28)

| Change | Migration |
|---|---|
| Backtests may use only weather **forecasts** known 24 h ahead (Open-Meteo Previous Runs API), stored apart from observed weather. A test fails if a backtest reads the target day's observed weather | `…17` |
| **Shadow mode:** the database stamps every forecast with `created_at` and `locks_at` (the meal's start) and rejects changes after the lock. New `python -m forecast.shadow_report` (locked forecasts vs. FSS vs. actuals, at matched stockouts, SIMULATED label) | `…17` |
| The default Gemini timeout went from 30 s to 90 s | — |
| The 6 hall-main scans got plate measurements: only Gemini pass 1 was re-run on the stored photo, with no new analysis, so pixels are unchanged (6/6 usable; **≈ 2.1 lb, ESTIMATE**) | `…18` (`box_source` column) |
| `docs/camera-calibration-checklist.md` | — |

### Run 5 (2026-10-29)

| Change | Migration |
|---|---|
| **Gemini pass 2 timeout found and fixed.** Cause: unbounded "thinking" (28,718 thinking tokens for a 199-token answer). A timed-out request is now retried with thinking capped at 1024 tokens | — |
| **Reviewer names are no longer returned** by `GET /api/production-log`. It needs no sign-in and showed them on `/production`. They stay in the private table | — |
| A scheduled forecast job (GitHub Actions), **written and OFF**. It writes forecasts before each meal's lock and never after. See `docs/scheduler-setup.md` | — |
| `docs/pilot-runbook.md`: a 6-week shadow pilot at one hall | — |
| The plate size shows in the Statistics tooltip ("Assumes 10.5-inch (26.7 cm) plates"). The ground-truth loader accepts an optional `Station` column | — |

## Detection numbers: exactly what was measured (REAL photos)

All from the same 12 real plate photos (`test2/`), 18 labeled foods, one dinner on 2026-10-03, labeled by the team. Model `gemini-3.8-flash`, seed 42, temperature 0, 2 passes. In memory, no database writes. Full write-up: `docs/detection-accuracy.md`.

| Menu offered | Runs | Correct / missed / wrong | Recall | Precision |
|---|---|---|---|---|
| 26-food demo menu (3 foods not served that night) | 3, identical (Run 3) | 17 / 1 / 4 | 94.4% | 81.0% |
| 23-food menu of that dinner | 1 (Run 4) + 1 (Run 5 Step A), identical | 17 / 1 / 1 | 94.4% | 94.4% |
| 23-food menu, with the Run 5 timeout fix | **not measured end to end** (projected) | 18 / 0 / 1 | 100% | 94.7% |

- **The projection:** the one miss (the pie on IMG_2706) happened because Gemini's second pass timed out. That exact request, retried with thinking capped at 1024, was measured: it answered in 14 s and found the pie. The full pipeline run with the fix was not done (it needs 3 calls; the budget had 2 left).
- **The one wrong:** IMG_2703 + rice, which may be a labeling question.

**Timing (Run 5 Step A, 12 photos, seconds; the two passes run at the same time):**

| | avg | median | fastest | slowest |
|---|---|---|---|---|
| Gemini pass 1 | 21.7 | 18.8 | 8.3 | 63.1 |
| Gemini pass 2 (11; IMG_2706 timed out 3 × 90 s) | 33.3 | 37.7 | 11.3 | 49.0 |
| SAM | 0.5 | 0.5 | 0.3 | 0.7 |
| Total per photo (11) | 34.7 | 38.4 | 14.9 | 50.0 |

## What is SIMULATED (never present it as real)

- **Everything on the Forecast page:** history, attendance, the "Simulated FSS (assumed +25% over-prep)", the model comparison, and every forecast row (`is_simulated = true` on hall-main). Remove before real use: `python3 -m forecast.simulate remove --hall hall-main`.
- **Weather on the 42 simulated days**, including their simulated day-ahead forecasts. The 47 real days carry real Open-Meteo forecasts, with source URLs.
- **Attendance** for the imported services: simulated, labeled.
- **Pounds are estimates, not simulations.** They rest on an assumed plate size and average grams per cm².

## Risky parts to read yourself (most important first)

1. **The Postgres write functions:** `…03_write_functions.sql`, plus `…08` and `…10`, which redefine two of them. They re-implement the old TypeScript reducers in SQL. They are tested offline (PGlite) and live, but this is business logic rewritten in a new language. `record_analysis` and `upsert_menu` deserve a careful read.
2. **The shadow-mode trigger** (`…17`): it rejects updates, and deletes of real rows, once a meal starts. Simulated rows stay deletable. Check the lock times (07:00 / 11:00 / 16:30 in the hall's time zone; kept equal to `forecast/config.toml` by a test).
3. **What the public (anon) key can read:**
   - `production_log` is now private (`…13`), and its API no longer returns reviewer names (Run 5).
   - `capture_event`, `food_measurement` and the forecast tables are readable, as before.
4. **Key handling:**
   - The service-role key stays on the server, and a test scans the built bundle for secrets.
   - **New:** the scheduler would need the service-role key as a GitHub Actions secret (not set).
   - Full-history secret scans before each push in Runs 3–5 were clean.
5. **Behavior changes from "GETs never write":** the Statistics recommendation refreshes only on **Ask again**, and simulated attendance is no longer invented on first view.
6. **Data in your Supabase project:** the simulated forecasting dataset on hall-main, 4 hidden `hall-e2e-*` test captures, appended re-analysis attempts, 6 backfilled plate rows (`box_source = 'backfill-pass1'`), and 1,008 pre-shadow forecast rows (`lock_tracked = false`).
7. **Foreign keys and constraints that SpacetimeDB never had:** deletes cascade from a capture or attempt to its children. One foreign key was dropped on purpose (`demo:none`).
8. **Untested on real inputs:** the production-sheet reader (no real sheet photo yet), the M-Dining importers (sample files only), and the scheduler (it has never run on GitHub).

## Is it ready to merge?

**It is ready for review as a draft, not to merge.** `./test-all.sh` passes on this branch (backend 133, frontend 141, forecast 90, vision 106, everything else green).

Before marking it ready:
1. Read risks 1–3.
2. Try the sheet reader on one real production sheet.
3. Decide what to do with the simulated data on hall-main (remove it before a real pilot).
4. Decide on the scheduler: merging this PR puts the workflow on `main`, but it stays off until `FORECAST_SCHEDULER_ENABLED` is set (see `docs/scheduler-setup.md`).

Keep the SpacetimeDB/R2 removal for a **separate follow-up PR**, following the ordered steps in [docs/supabase-migration-plan.md](docs/supabase-migration-plan.md). Step 0 (importing the offsite copy) must come first.
