# Run 5 report (`run5`, 2026-10-29)

**Secret scan: clean**, so `run5` and `overnight-supabase` were pushed.
- The scan covered all 357 commits on every branch, including commit messages. It found 0 matches against the real `.env` values, 0 for the database password on its own, and 0 strong-pattern hits in Run 5's changes. Every `sb_secret_…` string in the whole history is a test fixture name (`sb_secret_example`, `sb_secret_test`, `sb_secret_THIS_MUST_NOT_SHIP_0000`).
- **PR #25 is still a draft and nothing was merged into `main`.**

**Commits on `run5`:**

| Commit | What |
|---|---|
| `8ed8e9b` | Task 1 |
| `daa6a0f` | Task 5 |
| `148ea6c` | Task 4 |
| `7b1f00e` | Task 3 |
| `b7d52f6` | MERGE_REVIEW |
| — | This report |

On `overnight-supabase`: the merge `2a1c972`. `./test-all.sh` passed before every commit; the last run gave vision 106, backend 133, frontend 141, forecast 90 and tests 26.

## 1. What got done, and what didn't

| Task | Result |
|---|---|
| 1. Timing and the pass 2 timeout | **Done, with one gap.** Per-pass timing on all 12 photos. Cause found: **runaway thinking**. Fix applied: a timed-out request is retried with thinking capped at 1024 tokens. **The full pipeline was not re-run end to end with the final fix** (see below). |
| 2. PR #25 up to date | **Done.** `run5` merged into `overnight-supabase`. The only conflict was `MERGE_REVIEW.md` (a doc), resolved to the new version; no code or migration conflicts. Migrations `…13`–`…18` are now in the PR. `MERGE_REVIEW.md` covers Runs 3–5, and the PR description and title were refreshed. |
| 3. Scheduler | **Done, OFF.** A GitHub Actions workflow plus `forecast/scheduled_run.py`. It runs only when you set a variable, and only from `main`. A live dry run planned 24 SIMULATED rows and wrote nothing. Setup guide: `docs/scheduler-setup.md`. |
| 4. Pilot runbook | **Done:** `docs/pilot-runbook.md`. Writing it exposed a privacy bug, now fixed (see §2, decision 5). |
| 5. Cleanups | **Done.** The tooltip says "Assumes 10.5-inch (26.7 cm) plates". The ground-truth loader and both scorers accept an optional `Station` column, with a by-station breakdown. `images/ground_truth.csv` and the IMG_2703 label are untouched. |

**What didn't work, with exact errors:**

- **My timing runner lost Step A's token data.** It crashed after scoring with `ReferenceError: Cannot access 'stat' before initialization` (a helper declared below the top-level code that used it), before writing `runs.json`.
  - The **times survived**, because each photo's times were printed as it finished.
  - Thinking/answer tokens and box counts per pass did not. Those columns come from the next run, which sent the same requests plus a thinking cap that no photo reached.
  - Fixed: the helper is now hoisted, and raw results are saved before the summary.
- **The first fix (attempt 1) failed.** A thinking cap of 8192 on every request did not stop the timeout: IMG_2706 pass 2 still hit `GEMINI_TIMEOUT` 3 × 90 s. Nothing else changed.
- **IMG_2707 was not run in attempt 1:** `stopped before IMG_2707.jpeg in run 1: 24 calls used, cap 27`.
- **The final fix is not measured end to end.** It needs 3 calls on IMG_2706 (pass 1, a pass 2 that times out, the capped retry), and Task 1 had 2 of its 55 left. Measured: the exact retry request answered in 14.0 s and found the pie. Projected (not measured): 18 correct, 0 missed, 1 wrong.
- **Run 4's last commit failed `./test-all.sh`:** `stale data filenames (use the _EastQuad names): RUN4_REPORT.md:60`.
  - Cause: that check only scans files git tracks, and in Run 4 I ran the tests before committing the report.
  - Fixed in `8ed8e9b`. In Run 5 I marked new files with `git add -N` before testing, so the check saw them.
  - So Run 4's report was wrong to say every commit passed: the report commit itself did not.

## 2. Decisions made on your behalf

All 12, with reasons: `docs/PROGRESS.md` → Run 5 → "Decisions made on my behalf". The main ones:

1. **Final fix = retry a timed-out request with thinking capped at 1024** (`GEMINI_TIMEOUT_RETRY_THINKING_BUDGET`; `off` restores identical retries).
   - First attempts keep the model's default thinking. The 11 photos that never time out are therefore exactly as measured.
   - Identical retries were useless: with the fixed seed they think just as long.
   - The 8192 default was dropped because it changed nothing (measured).
2. **Not re-buying Step A's token data:** re-running all 12 would have cost about 26 of the 34 remaining calls.
3. **Merge conflict:** `MERGE_REVIEW.md` resolved to the `run5` rewrite. `overnight-supabase`'s only edit to it was a pointer fix that `run4` already contained.
4. **Scheduler = GitHub Actions**, not Supabase pg_cron + Edge Function. The worker is plain Python that only needs HTTPS, so Actions runs it unchanged; pg_cron would mean a TypeScript rewrite.
   - Off by default through a repository variable.
   - It never writes a started service, not even the "late" rows `forecast.worker run` inserts.
5. **Reviewer names are no longer returned by the API.** `GET /api/production-log` needs no sign-in and returned `confirmedBy`, which `/production` showed as "Checked by" to anyone with the link.
   - The runbook promises staff names stay private, so the API now returns `confirmedBy: null` and the page shows the date checked.
   - The name is still required to confirm, and still kept in the private table.
   - This is a privacy fix, not a feature.
6. **`ground_truth.csv` left alone:** it isn't tracked in git (your local file). Add a column headed `Station` whenever you like; blank cells are fine.
7. **One test run, then per-task commits:** `./test-all.sh` ran once on the complete tree, then each task was committed. The tasks touch separate files, except `frontend/src/data/types.ts` and `mockApi.ts`, which went in with Task 5 and carry Task 4's change too.

## 3. Gemini calls

**53 of 60** (Task 1 cap 55). Tasks 2–5 used none.

| Calls | What |
|---|---|
| 26 | Step A, 12 photos |
| 2 | IMG_2706 diagnostic, 300 s timeout, no retries |
| 24 | Attempt 1 (8192 cap), 11 photos |
| 1 | Probe: IMG_2706 pass 2, thinking 1024 |

## 4. Per-pass timing (seconds, wall clock)

Test set: 12 real photos, 23-food menu, `gemini-3.8-flash`, seed 42, temperature 0, 2 passes, 90 s timeout. **The two passes run at the same time**, so a photo takes about as long as its slower pass plus about 1 s.

| | Before fix (Step A, model default), 12 photos | | | | Attempt 1 (8192 cap), 11 photos | | | |
|---|---|---|---|---|---|---|---|---|
| | avg | median | fastest | slowest | avg | median | fastest | slowest |
| Pass 1 | 21.7 | 18.8 | 8.3 | 63.1 | 21.3 | 17.0 | 7.2 | 61.5 |
| Pass 2 | 33.3 | 37.7 | 11.3 | 49.0 | 31.8 | 35.4 | 11.7 | 49.1 |
| SAM | 0.5 | 0.5 | 0.3 | 0.7 | 0.4 | 0.4 | 0.3 | 0.7 |
| Total | 34.7 | 38.4 | 14.9 | 50.0 | 33.3 | 36.5 | 14.7 | 50.5 |

- **Timeouts:** pass 2 timed out on 1 of 12 in Step A and on 1 of 11 in attempt 1, IMG_2706 both times (3 tries × 90 s = 271.5 s). That photo is left out of the pass 2 and total rows.
- **After the final fix:** there is no full-run table. For photos that don't time out it is the Step A row (same settings). For IMG_2706 the capped retry took 14.0 s, so the projected total is about 105 s instead of 272 s.
- **What drives the time:** it follows thinking tokens (correlation 0.87 for pass 1, 0.74 for pass 2), boxes only weakly (0.43 / 0.34), and not the number of labeled foods (−0.22 / 0.00).
- **Pass 2 is about 1.9× slower than pass 1** even at similar token counts. I did not find why.
- Per-photo tables: `docs/detection-accuracy.md` → "Timing and the pass 2 timeout".

**Accuracy:**
- Step A: 17 correct, 1 missed, 1 wrong (recall 94.4%, precision 94.4%), identical to Run 4.
- Attempt 1: the same detections on its 11 photos.
- With the final fix: **projected** 18 / 0 / 1 (100% / 94.7%), not measured.

## 5. The timeout: cause and fix

- **Cause: unbounded thinking.**
  - IMG_2706 with a 300 s timeout and no retries: pass 2 spent **28,718 thinking tokens and 227.6 s** on a **199-token answer** with 2 boxes. Pass 1 spent 7,707 tokens and 64.9 s.
  - It is not runaway output, not too many boxes (2), and not the image size (1024²).
  - With the fixed seed, every identical retry thinks just as long, so all 3 tries time out.
- **Why the pie was missed although the fallback exists:** the pipeline already uses the surviving pass alone when one fails. But pass 1's answer on IMG_2706 has no pie on the scanned plate. Given 228 s, pass 2 did find it.
- **Fix:** after a `GEMINI_TIMEOUT`, the retry carries a thinking cap of 1024 tokens. The same request then answered in 14.0 s and found the pie on the scanned plate. Tests: `vision/test/gateway.test.ts`.

## 6. PR #25

https://github.com/Shaan-Barai/MHacks_Barai_Chauhan_Wu_Tompkins/pull/25

- Still a **draft**. Head: `overnight-supabase` at `2a1c972`. Base: `main` (untouched).
- New title: "Supabase migration + forecasting (Runs 1-5)". Description = `MERGE_REVIEW.md`.
- It now contains migrations `…01`–`…18`, matching the live Supabase project.

## 7. Turn on the scheduler (exact steps)

Full guide: `docs/scheduler-setup.md`.

1. **Get the workflow onto `main`:** merge PR #25, or open a small PR with just `.github/workflows/forecast-schedule.yml` and `forecast/scheduled_run.py`. GitHub runs scheduled workflows only from the default branch.
2. **Add the two repository secrets** (GitHub → Settings → Secrets and variables → Actions). Paste the values only into GitHub's prompt:
   ```bash
   gh secret set SUPABASE_URL                 # https://<project-ref>.supabase.co (not the dashboard link)
   gh secret set SUPABASE_SERVICE_ROLE_KEY    # Supabase → Project Settings → API keys → secret key
   ```
3. **Turn it on:**
   ```bash
   gh variable set FORECAST_SCHEDULER_ENABLED --body true
   ```
4. **Test once without writing:**
   ```bash
   gh workflow run forecast-schedule.yml -f dry_run=true
   gh run list --workflow forecast-schedule.yml --limit 3
   ```
   The run's summary should say DRY RUN and list the upcoming meals.
5. **From then on it runs 4 times a day:** 02:05, 10:05, 14:05 and 19:35 UTC. That is 55 min (summer) to 115 min (winter) before each lock.
6. **Turn it off:** `gh variable set FORECAST_SCHEDULER_ENABLED --body false`. Nothing is deleted.

## 8. What to check first

1. **IMG_2706 end to end (3 Gemini calls).** It's the one thing in Task 1 not measured:
   ```bash
   RUN_LIVE=1 node --env-file=../.env live/detection-runs.mjs --runs 1 --max-gemini 4 --photos IMG_2706 --exclude-items 'Halal Rice,Tomatoes,Lettuce'
   ```
   Run it from `tests/`, with the SAM worker running. You should see a timeout, then a fast capped retry, and the pie found.
2. **The privacy fix on `/production`:** the "Checked" column now shows a date, not a name. If any names were typed before today, they were visible to anyone with the link until this deploy.
3. **PR #25 risks 1–3 in `MERGE_REVIEW.md`:** the SQL write functions, the shadow-mode trigger, and what the public key can read.
4. **The scheduler key decision:** turning the scheduler on puts the Supabase service-role key into GitHub secrets. Decide whether that's acceptable before step 2 above.
5. **IMG_2703's label** (your check). It is the one remaining "wrong" detection.
6. **Pass 2 being 2× slower** than pass 1 at equal token counts. It isn't a failure, but it doubles each scan's wait (median 38 s per photo). Worth one experiment, e.g. sending the passes one after the other or pass 1 only, before a real pilot.
