# Run 3 report (forecast-v2, 2026-10-28)

**Secret scan: clean** (details in §2 and `docs/PROGRESS.md`), so the pushes in Phase 8 went ahead:
- **Draft PR:** https://github.com/Shaan-Barai/MHacks_Barai_Chauhan_Wu_Tompkins/pull/25 (`overnight-supabase` → `main`, description = MERGE_REVIEW.md).
- **`forecast-v2`** is pushed as a backup branch, with no PR.
- Nothing was merged.

Commits on `forecast-v2`: `bb99709` (Phase 1), `b3d7a33` (3), `e4eae5e` (4), `25a3044` (5), `55e42fc` (2), `f676bc4` (6), `1214e0f` (7), `ec49dc6` (scan log), plus this report. `./test-all.sh` passed before every commit.

## 1. What got done

| Phase | Result |
|---|---|
| 1. Quick fixes | `production_log` is private (migration `…13`, applied live; live RLS test 5/5). The 4 `hall-e2e-*` captures are **hidden, not deleted** (`cap_e2e_musw1war`, `cap_e2e_musw2fuw`, `cap_e2e_musw3a06`, `cap_e2e_musw3m68`) via `capture_visibility`. **9** hall-main services got simulated attendance via `backfill-attendance.mjs`. |
| 2. Detection regression | Cause found: the test menu grew 23 → 26 foods (`4f23615`). 3 identical runs: 94.4% / 81.0%, no variation. Isolation run confirms it. `docs/detection-accuracy.md` written; the live test's baseline is now menu-specific. |
| 3. Real context | `forecast/context_import.py` + sourced data files + migration `…14`. 262 real rows for hall-main (Aug 2026–May 2027), each with source URLs, `is_simulated = false`. |
| 4. M-Dining importers | `forecast/importers/` covers swipes, FSS and a production-sheet batch: TOML mappings, dry run, validation reports, `sample_SIMULATED_*` files, 14 tests (0 Gemini calls). `docs/data-intake.md` written. |
| 5. Pixels → pounds | `plate-scale-v1`: plate diameter from the AI dish box, a configurable assumed diameter (26.7 cm), cm² per px, grams per food, pounds. Stored per scan (migration `…15`), returned by `GET /api/dashboard/estimated-weight`, shown on a Statistics card with an assumptions tooltip, and fed to forecast tray waste under the ≥ 80% rule. Pixel totals are unchanged (tested). |
| 6. Models + evaluation | 5 models, walk-forward backtest with a no-look-ahead poison test, WAPE/bias/stockouts/leftover (default and matched)/interval coverage, clustering and anomaly helpers (off), migration `…16`, `GET /api/forecast/models`, and a Forecast page section with a SIMULATED banner (checked in Chrome). |
| 7. Methods write-up | `docs/forecasting-methods.md`. |
| 8. Safety + backup | Full-history scan clean; logs moved to `docs/` on `overnight-supabase`; pushed; draft PR #25. |

## 2. What didn't, with exact errors

- **Religious holidays only partly sourced:**
  - `timeanddate.com` returned **HTTP 403 Forbidden**.
  - The Provost religious-holiday Google Calendar ICS (`umich.edu_u72vhq6knrh0c4b2kh1mljh34s@group.calendar.google.com`) returned **"Error 404 (Not Found)"**.
  - So Diwali, Easter/Good Friday, Lunar New Year and Holi are **not included**. Jewish holidays (Hebcal) and Ramadan/Eid al-Fitr (Aladhan, calculated dates) are in.
- **Weather** exists only up to ~2026-11-12, the end of Open-Meteo's 16-day forecast. Later dates are null by design. Re-run the importer to extend it.
- **Context for the 42 simulated hall-main days** (2026-09-12..10-23) was not written, because those dates hold simulated rows. Four home games fall there. Re-run the importer after `python3 -m forecast.simulate remove --hall hall-main`.
- **Old scans have no plate scale.** The 6 hall-main scans were analyzed before plate-scale existed, so their pounds show "—". Adding it means re-analysis (about 12 Gemini calls), which I didn't do.
- **Detection first attempt:** stopped after 4 photos. IMG_2696 and IMG_2697 each failed both passes with `GEMINI_TIMEOUT` (default 30 s, 6 calls each). The runs then used `GEMINI_TIMEOUT_MS=90000`.
- **Errors I hit and fixed:**
  - `AttributeError: 'list' object has no attribute 'shape'`, then `ValueError: window shape cannot be larger than input array shape`. scikit-learn 1.9.1 needs numpy arrays and fails on a feature column with fewer than 2 distinct values; such columns are now dropped at fit time.
  - After switching branches, stale compiled tests in the gitignored `dist/` folders failed on `overnight-supabase` (`s.repo.listPlateScales is not a function`). I removed those 4 build files; everything passed.
- **`demo.py`** got a plate-scale line in its stats step, but was **not run live** (it needs the full local stack). Its syntax and `--list` pass in test-all.

## 3. Decisions made on your behalf

Full list with reasons: `docs/PROGRESS.md` → Run 3 → "Decisions made on my behalf". The ones that matter most:

1. **Detection:**
   - No "fix" to the pipeline or menu. Removing real menu foods to raise the score would be gaming it.
   - The regression baseline is now the measured 26-food result; the old 23-food figure is kept, labeled as not comparable.
   - The production default `GEMINI_TIMEOUT_MS` (30 s) is **not** changed (recommended: 60–90 s).
2. **Plate scale despite AGENTS.md** saying plate calibration was dropped: built as a separate, labeled estimate because you asked.
   - The diameter comes from Gemini's box: a fully visible plate only, box ratio ≤ 1.25.
   - It is stored in a new private table. `record_analysis` and SpacetimeDB are untouched.
   - The card is on **Statistics**, not the Dashboard: a Dashboard test encodes "no pixels on the Dashboard".
3. **Hiding test halls:** I used the existing `capture_visibility` mechanism and added no `hall.hidden` column (there is no hall picker).
4. **Importers:**
   - Mappings are TOML (standard library), and XLSX is read with the standard library.
   - Imports never overwrite simulated rows; they skip and report them.
   - FSS dishes match by exact normalized name or approved alias only, and are never created.
5. **Context:** real rows only for non-test halls (hall-main); simulated days are skipped. "Between terms" break days are derived, and marked so.
6. **Models:**
   - The same error-based interval method for every model.
   - All models are scored on the same 291 dish-meals.
   - The matched-stockouts target is the comparison forecast's stockouts.
   - scikit-learn 1.9.1 is installed into `.venv` only (optional; see `forecast/requirements-models.txt`).
7. **`forecast_model_comparison` is dashboard-readable** (no personal data). `plate_scale_estimate` is private.

## 4. Gemini calls used

**97 of 150**, all in Phase 2:
- 16: the stopped first attempt;
- 77: 3 runs;
- 4: the 23-food isolation check.

Every other phase used 0 (mocked tests only).

## 5. Detection accuracy (REAL photos)

- 12 scored real plate photos, 18 labeled foods, 26-food menu, `gemini-3.8-flash`, seed 42, temperature 0, 2 passes:
  - **recall 94.4%, precision 81.0% in all 3 runs** (17 correct, 1 missed, 4 wrong each); mean 94.4% / 81.0%, range 0.
- **Errors, the same every run:**
  - IMG_2696 +Cheese Bread;
  - IMG_2700 +Lettuce;
  - IMG_2702 Cheese Bread instead of Pepperoni Pizza;
  - IMG_2703 +Halal Rice (only stir fry is labeled).
- **Cause:** the 3 foods added to the test menu on 2026-10-04. With the original 23-food menu, IMG_2700 and IMG_2702 are both correct (measured).
- The old 100% / 92.3% came from a 2-run experiment on the 23-food menu.
- Full write-up: `docs/detection-accuracy.md`. Cite it with its sample size.

## 6. Model comparison (SIMULATED: made-up data, not M-Dining)

hall-main, 2026-09-26..10-23, 291 dish-meals (48 ran out, censored). Stored as run `bt_52fc7817e167`.

| model | mode | WAPE | bias | stockouts | leftover lb | leftover $ | 10–90% coverage | mean q |
|---|---|---|---|---|---|---|---|---|
| baseline-v1 | default | 18.3% | 1.7% | 21 | 3,558 | $16,404 | 80% | 0.900 |
| baseline-v1 | matched | 18.3% | 1.7% | 48 | 2,797 | $13,006 | 80% | 0.826 |
| seasonal-naive-v1 | default | 22.3% | -1.2% | 41 | 3,847 | $18,032 | 76% | 0.900 |
| seasonal-naive-v1 | matched | 22.3% | -1.2% | 48 | 3,452 | $16,255 | 76% | 0.874 |
| moving-avg-4-v1 | default | 19.6% | -0.3% | 36 | 3,048 | $14,529 | 77% | 0.900 |
| moving-avg-4-v1 | matched | 19.6% | -0.3% | 48 | 2,784 | $13,362 | 77% | 0.869 |
| exp-smoothing-v1 | default | 21.7% | -1.3% | 28 | 4,288 | $19,744 | 79% | 0.900 |
| exp-smoothing-v1 | matched | 21.7% | -1.3% | 48 | 3,236 | $15,102 | 79% | 0.809 |
| gbm-v1 | default | 17.8% | -0.4% | 10 | 5,132 | $22,148 | 88% | 0.900 |
| gbm-v1 | matched | 17.8% | -0.4% | 48 | 2,959 | $12,867 | 88% | 0.790 |
| Simulated FSS (+25% over-prep) | as given | 41.6% | 41.6% | 48 | 4,030 | $19,272 | — | — |

The simulated FSS was built to over-prepare, so beating it means nothing. Gradient boosting's range is too wide (88% vs. the 80% target).

## 7. What to send M-Dining (from `docs/data-intake.md`)

1. **Meal swipes:** one row per swipe (location + date/time), or counts per ≤ 15 minutes per location. No student names, IDs or card numbers. As many past terms as possible (at least Fall 2025 to now).
2. **FSS forecast export:** hall, date, meal, recipe name, forecast quantity and unit (lb/oz/kg/g/portions), plus portion weights if in portions. Same period.
3. **Production records:** photos or scans of the handwritten production sheets (ideally named `YYYY-MM-DD_meal_….jpg`), or a typed export with dish, station, meal, date, lb prepped, lb left in the pan and ran-out time.
4. **The recipe/dish list** with FSS names and portion weights, so names match exactly.
5. **Optional:** meal-period hours per hall, closures and special events, menu-cycle week numbers.

CSV or XLSX both work. Every import starts with a dry-run validation report.

## 8. What to check first (ranked)

1. **PR #25** (draft): read MERGE_REVIEW risks 1–3 (the SQL write functions, anon access, key handling).
   - `production_log` is now private **on `forecast-v2`** (migration `…13` is applied live), but the PR branch doesn't contain that migration file yet. Merge `forecast-v2` into the PR or follow up, so the repo matches the live database.
   - **The same applies to migrations `…14`–`…16`, which are live in Supabase but only on `forecast-v2`.**
2. **`docs/detection-accuracy.md`** before citing numbers. Re-check IMG_2703's label: is there rice on the plate?
3. **The plate-scale assumption:** the 26.7 cm default (`PLATE_DIAMETER_CM`). Tell me the real plate sizes; a 9" plate makes the estimate about 1.36× too high.
4. **Gemini timeout:** consider `GEMINI_TIMEOUT_MS=60000–90000` for scans (30 s dropped 2 of 4 photos tonight).
5. **`docs/data-intake.md`:** ready to send to M-Dining. Check the wording.
6. **Context data:** the hidden test halls got no context, and four home games sit on simulated days. Both are intended, but re-run the importer after removing the simulated data.
7. **`docs/forecasting-methods.md`:** check the claims and tone before sharing.

## 9. PR link

https://github.com/Shaan-Barai/MHacks_Barai_Chauhan_Wu_Tompkins/pull/25 (draft, `overnight-supabase` → `main`). `forecast-v2` is pushed as a backup branch with no PR.
