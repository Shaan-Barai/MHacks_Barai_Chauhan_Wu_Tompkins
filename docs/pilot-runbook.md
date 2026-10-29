# Pilot runbook: 6-week shadow pilot at one hall

**The idea in one line:** for 6 weeks the hall keeps cooking from FSS exactly as today. Before each meal, ScrapSaver writes its own forecast and locks it. Afterwards we compare both forecasts with what actually happened. Nobody cooks from our numbers during the pilot.

## Before day 1 (once, about an hour)

1. **Real data in, simulated data out:**
   - Import the hall's swipe counts and FSS forecast export ([data-intake.md](data-intake.md)).
   - Remove the simulated test data: `python3 -m forecast.simulate remove --hall hall-main`. That deletes only rows marked simulated; real rows stay.
   - Then re-run `python3 -m forecast.context_import` to fill the calendar and weather for those days.
2. **Turn on the scheduler** ([scheduler-setup.md](scheduler-setup.md)), so forecasts are written and locked before every meal even when no laptop is on.
3. **Agree who checks the sheet** at each meal (one person plus a backup), and show them the routine below once.

## The daily routine (about 2 minutes per meal)

Who: the **kitchen lead** (or whoever closes the line) for each meal in the pilot.

1. **When the meal ends**, fill in the production sheet as usual. For each dish it needs: the dish, the pounds prepped, the pounds left in the pan, and the time it ran out (if it did).
2. **Take one photo** of the sheet with a phone: flat, in good light, the whole page in view.
3. Open the ScrapSaver site → **Production sheets** (`/production`) → **Read a sheet**. Choose the photo, the **date served** and the **meal**, then press **Read sheet**.
4. Under **To review**, check each row against the paper:
   - Fix anything outlined in the AI's reading (an unknown dish, an impossible number, a missing meal), then **Save changes**.
   - Type your name or initials in **"Your name or initials"** and press **Confirm row**. Press **Reject** for a row that isn't a real dish.
   - Only confirmed rows count. Nothing the AI reads is used until a person confirms it.
5. **Done.** If you miss a day, do it the next morning with the right date. Late is fine; the sheet is the record.

## What M-Dining sees, and when

| When | What |
|---|---|
| Every meal | Nothing changes in the kitchen. FSS is still the plan. |
| Any time | The **Forecast** page on the site shows our forecast per dish and meal. Until the simulated data is removed it is labeled **SIMULATED**. |
| Weekly | A one-page summary from the weekly check below: our locked forecasts vs. FSS vs. what was actually used. |
| End of week 6 | The verdict against the success test below, with every week's numbers. |

## The weekly check (about 10 minutes, Mondays)

```bash
python3 -m forecast.shadow_report --hall hall-main --start <last Monday> --end <last Sunday>
```

How to read it:
- **First line:**
  - `real data` means every input was real.
  - `SIMULATED …` means something was simulated: don't quote those numbers.
  - `nothing scored` means there's nothing to compare yet.
- **forecast rows:**
  - `locked` = forecasts written before their meal started (the only ones scored).
  - `late` = written after the meal started (never scored).
  - `before shadow` = written before the pilot.
  - `not started` = still ahead.
  - If `locked` is low, check that the scheduler ran (see scheduler-setup.md).
- **scored dish-meals:** meals with a locked forecast, an FSS number and a confirmed sheet row. Missing sheets mean fewer scored meals.
- **The table:**
  - **WAPE**: how far off each forecast was, on average (lower is better).
  - **bias**: above 0 over-forecasts, below 0 under-forecasts.
  - **stockouts**: meals where that amount would have run out.
  - **leftover lb / $**: what would have been left in the pan.
  - The middle row, **"locked × k matched"**, scales our forecasts until they run out **no more often than FSS**. That is the fair comparison.

## What counts as success

**Our forecasts leave less food in the pan than FSS, at the same number of run-outs or fewer.** In the report: the "matched" row's leftover lb is below the FSS row's, with stockouts ≤ FSS's.
- It must hold over the whole 6 weeks, on real data (the label says `real data`).
- It must be based on most of the meals: at least 4 of 5 dish-meals scored.

A good WAPE alone is not success. Neither is beating FSS by running out more often.

## Pause or stop

- **Pause forecasts:** `gh variable set FORECAST_SCHEDULER_ENABLED --body false`. Turn it back on with `--body true`.
- **Pause sheets:** just stop photographing. Nothing breaks; those meals are simply not scored.
- **Stop the pilot:** do both, and tell the kitchen lead.
- **Nothing is deleted either way.** Forecasts stay locked, and confirmed sheet rows stay as they are.

## What data we keep, and privacy

| What | Where | Who can see it |
|---|---|---|
| Sheet photos | Private image storage | The project team (through the backend), not the public |
| Confirmed sheet rows (dish, lb prepped, lb left, ran-out time) | `production_log`, a private table | The site shows the numbers, with the date each row was checked |
| **Who checked each row** | `production_log`, a private table | **Never shown on the site or returned by its API.** It is kept only so the team can follow up on a row. |
| Our forecasts (with creation and lock time) | `forecast` | The Forecast page |
| Swipe counts | `attendance`, counts per 15 minutes | No student names, IDs or card numbers are ever imported |

Staff names stay private. Initials are fine.
