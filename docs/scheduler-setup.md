# Forecast scheduler: setup (off by default)

**What it does:** before every meal, a GitHub Actions job runs `python -m forecast.scheduled_run`. It writes baseline-v1 forecasts for each service that has **not started yet**, today and tomorrow. The database locks each forecast when its meal starts (shadow mode), so `python -m forecast.shadow_report` can later score forecasts that were really made in advance. Your laptop can be asleep.

**Why GitHub Actions:**
- The worker is plain Python with no extra packages. It talks to Supabase over HTTPS, so a scheduled workflow can run it as is, with no server and no new code.
- The repo is already on GitHub, and every run's log and summary stay in the Actions tab.
- Supabase pg_cron plus an Edge Function would mean rewriting the worker in TypeScript/Deno.

## How it is built

- **When it runs:** 4 times a day, in UTC (`.github/workflows/forecast-schedule.yml`).

  | UTC | Summer (EDT) | Winter (EST) | Covers |
  |---|---|---|---|
  | 02:05 | 22:05 the evening before | 21:05 the evening before | tomorrow |
  | 10:05 | 06:05 | 05:05 | breakfast (07:00) |
  | 14:05 | 10:05 | 09:05 | lunch (11:00) |
  | 19:35 | 15:35 | 14:35 | dinner (16:30) |

  Each run writes **every** service that hasn't started (today and tomorrow), so any single run covers the rest of the day. The later runs refresh forecasts with newer data until each lock.
- **Daylight saving time:** GitHub's cron ignores it, so every time above is early enough in both summer and winter. The code computes the real lock time in America/Detroit with the time-zone database. A test checks that every meal has a run 45 minutes to 8 hours before its lock in both July and January.
- **Never writes after a lock:**
  - A service that has started (or starts within 2 minutes) is skipped entirely. There are no late rows and no revisions.
  - The database would also refuse a revision (trigger from migration `20261028000017`).
- **Safe to run twice:** there is one row per hall × date × meal × dish × model. Before the lock, a second run updates the same row; after it, the run skips it. Only one run executes at a time (`concurrency`).
- **Logs:**
  - Each run prints one JSON line: time, hall, rows written (with how many are SIMULATED), services skipped as started, and the next lock.
  - It also writes a short summary on the run's page in the Actions tab.
  - The rows themselves carry `created_at` and `locks_at` in Supabase.
- **Off switch:** the job runs only when the repository **variable** `FORECAST_SCHEDULER_ENABLED` is `true`. Until then every scheduled run is skipped.
- **Data labels:** while hall-main still holds the simulated history, its forecasts are SIMULATED (`is_simulated = true`) and reports say so.

## What you need to add

Add these in GitHub: repo → **Settings → Secrets and variables → Actions**. Use names only; never paste values into chat, files or commits.

| Kind | Name | Value |
|---|---|---|
| Secret | `SUPABASE_URL` | `https://<project-ref>.supabase.co`. The API URL, **not** the dashboard link (the worker refuses a dashboard link) |
| Secret | `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API keys → the secret / service-role key |
| Variable | `FORECAST_SCHEDULER_ENABLED` | `true` to turn it on, `false` to turn it off |
| Variable (optional) | `FORECAST_HALLS` | Halls separated by spaces; default `hall-main` |

About the key:
- The service-role key can read and write every table. GitHub hides secrets from logs and does not give them to pull requests from forks.
- Still, add it only if you're comfortable keeping it in GitHub. Rotate it in Supabase if it ever leaks.

## Turn it on

1. **Get the workflow onto `main`.** GitHub runs scheduled workflows only from the default branch. The file is on `run5` and on `overnight-supabase` (draft PR #25); merging that PR, or a small PR with just `.github/workflows/forecast-schedule.yml` and `forecast/scheduled_run.py`, does it. Until then, nothing can run.
2. **Add the two secrets** (table above). With the GitHub CLI, each command asks you to paste the value:
   ```bash
   gh secret set SUPABASE_URL
   gh secret set SUPABASE_SERVICE_ROLE_KEY
   ```
3. **Turn it on:**
   ```bash
   gh variable set FORECAST_SCHEDULER_ENABLED --body true
   ```
4. **Test once by hand, writing nothing:** Actions → "Forecast schedule (shadow mode)" → **Run workflow**, leave "Plan only" checked. Or:
   ```bash
   gh workflow run forecast-schedule.yml -f dry_run=true
   ```
   The run's summary should list upcoming services and say DRY RUN.
5. From then on it runs by itself 4 times a day. A manual run with "Plan only" unchecked writes for real.

## Turn it off

```bash
gh variable set FORECAST_SCHEDULER_ENABLED --body false     # runs are skipped; nothing is deleted
gh workflow disable forecast-schedule.yml                    # or stop the workflow entirely (gh workflow enable … to undo)
```

Turning it off deletes nothing. Forecasts already written stay, locked after their meals.

## Check that it ran

- **Actions tab:** `gh run list --workflow forecast-schedule.yml --limit 8`. There are 4 runs a day.
  - Green with a summary means it ran.
  - "Skipped" means the variable isn't `true`.
  - Open a run to see its JSON line and summary.
- **In the data:** forecasts created today, before their lock:
  ```bash
  python3 -m forecast.shadow_report --hall hall-main --start <today> --end <today>
  ```
  After a meal starts, its rows count as "locked". Before that they show as "not started".
- **Caveats:**
  - GitHub may start scheduled runs late, usually by minutes. The runs are 55 minutes (summer) to 115 minutes (winter) ahead of each lock for that reason.
  - GitHub turns off scheduled workflows in public repos after 60 days with no commits. The Actions tab then shows a banner with a button to turn it back on.
