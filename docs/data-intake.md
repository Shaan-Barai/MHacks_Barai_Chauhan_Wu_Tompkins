# Data intake: what we can accept from M-Dining

We built importers for three kinds of data, so files from M-Dining can be loaded as they are. A short mapping file tells the importer which column is which, so we don't need a fixed layout. **CSV or Excel (.xlsx) both work.** If a layout is easier for you, send it that way and we'll write the mapping.

Every import first runs as a **dry run**. That run produces a validation report (gaps, duplicates, impossible values, unknown names), and nothing is saved until we've read it. Imported rows are marked as real data (`is_simulated = false`). Everything we've shown so far is simulated and labeled that way.

## What to ask M-Dining for

1. **Meal swipe counts.** These tell us how many people ate at each meal.
   - **Best:** one row per swipe, with the hall/location and the date and time of the swipe. We don't need any student information: no names, IDs or card numbers. If an export always includes a transaction ID, it can stay; we only use it to drop exact repeats.
   - **Also fine:** counts per 15-minute interval (or finer) per location.
   - **Usable but weaker:** hourly counts. The report warns about these, because we can't see the rush inside an hour.
   - **Period:** as many past terms as possible (at least Fall 2025 to now), for every hall we'll study.
2. **FSS (Food Service Suite) forecasts.** These are what FSS told each kitchen to prepare.
   - One row per hall, date, meal and recipe, with the forecast quantity and its unit (lb, oz, kg, g, or portions).
   - If the quantity is in portions, we also need each recipe's portion weight (or the recipe card).
   - Same period as the swipes.
3. **Production records.** These show what was actually prepared and what was left. Either kind works:
   - **Photos or scans of the handwritten production sheets.** Ideally the file names start with the date and meal, e.g. `2026-10-14_lunch_grill.jpg`. If not, the reader takes the date from the sheet.
   - **Or a typed/exported version:** dish, station, meal, date, pounds prepped, pounds left in the pan, and the time the dish ran out (if it did).
4. **A recipe/dish list** with names as they appear in FSS and on the sheets, with portion weights if available. This lets us match names exactly instead of guessing.
5. **Helpful but optional:** meal-period hours per hall, days a hall was closed or had a special event, and menu-cycle week numbers.

## How each file is used

### Swipes → `attendance` (15-minute intervals)
`python3 -m forecast.importers.swipes FILE --mapping swipes.toml [--hall hall-main] --dry-run`

- **Columns:**
  - a timestamp, **or** separate date and time;
  - a location (or one hall given on the command line);
  - optionally a meal period, a count (otherwise each row is one swipe) and a transaction ID.
- **Times:** each time is rounded down to its 15-minute interval in the hall's local time (America/Detroit) and stored as UTC.
- **Meals:** when the file doesn't name the meal, it comes from the meal hours in `forecast/config.toml`.
- **The report lists:**
  - unreadable dates/times;
  - unknown locations (we never create a hall from a file);
  - negative, fractional or impossible counts (over 1,500 in 15 minutes; configurable);
  - swipes outside every meal's hours;
  - duplicate rows;
  - hourly-looking data;
  - 15-minute gaps inside meal hours (real zeros or missing data).
- **Re-importing** a corrected file replaces the same intervals.

### FSS export → `forecast` rows with `model_version = 'fss'`
`python3 -m forecast.importers.fss FILE --mapping fss.toml --dry-run`

- **Columns:** date, meal, recipe name, quantity, unit (or one unit for the whole file), and the location (or `--hall`).
- **Recipe matching is exact only**, after normalizing case and punctuation. A recipe name must match one of:
  - a dish's name;
  - a menu item linked to that dish;
  - an alias someone has approved in the mapping file.
- **Unmatched names go to a review list** (`<file>.fss_unmatched.csv`, with up to three suggestions each) and are not imported. **No dish is ever created by an import.**
- **Units** convert to pounds. A portion count needs that dish's portion weight.
- **The label switches automatically.** Once a hall's FSS comparison comes only from imported (real) rows, the Forecast page and the evaluation call it **"FSS"**. Until then they say "Simulated FSS (assumed +25% over-prep)".

### Production sheet photos → UNCONFIRMED `production_log` rows
`python3 -m forecast.importers.sheets_batch FOLDER --hall hall-main --max-gemini 20`

- **How it reads:** each photo goes through the existing sheet reader, the same one the Production sheets page uses (one Gemini request per photo).
- **Nothing counts until confirmed:** rows arrive **unconfirmed**, and a person confirms each one on the Production sheets page before it is used.
- **Doubtful values** (low confidence, leftover > prepped, unknown dish, impossible numbers) are flagged for that person.
- **The batch is resumable.** A log keyed by each photo's fingerprint skips photos already read and retries failed ones, and `--max-gemini` caps the cost of each run.

### Mapping files
Examples: `forecast/importers/mappings/swipes.example.toml` and `fss.example.toml`. A mapping lists:
- `[columns]` (our field = your header);
- `[halls]` (your location name = our hall id);
- `[meals]` (your meal code = breakfast, lunch or dinner);
- `[aliases]` (FSS only: your recipe name = our dish id);
- `[options]` (sheet name, date format, default unit, count limit).

## Accepted formats, in short

| | Format | Must have | Nice to have |
|---|---|---|---|
| Swipes | CSV or XLSX | date + time (or timestamp), location | meal period, count per interval, transaction ID |
| FSS forecast | CSV or XLSX | date, meal, recipe name, quantity, unit | location, portion weights |
| Production sheets | JPG/PNG/HEIC photos or scans, one sheet per image | readable dish names and pounds | file names starting `YYYY-MM-DD_meal` |
| Production (typed) | CSV or XLSX | date, meal, dish, lb prepped, lb left | station, ran-out time |

- **Typed production records** don't have their own importer yet. They can be added the same way as the swipes importer, or loaded through the page.
- **Privacy:** we don't need any personal data. Please remove student names, IDs and card numbers before sending.
- **Storage:** files are kept in the project's private storage and never committed to the code repository.

The synthetic test files in `forecast/importers/samples/` are named `sample_SIMULATED_*` and are not M-Dining data.
