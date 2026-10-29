# Run 4 report (`run4`, 2026-10-28)

**Secret scan: clean**, so `run4` was pushed to origin as a backup. No PR was opened and nothing was merged.
- The scan covered all 335 commits on every branch, including commit messages. It found 0 matches against the real `.env` values (and the database password on its own), and 0 strong-pattern hits in Run 4's changes.
- The 35 weak pattern hits are the 32 reviewed in Run 3 plus 3 lines of the Run 3 log that quote test fixtures and code (`sb_secret_example`, `sb_secret_THIS_MUST_NOT_SHIP_0000`, `TOKEN = os.environ.get`).

**Commits** (branch `run4`, from `forecast-v2` `79bfa6f`):

| Commit | What |
|---|---|
| `54bbaee` | Task 1 |
| `108ee02` | Task 2 |
| `8290727` | Task 3 |
| `4adaafa` | Task 4 |
| `4d08f97` | Task 5 |
| — | this report |

`./test-all.sh` passed before every commit (the last run: forecast 85, vision 104, backend 133, frontend 141, tests 26). Note: the laptop slept once during Task 3. Nothing was lost; I resumed and committed.

## 1. What got done

| Task | Result |
|---|---|
| 1. Per-meal menu | The 12 photos are all from **one dinner** (EXIF 19:47–19:53, 2026-10-03). **Stations are not recorded anywhere.** That dinner's menu had 23 foods. Scored with it: **recall 94.4%, precision 94.4%** (vs. 94.4% / 81.0% with the 26-food test menu). Production already uses each service's own menu; no code change. |
| 2. Gemini timeout | Default `GEMINI_TIMEOUT_MS` 30000 → **90000** (`vision/src/gateway.ts`), with a test of the default. `.env.example`, `vision/README.md` and the detection doc updated. |
| 3. Honest backtests + shadow mode | Day-ahead weather **forecasts** are stored apart from observed weather (`context_day.fc_*`). Backtests can only see the forecast, and a test fails if one reads the target day's observed weather. Forecast rows get `created_at`/`locks_at`, and a database trigger rejects changes once the meal's service starts. New `python -m forecast.shadow_report`. Migration `…17` applied live. |
| 4. Plate estimates | **6 of 6** hall-main scans now have a usable plate measurement (6 Gemini calls). Pixel totals are identical before and after. Estimated food left: **≈ 2.1 lb (ESTIMATE)**. Migration `…18` applied live. |
| 5. Calibration checklist | `docs/camera-calibration-checklist.md`. No code was broken. One stale doc step (a removed Settings panel) was fixed in `docs/calibration.md`. |

## 2. Detection numbers: exactly what was measured

The same 12 real photos (`test2/`, IMG_2705 not scored), 18 labeled foods, `images/ground_truth.csv`, scoring rules unchanged. Model `gemini-3.8-flash`, seed 42, temperature 0, 2 passes, 90 s timeout. Pipeline: Gemini → SAM 2.1 → target-dish counting, in memory (`tests/live/detection-runs.mjs`), with **no Supabase or R2 writes**.

| Menu offered | Runs | Correct | Missed | Wrong | Recall | Precision |
|---|---|---|---|---|---|---|
| 26-food test menu (Run 3) | 3, identical | 17 | 1 | 4 | 94.4% | 81.0% |
| **23-food menu of that dinner (Run 4)** | **1** | **17** | **1** | **1** | **94.4%** | **94.4%** |
| 23-food, 2026-10-03 experiment (older pipeline) | 2 | 36 / 36 | 0 | 3 | 100% | 92.3% |

- **Remaining errors with the 23-food menu:**
  - IMG_2703 + Sticky Rice (wrong). The same happened in the 2026-10-03 experiment; is there rice on that plate?
  - IMG_2706: pie missed. Gemini's **second pass timed out on all 3 attempts, even at 90 s**, and a re-run of that photo did the same. With the 26-food menu both passes finished and the pie was found. So this looks like a timeout effect, not a menu effect.
- **Fixed by the per-meal menu:**
  - IMG_2700 + Lettuce, IMG_2703 + Halal Rice and IMG_2702 Cheese Bread (instead of Pepperoni Pizza) are gone.
  - IMG_2696's extra Cheese Bread also disappeared, although Cheese Bread is on both menus. Part of the effect is that a different menu list changes the fixed-seed answer.
- **Cite with care:** one run, 12 photos, 18 foods, one dinner, labeled by the team. The full per-photo table is in `docs/detection-accuracy.md` → "Per-meal menu".

## 3. Not done, or done differently, with exact errors

- **Per-station menus: not possible.** No station is recorded per photo: `ground_truth.csv` has only `Image_name` and the foods, and the photo files carry only a time. Scoring by station would need a station column in `ground_truth.csv` (or a station on each capture). I did not infer stations from the labeled foods.
- **The Historical Forecast API was not used.** Open-Meteo's docs say it is "built by stitching the first hours of each successive model run". So part of a day can come from runs issued during that day, after a service started. I used the Previous Runs API's `_previous_day1` instead, where every hour was forecast 24 h ahead, so the whole day was known before breakfast. This was a deliberate change to the brief's wording, made to meet its intent.
- **No locked forecast has been scored yet.** All 1,008 existing forecast rows (all simulated) were written before shadow mode, so they are marked `lock_tracked = false` and never count as locked. A live report run says:
  ```text
  nothing scored (this window's inputs are SIMULATED)
  forecast rows: locked 0, late 0, before shadow 396, not started 24
  ```
  The report logic is tested on synthetic rows (locked, late, pre-shadow, not started; matched stockouts; SIMULATED label). The database lock is tested offline in Postgres (PGlite, 15 checks): no updates after the start, no backdating, simulated rows still removable, upserts can't revise.
- **IMG_2706 timeout:** `GEMINI_TIMEOUT` on pass 2, 3 attempts × 90 s, twice. 90 s is the new default but is still not always enough.
- **The gbm-v1 simulated result changed.** It now reads forecast weather: WAPE went 17.8% → 18.6%, and the 10–90% coverage is 89%. The simulated demand ignores weather, so the new features can only add noise; this says nothing about real weather. The new run is stored as `bt_3aa03e8682a2`; the old one is kept. The other models are unchanged.
- **Small error I hit and fixed:** `./test-all.sh` failed once on `stale data filenames … docs/detection-accuracy.md:34` (I had written the dinner factor table's old, pre-`factors/` file name). I reworded it; everything passed.
- **`demo.py` not run live** (it needs the full local stack). Nothing in Run 4 adds a dashboard feature; the shadow report is a CLI.

## 4. Decisions made on your behalf

All 14, with reasons: `docs/PROGRESS.md` → Run 4 → "Decisions made on my behalf". The main ones:

1. **Logs moved to `docs/`** on `run4` too (they were still at the root on `forecast-v2`), so the branches agree with PR #25.
2. **"That meal's menu" = 23 foods:** the menu in the repo on the night of the photos. The 3 extra foods were added the next morning "for the live demo", and nothing records them as served that night.
3. **Previous Runs API (24 h ahead) instead of the Historical Forecast API** (see §3).
4. **Simulated days got a SIMULATED day-ahead forecast** (observed ± up to 6 °F; `fc_source = 'simulated'`). Real Open-Meteo forecasts went only on real days: 47 days, 2026-08-01..10-28 outside the simulated window. On 46 real days with both values, the forecast high was off from the observed high by 2.8 °F on average.
5. **Lock rules:**
   - The lock time is the meal's start (07:00 / 11:00 / 16:30, the hall's time zone; a test keeps it equal to `config.toml`).
   - After it: no updates, and no deletes of real rows. Simulated rows stay removable.
   - `created_at` always comes from the database clock.
   - The worker only revises services that haven't started.
   - Pre-existing rows never count as locked (conservative).
6. **Matched stockouts in the shadow report** scale the locked amounts by one shared factor k, which is reported; stored rows are never changed.
7. **Plate backfill re-ran only Gemini pass 1** (the pass the pipeline takes its plate box from: same prompt, seed and menu version, same stored photo) instead of a full re-analysis. That made 6 calls instead of 12, with no new analysis attempts, so pixels could not change. The rows are marked `box_source = 'backfill-pass1'` (new additive column).
8. **The checklist asks for a non-payment card of credit-card size, number side down,** because the calibration photo is uploaded to image storage.

## 5. Gemini calls

**36 of 40:**
- 26: Task 1, the full 23-food run;
- 4: Task 1, the IMG_2706 re-run;
- 6: Task 4, plate backfill.

Everything else used mocks.

## 6. Plate estimates (ESTIMATE: assumes every plate is 26.7 cm / 10.5")

| Scan | Plate diameter (px) |
|---|---|
| `cap_01M41SQNGQBS5D91961NCJZYHZ` | 768.5 |
| `cap_01M41SQSXNPHK1KQX6JP1R183C` | 724.5 |
| `cap_01M41SQYV7BWV0YK2HDTHD6CKK` | 816.6 |
| `cap_01M41SR2VXM46T0BVY6DGHWY8E` | 679.9 |
| `cap_01M41SRAKCGX20M3J50H284GA6` | 736.8 |
| `cap_01M41SRDZNW435X156A308GXEY` | 783.4 |

All 6 are fully visible round plates.

- **Pixels wasted, unchanged:** 748,986 px counted on the dashboard. All 12 stored attempts total 1,531,798 px, before and after.
- **Estimated food left: ≈ 2.14 lb in total**, from `GET /api/dashboard/estimated-weight`. Largest: Chicken Caesar Wrap 0.63 lb, Sticky Rice 0.45 lb, Beef Tacos 0.34 lb.
- 170,667 px (Belgian Waffles, Margherita Flatbread, and food not on the menu) have no grams-per-cm² factor, so they get no pounds.
- If the real plates are 9", every pound figure is about 1.36× too high.

## 7. What to check first (ranked)

1. **Plate size.** Measure a real plate. `PLATE_DIAMETER_CM` (26.7) drives every pound number in §6.
2. **IMG_2703's label.** Both menus report rice there. If rice really is on the plate, the label is incomplete and that photo's "wrong" is actually correct.
3. **`docs/camera-calibration-checklist.md`:** read it once before the hall visit. Height 43–45 cm, focus locked, card centred, and the tape-measure check within ±3 cm.
4. **Migrations `…13`–`…18` are live in Supabase but not on PR #25's branch.** Merge `run4` (which contains `forecast-v2`) into the PR, or follow up with it.
5. **The weather-API switch (§3):** confirm that using the Previous Runs API's 24-hour-ahead forecasts instead of the Historical Forecast API is what you want.
6. **Shadow mode starts now.** From today, forecasts the worker writes before a meal are locked at its start. After a few real services with production sheets, run `python3 -m forecast.shadow_report --hall hall-main --start … --end …`.
7. **Station per photo:** if you want per-station menus tested, add a `station` column to `images/ground_truth.csv`.
