# Merge review: `supabase-migration` + `overnight-supabase`

## How the two branches relate

```
origin/main (208c2d7)
   └── supabase-migration   8 commits: the Supabase migration (schema, storage, backend, Realtime, import, tests)
         └── overnight-supabase   +12 commits: forecasting (sheet reader, forecast worker, Forecast page)
                                   and the 2026-10-25 follow-up fixes
```

`overnight-supabase` contains every commit of `supabase-migration`, so it is the only branch to review
or merge. It is 0 commits behind `origin/main` and **merges cleanly** (checked with `git merge-tree`).
Nothing has been pushed.

Size: 103 files, about 10,800 lines added and 150 removed. Most of that is new: SQL migrations, the
Python `forecast/` package, tests, and docs. Changes to existing app code are about 3,300 lines across
32 files in `backend/src`, `frontend/src`, `analytics/src` and `vision/src`.

## What the diff does, in plain English

1. **Supabase becomes the database and image store** (opt-in with `DATABASE_PROVIDER=supabase` and
   `OBJECT_STORAGE_PROVIDER=supabase`).
   - Twelve SQL migrations create a Postgres table for each SpacetimeDB table, plus forecasting tables.
   - SpacetimeDB's multi-step "reducers" become Postgres functions that run as one transaction each.
   - Row Level Security is on everywhere: the public dashboard key can only read, and only the server
     can write.
   - Images go to a private bucket and are shown through 10-minute signed links.
   - The backend talks to all this through a new `SupabaseRepository`, which plugs into the existing
     `Repository` interface, so the rest of the backend didn't change.
2. **Live refresh:** the dashboard subscribes to new scans through Supabase Realtime and refetches its
   usual API data. All the math stays where it was.
3. **Data was copied over:** all 431 rows and 42 images from this Mac's SpacetimeDB and local image
   folder, with exact counts and a 366-read comparison showing 0 differences.
   - The 10 old scans were then re-analyzed with the current pipeline (appended, old rows kept), so
     they count on the dashboard now.
4. **Production sheets:** staff photograph the kitchen's handwritten sheet and Gemini reads it into
   rows.
   - Each value carries a confidence, and doubtful values are flagged.
   - Nothing counts until a named person confirms each row on a new page.
5. **Forecasting:** a Python worker predicts how many pounds of each dish to prep and how much buffer
   to add, writes printable prep sheets, and scores itself against what happened and against the
   existing FSS forecast.
   - There's a new Forecast page.
   - All of its data so far is **simulated** and labeled that way, including "Simulated FSS (assumed
     +25% over-prep)".
6. **Reading never writes:** dashboard GETs used to create attendance rows and call Gemini. Now they
   only read; generating happens on explicit POSTs, and `READ_ONLY=1` is enforced at the database layer.
7. **Docs and tests:**
   - The README has a Supabase setup.
   - New tests cover RLS, storage, Realtime, the full pipeline, "GETs never write" and the forecast
     formulas.
   - PROGRESS.md, OVERNIGHT_REPORT.md and docs/supabase-migration-plan.md explain everything.

## Risky parts to read yourself (most important first)

1. **The Postgres write functions:** `supabase/migrations/…03_write_functions.sql`, plus `…08` and
   `…10`, which redefine two of them. `upsert_menu`, `record_analysis`, `replace_portions_served` and
   the others re-implement the old TypeScript reducers in SQL.
   - They are tested offline (PGlite, 27 checks) and live (13-step repository round trip, full
     pipeline).
   - But this is business logic rewritten in a new language. `record_analysis`'s pixel checks and
     `upsert_menu`'s revision archive deserve a careful read.
2. **What the public (anon) key can read:** `…04_row_level_security.sql` lists 19 readable tables.
   - **`production_log` is one of them, so the names people type into "confirmed by", and sheet photo
     paths, are readable with the publishable key** that ships in the dashboard.
   - If names shouldn't be public, move `production_log` to the private list (one line) and serve it
     through the backend, which already does that.
   - `capture_event` and `food_measurement` are readable too, as they were public in SpacetimeDB.
3. **Key handling:** the service role key must stay on the server.
   - `frontend/vite.config.ts` takes only the URL and publishable key through an allow-list and refuses
     a secret key.
   - A test scans the built bundle for secrets.
   - Worth a glance, and worth rotating keys if `.env` was ever shared.
4. **Behavior changes from "GETs never write":**
   - The Statistics page shows the stored (or "stale") recommendation, or rule-based text, until
     someone presses **Ask again**. It no longer calls Gemini on page load.
   - Simulated attendance is no longer invented on first view. Run
     `node backend/scripts/backfill-attendance.mjs` if you want it for existing services (9 imported
     services have none).
5. **Data now in your Supabase project:**
   - The **simulated forecasting dataset lives on `hall-main`**, flagged `is_simulated`. Remove it
     before real use with `python3 -m forecast.simulate remove --hall hall-main`.
   - Four **`hall-e2e-*` halls are old test data** (one photo replayed 4 times) that came over in the
     import.
   - Re-analysis appended new attempts to the 10 imported captures.
6. **Foreign keys and constraints that SpacetimeDB never had:** delete behavior cascades from a capture
   or attempt to its children.
   - One foreign key was dropped on purpose: demo captures use the image ID `demo:none`.
   - Old data loaded cleanly, but new edge cases may surface as constraint errors instead of silently
     bad rows (that's intended).
7. **The forecast model** (`forecast/model.py`, `config.toml`): the defaults are conservative service
   levels (entrée 0.95, side 0.90, self-serve 0.85, dessert 0.85).
   - Results so far are on simulated data only.
   - At matched stockouts it leaves 28% less than the simulated FSS. That is not evidence of real-world
     gains.
8. **Production sheet reader:** **not yet tested on a real sheet photo** (none was available), only on
   mocked Gemini answers.
9. **Unrelated but found:** scoring last night's live run against the restored `ground_truth.csv` gives
   recall 94.4% and precision 81.0%, below the recorded 100% / 92.3%.
   - Detection code wasn't touched by this work.
   - The cause isn't investigated.

## Is it ready for a pull request?

**Yes, as one draft PR from `overnight-supabase`.**

What supports opening it:
- Merging is backward compatible: without `DATABASE_PROVIDER=supabase` the app still runs on
  SpacetimeDB or the in-memory store.
- `./test-all.sh` passes (backend 129 + 2 opt-in skips, frontend 137, forecast 36, everything else
  green).
- The live Supabase tests pass.
- It merges cleanly.

Before marking it ready to merge, I'd:
1. Read risks 1–3 above, and decide whether `production_log` should be private.
2. Decide whether `PROGRESS.md` and `OVERNIGHT_REPORT.md` belong in the repo; they're working logs.
   Moving them to `docs/` or dropping them from the PR are both fine.
3. Try the sheet reader on one real production sheet.
4. Decide what to do with the simulated forecast data and the `hall-e2e-*` test halls in Supabase.

Keep the SpacetimeDB/R2 removal for a **separate follow-up PR**, using the ordered steps in
[docs/supabase-migration-plan.md](docs/supabase-migration-plan.md) (re-checked on 2026-10-25). Step 0,
importing the offsite copy, must come first.
