# PROGRESS — Supabase migration + overnight run

## Resume here

- **Branch:** `supabase-migration` (Part A). Part B moves to `overnight-supabase`, branched from `supabase-migration`.
- **Last commit:** `cee58a0` gitignore the Supabase CLI cache
- **Next step:** A2, Step 5: Realtime publication migration + frontend `useLiveScans` hook + CSP.
- **Gemini calls used so far:** 0 of 150.
- **Long-running processes to restart:** none yet.
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
- [ ] Step 5: dashboard Realtime refresh
- [ ] Step 6: one-time import (local SpacetimeDB and `backend/.local-storage` into Supabase)
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
