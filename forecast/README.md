# Forecast worker (baseline + prep buffer)

Forecasts how many pounds of each dish to prep for each meal, from confirmed production history,
meal-swipe attendance and the 6-week menu cycle, and evaluates those forecasts once the meals have
happened. Python standard library only; reads and writes Supabase with the **service role key**
(server only, never printed).

```bash
# Forecast a date range (each day uses only data from before it):
python3 -m forecast.worker run --hall hall-main --start 2026-10-25 --end 2026-10-31 [--dry-run]
# As a local service (same shape as the SAM worker): GET /health, POST /run {hallId,start,end,dryRun?}
python3 -m forecast.worker serve            # http://127.0.0.1:8791

# Score past forecasts against what happened (writes forecast_outcome):
python3 -m forecast.evaluate --hall hall-main --start 2026-09-26 --end 2026-10-23 [--dry-run]

# Printable prep sheets (one HTML page per station per meal) -> forecast/out/:
python3 -m forecast.prep_sheet --hall hall-main --date 2026-10-25

# SIMULATED test data (every row is_simulated = true) and its removal:
python3 -m forecast.simulate generate --hall hall-main [--weeks 6] [--end 2026-10-23]
python3 -m forecast.simulate remove --hall hall-main

# Unit tests (no database):
python3 -m unittest discover -s forecast/tests -t .
```

Environment: `SUPABASE_URL` (the API address, `https://<ref>.supabase.co`),
`SUPABASE_SERVICE_ROLE_KEY`, optional `FORECAST_PORT`, `WORKER_HOST`, `WORKER_TOKEN`,
`FORECAST_CONFIG`. Simulation uses `ATTENDANCE_MIN`, `ATTENDANCE_MAX` and `ATTENDANCE_SEED`.

## Model `baseline-v1` (`model.py`)

1. **Baseline:** the same dish on the same cycle day one cycle ago (6 weeks). If there is none, the
   dish's recent average for that weekday and meal, then for that meal on any weekday, then the
   hall's average dish for that weekday and meal.
2. **Ran-out meals are censored:** when a dish ran out, what left the pan is only a lower bound on
   demand ("at least this much"). A ran-out baseline uses the larger of that and the recent average.
   The error spread keeps such a meal only when it already exceeds the forecast.
3. **Attendance:** demand = baseline × expected diners ÷ diners at the baseline meal (so it equals
   expected diners × take rate × portion lb). Expected diners = the average of the last 4 same-weekday
   meals.
4. **Eaten:** expected eaten lb = demand × (1 − tray waste share). The share comes from calibrated
   scans (calibrated area × the dish's g/cm² from the factors table) and only for meals where scans
   cover at least 80% of diners. Otherwise it is 0, and the worker says so in its notes.
5. **Prep buffer (newsvendor):** recommended prep = the q-th percentile of demand, with
   q = Cu ÷ (Cu + Co). Cu = cost of running out per lb, derived from the service level for the dish's
   type in `config.toml` (so a typical dish gets exactly that level). Co = food
   cost + the dish's Waste Impact Score (`impact_score_usd_per_kg` in `factors/menu_waste_factors_*.csv`,
   ÷ 2.2046). The percentile comes from this model's walk-forward relative errors over the last 42 days;
   with fewer than 5 errors it uses a ±25% normal spread. Low/high = the 10th/90th percentiles.
   **Default service levels** (conservative starting points, explained in `config.toml`): entrée 0.95,
   side 0.90, self-serve 0.85, dessert 0.85. A dish with a higher Waste Impact Score gets a slightly
   lower q. No mid-meal refill of any station is assumed.

6. **Context (optional, OFF by default):** with `[context] enabled = true` in `config.toml`, expected
   diners are adjusted for exam weeks, home games and holidays recorded in `context_day`. Each flag's
   effect is *estimated from this hall's own history* (diners on past flagged days ÷ the same weekday
   and meal without the flag). It needs at least `min_days` past examples, multiplies across flags, and
   is clamped. No accuracy gain is claimed: there is no real data yet to test it on.

Each `forecast` row stores its demand, q, basis and a one-line `why`. The comparison forecast (the
dining hall's FSS) is stored as `forecast` rows with `model_version = 'fss'`. While those rows come from
the simulator they are labeled **"Simulated FSS (assumed +25% over-prep)"** everywhere: the evaluation
output, the API (`comparisonLabel`) and the Forecast page. Real FSS numbers replace them once an export
exists.

## Evaluation (`evaluate.py`)

Two modes, both printed by default (`--mode default|matched|both`):

- **default:** our stored forecasts at the configured service levels vs. the comparison forecast.
  Writes `forecast_outcome`.
- **matched:** a fair leftover comparison. Every dish's q moves together (one shared shift in
  log-odds, so dish types keep their differences) until our stockouts are no more than the comparison
  forecast's. Then leftover lb and $ are compared at equal stockouts. Computed in memory; writes
  nothing.

Metrics:

- **WAPE:** Σ|forecast − consumed| ÷ Σ consumed, over meals that did not run out. Ours is scored on
  its demand forecast; the comparison forecast on its own.
- **Stockouts:** meals where the prep amount would not have covered demand. A ran-out meal prepped at
  exactly that amount counts.
- **Leftover lb:** what the prep amount would have left in the pan on meals that did not run out (the
  same formula for both forecasts).
- **Costs:** pan leftover and tray waste are converted to $ with Co. Tray waste in lb exists only from
  calibrated scans, or labeled `simulated`.

It reads whatever is in the tables, so it runs on real data with no code changes.

## Simulated data

`simulate.py` writes one invented dataset so the pipeline can run end to end before real production
sheets exist. Every row gets `is_simulated = true`, the dashboard shows a SIMULATED DATA banner, and
`remove` deletes only those rows. Its assumptions (attendance pattern, take rates, a "Simulated FSS" that
over-preps by about 25%, 4–14% tray waste) are listed at the top of the file. **None of its numbers
describe a real dining hall.**

## Model comparison (Run 3)

```bash
.venv/bin/python -m forecast.backtest --hall hall-main --start 2026-09-26 --end 2026-10-23 [--no-gbm] [--write]
```

- **Models** (`forecast/models.py`, each under its own `model_version`): `baseline-v1` (production), `seasonal-naive-v1`, `moving-avg-4-v1`, `exp-smoothing-v1`, and `gbm-v1`.
  - `gbm-v1` is a scikit-learn `HistGradientBoostingRegressor` on calendar, context and lag features, retrained weekly.
  - scikit-learn is optional: `.venv/bin/python -m pip install scikit-learn` (see `requirements-models.txt`). Without it, `gbm-v1` is skipped with a note.
- **Walk-forward with no look-ahead:**
  - Every forecast goes through a `PastView` cut at its day. A model that asks for later data raises `LookAheadError`.
  - `forecast/tests/test_backtest.py` poisons the future with absurd rows and fails if any earlier forecast moves.
- **Intervals:** prep amounts and the 10–90% range come from each model's own past relative errors (same meal, last `error_window_days`). With fewer than 5 errors, a default ±25% spread is used.
- **Censored meals:** ran-out meals stay censored. They are left out of training targets for the new models, and out of WAPE and bias. They count as stockouts by `model.evaluate`'s rule.
- **Metrics** (every model on the same meals):
  - WAPE and bias;
  - stockouts and pan leftover (lb, $) at default service levels;
  - the same at **matched stockouts** (each model's q shifted until its stockouts ≤ the comparison forecast's);
  - 10–90% interval coverage.
- **Output:**
  - `forecast/out/model_comparison[_SIMULATED]_….json`;
  - `--write` stores it in `forecast_model_comparison`;
  - the Forecast page shows the latest run, under a SIMULATED banner when built from simulated rows.
- **Unsupervised helpers** (`forecast/unsupervised.py`), both **off** in `config.toml`:
  - `[clustering]`: k-means day types from attendance profile + context, computed per fold from past days only;
  - `[anomaly]`: a robust z-score on confirmed production rows. Flagged rows are listed for review and left out of training, never deleted.

## Honest backtests and shadow mode (Run 4)

- **Weather in backtests is the forecast, never what happened.**
  - `context_day.fc_*` (migration `20261028000017`) holds the day-ahead forecast: Open-Meteo's Previous Runs API, `_previous_day1` (each hour forecast 24 h before it; daily max temperature and total rain). It is filled by `python3 -m forecast.context_import`, and each row keeps its `fc_source_url`.
  - Simulated days get a SIMULATED forecast (`fc_source = 'simulated'`, `python3 -m forecast.simulate fill-forecast-weather`).
  - The observed columns (`temp_high_f`, `precip_in`) are unchanged.
  - `PastView.forecast_weather_on(day)` is allowed up to the target day. `PastView.observed_weather_on(day)` raises `LookAheadError` for the target day or later.
  - `gbm-v1` uses the forecast high and rain as features.
  - `forecast/tests/test_shadow_weather.py` fails if a backtest reads the target day's observed weather, or if observed weather moves any forecast.
- **Shadow mode.** The database stamps every `forecast` row with `created_at` (its own clock) and `locks_at` (the meal's service start in the hall's time zone; start times in `meal_service_start`, kept equal to `config.toml [meals]` by a test).
  - From `locks_at` on, a trigger rejects updates, and deletes of real rows. Simulated rows stay removable.
  - The worker upserts only services that have not started. For started ones it inserts missing rows and changes nothing.
  - Rows written before the migration have `lock_tracked = false` and never count as locked.
- **Report:** locked forecasts vs. FSS vs. actuals, at default and matched stockouts:

  ```bash
  python3 -m forecast.shadow_report --hall hall-main --start 2026-10-24 --end 2026-10-30 [--model baseline-v1] [--json]
  ```

  - Only rows created before their service started are scored. Late, pre-shadow and not-yet-started rows are counted and listed.
  - It is labeled SIMULATED when any input it used is simulated.

