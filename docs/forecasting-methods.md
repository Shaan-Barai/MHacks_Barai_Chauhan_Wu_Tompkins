# Forecasting prep quantities in a university dining hall: methods

*Draft, 2026-10-28. Every number below is tagged **[SIMULATED]** (made-up test data) or **[REAL]** (measured on real photos). No forecasting result here is on real dining-hall records yet.*

## 1. The problem

A dining hall decides before each meal how many pounds of each dish to prepare. Two things go wrong:
- Too little, and the dish runs out mid-meal: diners notice, and staff rush a batch or substitute.
- Too much, and the extra is thrown away, wasting its purchase cost and its environmental footprint.

The hall currently plans with the forecast in its food-service software (FSS). We want to know whether a forecast built from the hall's own records can prepare closer to what diners take, at the same or lower risk of running out, and how to show staff the reasoning behind each number.

## 2. Accounting identity

For one dish at one meal:

```text
prepped  =  eaten  +  tray waste  +  pan leftover
            └──── taken by diners ────┘   (what left the pan = "consumed")
```

- **Prepped** and **pan leftover** come from the kitchen's production sheets, photographed and read by an AI model. A person must confirm every row before it is used.
- **Consumed** = prepped − pan leftover, the amount diners took.
- **Tray waste** is food taken but not eaten. We measure it as *Pixels wasted* in top-down photos of returned plates, using AI-drawn masks with pixels counted in code. Pixels are not pounds.
- To feed tray waste into the forecast, pixels must become an *estimated* weight, either:
  - through a camera calibration (a known-area object, giving cm² per pixel), or
  - through the plate-scale estimate (`plate-scale-v1`):
    - cm² per pixel = (assumed plate diameter / plate diameter in pixels)²;
    - grams = cm² × each food's average grams per cm².
- Both conversions are labeled estimates (see §8). Tray waste enters the forecast only for meals where scanned plates cover at least 80% of diners, because scaling a smaller sample up to the whole meal would be an extrapolation.

The forecast target is **demand**: what diners would take if the dish never ran out. Expected eaten food = demand × (1 − tray-waste share) is reported alongside.

## 3. Choosing how much to prepare: running out vs. waste

We treat each dish-meal as a newsvendor problem. Let Cu be the cost of being one pound short, and Co the cost of one pound left over. Preparing the q-th percentile of the demand forecast, with

```text
q = Cu / (Cu + Co)
```

minimizes the expected cost.

- **Co** is the dish's food cost per pound plus an **environmental price** per pound: its Waste Impact Score. The score is 0.19 × kg CO2e per kg + 1.50 × m³ of freshwater per kg.
  - The 0.19 comes from a social cost of carbon of about $185–190 per tonne (Rennert et al. 2022; EPA 2023).
  - The 1.50 comes from a replacement cost of water of €1.29/m³ (True Price & Wageningen Economic Research).
  - Factors per food are in `factors/menu_waste_factors_*.csv`.
  - So a high-footprint dish such as beef gets a slightly lower q (wasting it costs more) than rice does.
- **Cu** is not observable from data. We set it from **service levels** a kitchen manager can accept: entrées 0.95, sides 0.90, self-serve 0.85, desserts 0.85. Cu for each dish type is chosen so a dish with typical waste costs gets exactly that q.
  - These are starting points, not tuned on data.
  - We make no assumption that staff refill stations mid-meal.
- The spread of demand comes from each model's own recent forecast errors (§5): prep = point forecast × (1 + the q-th quantile of recent relative errors).

## 4. Censored demand

When a dish runs out, what left the pan is only a **lower bound** on demand. Treating it as demand would teach every model to under-prepare the dishes that run out most. So in our methods:

- **Training:**
  - The new models leave ran-out meals out of their inputs.
  - The production model (baseline-v1) uses a ran-out meal only as "at least this much": it takes the larger of that amount and the recent average.
  - A ran-out meal's forecast error is kept only when the lower bound already exceeds the forecast, since the true error is then at least that large.
- **Scoring:** error (WAPE) and bias use only meals that did not run out. A ran-out meal still counts as a **stockout** for any prep amount at or below what was consumed.

## 5. Models

All models predict demand in pounds per dish per meal. They differ only in the point forecast; prep amounts and ranges use the same error-based method for all of them.

| model_version | Point forecast |
|---|---|
| `baseline-v1` | Same dish, same day of the 6-week menu cycle, one cycle ago. Fallbacks: the dish's recent same weekday-meal average, its recent meal average, then the hall's average dish. Scaled by expected diners ÷ diners at the baseline meal. |
| `seasonal-naive-v1` | The dish's most recent same weekday-meal |
| `moving-avg-4-v1` | Mean of the dish's last 4 same weekday-meals |
| `exp-smoothing-v1` | Simple exponential smoothing (α = 0.3) over the dish's series for that meal |
| `gbm-v1` | Gradient-boosted trees (scikit-learn `HistGradientBoostingRegressor`), retrained weekly. Features: weekday, meal, dish, expected diners, the dish's last and recent-average amounts, days since last served, calendar flags (exam period, home football game, holiday), and the **day-ahead weather forecast** (high and rain). |

**Calendar context** comes from fetched sources, each stored with its URL:
- the U-M Registrar's 2026–27 calendar;
- the official Michigan football schedule;
- Hebcal and Aladhan for religious holidays;
- Open-Meteo weather. Models see only the **day-ahead forecast** for the day they predict (Open-Meteo Previous Runs API, each hour forecast 24 h ahead), never the observed weather. Observed and forecast weather are stored in separate columns. Over 46 real days (Aug–Oct 2026), the day-ahead high was off from the observed high by 2.8 °F on average [REAL].

**Two optional helpers, off by default:**
- k-means **day types** from each day's attendance profile and context;
- a robust z-score **anomaly flag** that routes suspicious production rows to review instead of training.

## 6. Walk-forward evaluation

We simulate forecasting one day at a time:

1. For each day, every model sees only data from **before** that day. The calendar for the day itself is allowed, since it is published in advance. So is the weather **forecast** issued at least 24 h before it. Its observed weather is not: asking for it raises an error, and a test fails if observed weather changes any forecast.
2. Each model forecasts every dish served at every meal.
3. That day's actuals then become available for later days' error ranges.

A test inserts absurd values on future dates and fails if any earlier forecast changes. We confirmed it fails when future meals are deliberately exposed.

**Shadow mode (live forecasts).** A backtest re-creates the past. The stronger test is to store forecasts before each meal and score them afterwards.
- The database stamps every forecast with its creation time and the time its meal's service starts. From that moment a trigger refuses to change it.
- `python -m forecast.shadow_report` scores only forecasts created before their service, against FSS and actuals, at default and matched stockouts.
- No locked forecast has been scored yet: all forecasts in the database so far were written before shadow mode, or are for meals still to come.

All models are scored on the **same** dish-meals: those every model could forecast.

## 7. Metrics

- **WAPE** = Σ|forecast − consumed| ÷ Σ consumed, on meals that did not run out.
- **Bias** = Σ(forecast − consumed) ÷ Σ consumed: above 0 over-forecasts, below 0 under-forecasts.
- **Stockouts:** meals where the prep amount would not have covered demand.
- **Pan leftover:** prep − consumed on meals that did not run out, in lb and in $ at each dish's Co.
- **Matched stockouts:** each model's service levels are shifted together (one shift in log-odds) to the smallest value at which its stockouts are no more than the comparison forecast's. Leftovers are then compared at equal risk of running out. This keeps a model from looking good just by preparing more.
- **Interval coverage:** how often the actual falls inside the model's 10th–90th percentile range. The target is about 80%.

## 8. Results so far

### Forecasting [SIMULATED]

These numbers come from a simulated hall: 6 weeks, lunch and dinner, 15 dishes. The data was generated with invented attendance, take rates and noise, and a "Simulated FSS" that over-prepares by about 25%. **They show that the method runs end to end. They are not evidence about any real dining hall, and they say nothing about the real FSS.**

The window is 2026-09-26 to 2026-10-23: 291 dish-meals, of which 48 ran out.

| model | mode | WAPE | bias | stockouts | pan leftover | 10–90% coverage |
|---|---|---|---|---|---|---|
| baseline-v1 | default | 18.3% | +1.7% | 21 | 3,558 lb | 80% |
| baseline-v1 | matched | 18.3% | +1.7% | 48 | 2,797 lb | 80% |
| seasonal-naive-v1 | default | 22.3% | −1.2% | 41 | 3,847 lb | 76% |
| seasonal-naive-v1 | matched | 22.3% | −1.2% | 48 | 3,452 lb | 76% |
| moving-avg-4-v1 | default | 19.6% | −0.3% | 36 | 3,048 lb | 77% |
| moving-avg-4-v1 | matched | 19.6% | −0.3% | 48 | 2,784 lb | 77% |
| exp-smoothing-v1 | default | 21.7% | −1.3% | 28 | 4,288 lb | 79% |
| exp-smoothing-v1 | matched | 21.7% | −1.3% | 48 | 3,236 lb | 79% |
| gbm-v1 | default | 18.6% | +0.5% | 15 | 4,550 lb | 89% |
| gbm-v1 | matched | 18.6% | +0.5% | 48 | 3,045 lb | 89% |
| Simulated FSS (+25%) | as given | 41.6% | +41.6% | 48 | 4,030 lb | — |

How to read this (still simulated):
- The forecasting models land within a few points of each other, and gradient boosting's 10–90% range is wider than intended (89%).
- gbm-v1 now uses the day-ahead weather forecast (Run 4). Its WAPE moved from 17.8% to 18.6%. The simulated demand does not depend on weather, so here those features can only add noise; this says nothing about real weather effects.
- At matched stockouts, baseline-v1 and the moving average leave the least.
- Beating the simulated FSS is built into the simulation (it was made to over-prepare), so that comparison measures nothing.

### Tray-waste detection [REAL]

On 12 labeled real plate photos, the AI food detection scored **94.4% recall and 81.0% precision** in each of 3 identical runs (fixed seed, temperature 0). That is 17 correct, 1 missed and 4 wrong each time, against a 26-food menu.

An earlier 100% / 92.3% was measured on a 23-food menu. Adding three foods explains most of the drop; see [detection-accuracy.md](detection-accuracy.md). This is a small sample from one hall.

## 9. Limitations

- **No real forecasting data yet.** Every forecasting number is simulated. The models, metrics and code are built to run unchanged on real data, but nothing here shows they work on it.
- **No real FSS forecasts.** The comparison forecast is a simulated stand-in. It will be labeled plain "FSS" automatically once a real export is imported.
- **Costs are assumptions.**
  - The service levels set Cu and are judgment calls.
  - The environmental prices are published estimates with wide uncertainty.
  - Food costs are the simulated per-dish values, or a $3.00/lb default, until real per-dish costs are provided.
- **Pounds from pixels are estimates:**
  - The plate-scale method assumes every plate has one diameter (26.7 cm, a 10.5" plate). A 9" plate would be overstated by about 1.36×.
  - It assumes the AI's box around the plate is accurate and that food lies flat.
  - It uses an average grams per cm² per food.
  - The camera calibration is more direct, but none has been taken yet.
- **Tray waste needs coverage.** It enters the forecast only when scans cover at least 80% of a meal's diners. Today no meal qualifies, so the forecast uses no tray waste (share = 0).
- **Detection is measured on 12 photos from one hall.** The masks themselves (the pixel areas) are not scored against hand-drawn masks.
- **Production sheets** are read by an AI model and confirmed by a person, but the reader has only been tested on simulated answers, not on a real sheet.

## 10. What real data will test

With M-Dining's swipe counts, FSS export and production sheets (see [data-intake.md](data-intake.md)), the same code will answer:

1. **The headline question:** does any model beat the real FSS on WAPE? And at matched stockouts, does it leave less food in the pan?
2. **Real-world intervals:** are the 10–90% ranges calibrated (about 80%) on real demand, and do service levels near 0.85–0.95 match what managers accept?
3. **Context:** do the calendar and weather flags help? Context adjustments are off by default and should stay off until they show a gain on held-out weeks.
4. **Day types:** does day-type clustering add anything over the calendar flags?
5. **Censoring:** how often do dishes really run out, and how much does treating those meals as censored change the forecasts?
6. **Tray waste:** with enough plate coverage, what is the real tray-waste share per dish, and how far apart are the plate-scale and camera-calibrated estimates on the same plates?
