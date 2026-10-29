"""Scheduled shadow-mode forecasts (Run 5): write every not-yet-started service's forecast, nothing else.

    python -m forecast.scheduled_run --hall hall-main [--days 2] [--dry-run]

Run by .github/workflows/forecast-schedule.yml (off until you turn it on; see
docs/scheduler-setup.md). Each run:
  * builds baseline-v1 forecasts (forecast/worker.py) for today and the next
    `--days - 1` days in the hall's time zone;
  * keeps only services whose lock time (the meal's start, migration
    20261028000017) is more than LOCK_MARGIN away, and upserts those. A
    service that has started is skipped entirely: no late rows, no revisions
    (the database would refuse the revision anyway);
  * is safe to run twice: before the lock, the same inputs upsert the same row
    (one row per hall x date x meal x dish x model);
  * prints one JSON line (time, hall, rows written, services skipped as
    started, the next lock), and, inside GitHub Actions, a step summary.

Lock times come from config.toml [meals] (equal to the database's
meal_service_start, checked by a test) and the zoneinfo database, so daylight
saving time is handled by the clock arithmetic, not by the cron schedule.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .config import load_settings
from .data import load_hall
from .db import Supabase
from .model import MODEL_VERSION
from .worker import build_forecasts, service_start, split_by_lock


def plan(rows: list[dict], tz: str, meals: dict, now: datetime) -> dict:
    """Which forecast rows a scheduled run may write: only services that have not started."""
    open_rows, started = split_by_lock(rows, tz, meals, now)
    services = lambda rs: sorted({(r["service_date"], r["meal_label"]) for r in rs})  # noqa: E731
    upcoming = sorted(service_start(date.fromisoformat(d), m, tz, meals) for d, m in services(open_rows))
    return {
        "write": open_rows,
        "servicesWritten": [f"{d} {m}" for d, m in services(open_rows)],
        "servicesSkippedStarted": [f"{d} {m}" for d, m in services(started)],
        "nextLock": upcoming[0].isoformat() if upcoming else None,
    }


def run(hall_id: str, days: int = 2, dry_run: bool = False, db: Supabase | None = None, now: datetime | None = None) -> dict:
    if not 1 <= days <= 7:
        raise ValueError("--days must be 1..7")
    now = now or datetime.now(timezone.utc)
    db = db or Supabase.from_env()
    data = load_hall(db, hall_id)
    today = now.astimezone(ZoneInfo(data.timezone)).date()
    rows, skipped = build_forecasts(data, today, today + timedelta(days=days - 1))
    p = plan(rows, data.timezone, load_settings().meals, now)
    if p["write"] and not dry_run:
        db.insert("forecast", p["write"], on_conflict="hall_id,service_date,meal_label,dish_id,model_version", upsert=True)
    return {
        "ranAt": now.isoformat(), "hallId": hall_id, "timezone": data.timezone, "modelVersion": MODEL_VERSION,
        "dryRun": dry_run, "rowsWritten": 0 if dry_run else len(p["write"]), "rowsPlanned": len(p["write"]),
        "simulatedRows": sum(1 for r in p["write"] if r.get("is_simulated")),
        "servicesWritten": p["servicesWritten"], "servicesSkippedStarted": p["servicesSkippedStarted"],
        "nextLock": p["nextLock"], "dishesSkipped": skipped, "notes": data.notes,
    }


def summary_markdown(r: dict) -> str:
    sim = f" ({r['simulatedRows']} SIMULATED)" if r["simulatedRows"] else ""
    return "\n".join([
        f"### Forecast run {r['ranAt']} · {r['hallId']}{' · DRY RUN' if r['dryRun'] else ''}",
        f"- rows written: **{r['rowsWritten']}**{sim} for {', '.join(r['servicesWritten']) or 'no upcoming service'}",
        f"- skipped (service already started, locked): {', '.join(r['servicesSkippedStarted']) or 'none'}",
        f"- next lock: {r['nextLock'] or '—'}",
    ]) + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m forecast.scheduled_run", description=__doc__.split("\n\n")[0])
    p.add_argument("--hall", action="append", help="hall id (repeatable; default hall-main)")
    p.add_argument("--days", type=int, default=2, help="today plus this many days minus one (default 2)")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    for hall in a.hall or ["hall-main"]:
        r = run(hall, a.days, a.dry_run)
        print(json.dumps(r))
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
                f.write(summary_markdown(r))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
