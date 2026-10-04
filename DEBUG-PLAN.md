# DEBUG-PLAN: a debugging session for ScrapSaver

**Started:** 2026-10-04 · **Branch:** work on `debug/<topic>` branches or worktrees, merge to `main` when verified ·
**Status:** planned. Update the tracker (§6) as items move.

This is a working plan for one focused debugging session across the codebase. It lists what is
known to be wrong or suspicious (with the evidence seen so far), how to reproduce each item, who owns
the fix (AGENTS.md §4), and how to prove the fix. It is not a feature plan: anything that turns into
new functionality goes to its own plan.

## 0. Rules for this session

1. **Reproduce first.** No fix without a failing test, script or recorded live observation that shows
   the bug. Put the reproduction in the item's row before changing code.
2. **Fix in the owner's directory** (AGENTS.md §4) and add a regression test there. Cross-module bugs
   get a contract or integration test in `tests/`.
3. **Never wipe live data.** `scrap` (SpacetimeDB) and the R2 bucket hold real captures. Experiment on a
   separate date/service, the JSON or in-memory backend (`SPACETIMEDB_URI=` unset, another `PORT`), or a
   scratch database. To take plates off the dashboard, hide them on the Admin page; don't delete them.
4. **Count Gemini calls.** Each capture costs about 2 calls, each upload-site analysis 2, each dish-match
   check 1. Billing has run out twice (HTTP 402). Prefer fixtures and `--events cap_…` re-shows.
5. **Say what was verified, and how.** Fixture tests, live stack, and real hardware are different claims
   (`docs/verification-report.md`, "Distinction reminder").
6. **One writer per file.** Several sessions have edited this checkout at once (§2, D13). Use a git
   worktree per session (`git worktree add ../mhacks-debug -b debug/<topic>`), commit small, rebase, push.
7. **Keep `demo.py` current** (AGENTS.md §3 rule 13) when a fix changes what the demo shows.

## 1. Baseline (2026-10-04)

**Offline suites** (`./test-all.sh`, 87 s): **all 12 suites pass**. data 40, vision 88, analytics 72,
capture 53, backend 71 (+1 skipped live test), frontend 99, tests 22, python 66, scripts 28, plus the
dashboard build and the module typecheck. The bugs below are therefore not covered by tests: each one
needs a new failing test first. Live suites (`--live`) were not run for this baseline.

**Live stack** (`deploy/local.sh status`): SpacetimeDB :3000 healthy (external), SAM 2.1 :8790 healthy
(external), backend :8787 healthy (`local.sh`, production mode, serves the dashboard). Upload site :8795
running separately. The `scrap` dashboard currently shows 0 plates: all 51 captures were hidden on
2026-10-04 (Admin page), none deleted.

Re-run before starting and after every fix:

```bash
./test-all.sh                 # offline: unit, build, fixture and integration suites
./test-all.sh --live          # + local stack, smoke, live E2E, demo.py --simulate (Gemini + SAM + R2)
deploy/local.sh status        # who runs what
```

## 2. Known bugs and suspects

Priority: **P1** wrong numbers or a broken path a user sees; **P2** reliability or operations;
**P3** rough edges.

| ID | P | Symptom | Evidence so far | Suspected cause | Owner |
| --- | --- | --- | --- | --- | --- |
| D1 | P1 | Real food is drawn as "other dish (not counted)" | `test2/IMG_2695.jpeg` via `demo.py --simulate` (capture `cap_01M42PEMD0GV3KYM1AFKYFCMKA`): the target-dish region is cut along a diagonal across the bowl, and the hatched excluded area covers carrots and rice | target-dish region fit (`target-dish-v1`: filled, dilated SAM dish mask) fails on a bowl seen at an angle or touching the frame edge | Agent 4 `vision/` |
| D2 | P1 | Plate gallery and totals disagree | A test plate with a complete segmentation shows 800 px in `GET /api/captures` but 0 px in `/api/dashboard/impact` (counted as excluded) | The gallery reads `segmentation.capturePixelsWasted`; totals keep only measurements that pass `validMaskCount` (needs `maskCount` provenance). A live capture with bad provenance would show pixels that the totals silently drop | Agents 5 + 6 |
| D3 | P1 | The same physical dish may be counted twice | Halal tray from the real camera: `cap_01M42NEJWGJG9XZX14797RSDCV` (dinner, 05:16:05Z) and `cap_01M42NEZZF6NTYJFC7JVQT3R5C` (lunch, 05:16:19Z), 14 s apart, similar pixels (293k vs 328k) | Bridge dedupe state is per service (`camera:<serviceId>:<groupId>`) and per `--state-dir`; running the bridge for two services over one inbox ingests the same frames twice. Confirm which run produced each | Agent 3 `capture/` |
| D4 | P1 | Stale references after the `_EastQuad` file renames | `menu_waste_factors.csv`, `menu_nutrition_factors.csv` and `dining_hall_menu_labels.*` were renamed on GitHub. Code readers were fixed (`62a9765`, `dbf8b72`), but comments, tests and ~14 docs still name the old files, and `menu_waste_factors_500.csv` is not wired to anything | Rename done outside the code; intent of the 500-food table is unknown | Agent 2 `data/` + Agent 1 docs |
| D5 | P1 | Same photo, different result | The upload site's sample bowl gave 143,969 px, then 127,853 px (−11%) and 143,969 px again. Halal Rice 114,588 vs 97,235 | Gemini box sets vary between runs (two localization passes merged by IoU); SAM output follows the boxes | Agent 4 `vision/` |
| D6 | P2 | Captures fail in bulk when Gemini billing runs out | 13 of 16 dinner captures on 2026-10-04 `failed` with `GEMINI_BILLING` (HTTP 402); retried only by hand (`backend/scripts/retry-failed.mjs`) | No preflight or alert; failed captures wait for a manual retry | Agent 5 `backend/` |
| D7 | P2 | Running services keep old code or data | After the catalogue change, the running backend still had the old factor table (Halal Rice "no factor") until restarted; the upload site on :8795 served the old page | Nothing reports which build or factor version a running process has | Agent 5 + Agent 1 (`deploy/`) |
| D8 | P2 | All new captures fail if the laptop sleeps | SAM 2.1 runs only as a local process on :8790 (`vision/sam/worker.py`, MPS) | Single local worker, no supervisor; `ps` shows the framework Python binary, so check that the `.venv` is actually used | Agent 4 + `deploy/` |
| D9 | P2 | `demo.py` prints a misleading "token was refused" line | Any 401 from `demo.get` prints the SCRAP_INGEST_TOKEN hint, even for admin-only routes that are meant to refuse it | Generic 401 hint in the request helper | `demo.py` |
| D10 | P3 | Python HTTPS calls fail on this Mac | `urllib` to the R2 signed URL raised `CERTIFICATE_VERIFY_FAILED` (python.org Python 3.14 without its CA bundle); `demo.py` now downloads with `curl` | Missing `Install Certificates.command` step; other Python scripts may hit it | scripts, docs |
| D11 | P3 | Port checks miss the dev dashboard | Vite listens on `[::1]:5173` only, so `127.0.0.1:5173` checks fail | Vite default host resolution | Agent 7 `frontend/` |
| D12 | P3 | Camera photos are unusable | The live capture step returned a blurred close-up of the table; the C920 was face-down. The 16:9 frame is center-cropped to a square, so plates near the left or right edge are cut | Mount, focus lock (IT_4 K), framing; no blur or "no plate" check before upload | Agent 3 `capture/` |
| D13 | P3 | Work gets tangled between sessions | Several sessions edited this checkout at once; one session's uncommitted `data/` edits disappeared between two `pull --rebase --autostash` runs (no data lost, but no one noticed) | Shared working tree | Process (§0 rule 6) |
| D14 | P3 | Edge cases in the new admin curation | `retry-failed.mjs` lists plates through the public API, so it never retries a hidden failed plate; the admin list stops at 200 plates per window | Design limits of the first version | Agent 5 |
| D15 | P3 | Upload-site results disappear | Results pages live in memory (last 20) and vanish on restart; one analysis at a time | By design; confirm the copy says so and that a queue wait doesn't time out the browser | `upload_demo/` |

## 3. How to reproduce each P1

- **D1 (target-dish clip):** `python3 demo.py --events cap_01M42PEMD0GV3KYM1AFKYFCMKA --only storage,images`
  writes the before/after picture. Offline, run vision's mask pipeline on the stored masks and image
  (`vision/test` fakes) and assert that the dish region contains the food boxes. Then try 3 more `test2/`
  bowls and plates.
- **D2 (gallery vs totals):** a backend test with one succeeded capture whose segmentation is complete
  but whose measurements lack `maskCount`. Assert what the gallery and `/api/dashboard/impact` return.
  Decide on one rule (show "not counted" in the gallery, or count it everywhere).
- **D3 (double count):** check both captures' `image_object` rows and inbox folders
  (`spacetime sql --server local scrap "SELECT object_key FROM image_object WHERE association_id = '<eventId>'"`).
  Then reproduce with `simulate-camera` into one inbox and two bridge runs for two services.
- **D4 (renames):** `git grep -nE "menu_waste_factors\.csv|menu_nutrition_factors\.csv|dining_hall_menu_labels\.(csv|pdf)"`.
  Ask the teammate whether `_EastQuad` means "per hall" and what `menu_waste_factors_500.csv` is for
  before renaming anything else.
- **D5 (variability):** run the upload site's `/api/analyze` 5 times on `demo_pictures/0_input_photo.jpg`
  (10 Gemini calls), then record the box count, per-food pixels and spread. Compare with `GEMINI_PASSES=1`.

## 4. Session plan

| Phase | Time | Work | Done when |
| --- | --- | --- | --- |
| 0. Setup | 15 min | Worktree per person, `./test-all.sh` baseline, `deploy/local.sh status`, note Gemini billing state | §1 filled in |
| 1. Triage | 45 min | Reproduce D1–D5 (§3); write the failing test or script for each; downgrade anything that won't reproduce | Each P1 row has a reproduction link |
| 2. Fix P1 | 2–3 h | One owner per item, in their directory, with a regression test | Item's test passes, `./test-all.sh` green |
| 3. P2 sweep | 1 h | D6–D9: billing preflight/alert, build+factor version in `/api/health`, SAM supervision, demo hints | Each has a test or a documented decision |
| 4. Live check | 30 min | `./test-all.sh --live`; one real Uno Q plate through `demo.py`; Admin page hide/show on a test plate | Live results recorded with capture ids |
| 5. Report | 15 min | Update §6, `docs/verification-report.md`, and close or carry over items | Every item is fixed, deferred with a reason, or rejected |

## 5. Toolkit

| Need | Command |
| --- | --- |
| All tests | `./test-all.sh` · one suite: `./test-all.sh --only backend` · list: `--list` |
| Stack status / logs | `deploy/local.sh status` · logs in `deploy/.run/logs/` (backend logs are JSON lines) |
| Restart backend after code or factor changes | `deploy/local.sh restart` (rebuilds data/vision/analytics/backend/frontend) |
| Re-show captures without new Gemini calls | `python3 demo.py --events cap_A,cap_B --only analysis,storage,images,stats` |
| Full pipeline without the board | `python3 demo.py --simulate --yes` (labeled `replay`) |
| Real camera | `python3 capture/scripts/live_camera_test.py --target arduino@35.1.88.76 --stage camera` |
| Database rows | `spacetime sql --server local scrap "SELECT … FROM capture_event / analysis_attempt / food_measurement / image_object / capture_visibility"` |
| One capture, full detail | `curl -s localhost:8787/api/captures/<eventId>` · images: `…/<eventId>/images` |
| Retry failed analyses (same eventId) | `node backend/scripts/retry-failed.mjs --start <date> --end <date> --dry-run` first |
| Workers | `curl -s 127.0.0.1:8790/health` (SAM) · `curl -s localhost:8787/api/ready` |
| Show or hide plates | Dashboard → Admin (staff sign-in) |

## 6. Tracker

| ID | State | Reproduction | Fix (commit) | Verified how | Notes |
| --- | --- | --- | --- | --- | --- |
| D1 | open | | | | |
| D2 | open | | | | |
| D3 | open | | | | |
| D4 | open | | | | |
| D5 | open | | | | |
| D6 | open | | | | |
| D7 | open | | | | |
| D8 | open | | | | |
| D9 | open | | | | |
| D10 | open | | | | |
| D11 | open | | | | |
| D12 | open | | | | |
| D13 | open | | | | |
| D14 | open | | | | |
| D15 | open | | | | |

### Log
- 2026-10-04: plan created from issues seen while building `demo.py`, the catalogue change, the upload
  site and the admin panel.
