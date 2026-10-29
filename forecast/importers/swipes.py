"""Meal-swipe counts (CSV or XLSX) -> attendance, in 15-minute intervals per hall and meal.

    python3 -m forecast.importers.swipes FILE --mapping MAPPING.toml [--hall hall-main] [--dry-run] [--out DIR]

Accepts either one row per swipe (no count column: each row is 1 swipe) or
pre-counted rows (a `count` column, any interval of 15 minutes or less). Times
are the hall's local time. Every row written has is_simulated = false and
source = 'swipes'; re-importing the same file replaces the same intervals.

Validation report (always written; --dry-run writes nothing else):
- errors (row rejected): unreadable date/time, unknown hall, negative,
  non-integer or impossible counts, swipes outside every meal's hours (unless
  the export names the meal);
- warnings: duplicate rows (same hall + timestamp in a pre-counted export, or
  a repeated swipe id), intervals coarser than 15 minutes, gaps (15-minute
  intervals inside meal hours with no swipes), intervals that already hold
  SIMULATED rows (skipped, never overwritten).
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from ..config import load_settings
from .common import ImportError_, Report, load_mapping, norm_name, parse_date, parse_datetime, parse_number, parse_time, read_table, resolve_columns

MEALS = ("breakfast", "lunch", "dinner")
DEFAULT_MAX_PER_INTERVAL = 1500  # more than this many swipes at one hall in 15 minutes is treated as impossible


def meal_hours(settings) -> dict[str, tuple[time, time]]:
    out = {}
    for m, (a, b) in settings.meals.items():
        out[m] = (time.fromisoformat(a), time.fromisoformat(b))
    return out


def meal_for(t: time, hours: dict[str, tuple[time, time]]) -> str | None:
    for m, (a, b) in hours.items():
        if a <= t < b:
            return m
    return None


def floor15(dt: datetime) -> datetime:
    return dt.replace(minute=dt.minute - dt.minute % 15, second=0, microsecond=0)


def parse_meal(raw: str, mapping: dict) -> str | None:
    raw = str(raw).strip()
    if not raw:
        return None
    mapped = {norm_name(k): v for k, v in (mapping.get("meals") or {}).items()}.get(norm_name(raw))
    if mapped in MEALS:
        return mapped
    n = norm_name(raw)
    hits = [m for m in MEALS if m in n]
    return hits[0] if len(hits) == 1 else None


def build(rows: list[dict[str, str]], mapping: dict, *, default_hall: str | None, known_halls: dict[str, str],
          settings, report: Report) -> dict[tuple[str, datetime, str], int]:
    """(hall, local interval start, meal) -> swipes. known_halls: hall_id -> timezone."""
    cols = resolve_columns(rows, mapping, [], ["timestamp", "date", "time", "hall", "meal", "count", "swipe_id"])
    if "timestamp" not in cols and not ("date" in cols and "time" in cols):
        raise ImportError_("the mapping needs a `timestamp` column, or both `date` and `time`")
    if "hall" not in cols and not default_hall:
        raise ImportError_("no `hall` column in the mapping: pass --hall")
    opts = mapping.get("options") or {}
    max_per = int(opts.get("max_swipes_per_interval", DEFAULT_MAX_PER_INTERVAL))
    hall_map = {norm_name(k): v for k, v in (mapping.get("halls") or {}).items()}
    hours = meal_hours(settings)
    agg: dict[tuple[str, datetime, str], int] = defaultdict(int)
    seen_ts: set[tuple[str, datetime]] = set()
    seen_ids: set[str] = set()
    minutes_seen: set[int] = set()
    report.rows_read = len(rows)
    for i, r in enumerate(rows, start=2):  # line 1 is the header
        if "hall" in cols:
            raw_hall = r[cols["hall"]].strip()
            hall = hall_map.get(norm_name(raw_hall)) or (raw_hall if raw_hall in known_halls else None)
            if hall is None or hall not in known_halls:
                report.error(i, "unknown_hall", f"hall {raw_hall!r} is not a known hall; add it under [halls] in the mapping", value=raw_hall)
                continue
        else:
            hall = default_hall
        if "timestamp" in cols:
            ts = parse_datetime(r[cols["timestamp"]], opts.get("timestamp_format"))
        else:
            d = parse_date(r[cols["date"]], opts.get("date_format"))
            t = parse_time(r[cols["time"]])
            ts = datetime.combine(d, t) if d and t else None
        if ts is None:
            report.error(i, "bad_datetime", "could not read the date/time", row=r)
            continue
        if "count" in cols:
            n = parse_number(r[cols["count"]])
            if n is None or n != int(n):
                report.error(i, "bad_count", f"count {r[cols['count']]!r} is not a whole number")
                continue
            n = int(n)
            if n < 0:
                report.error(i, "negative_count", f"count {n} is negative")
                continue
            if n > max_per:
                report.error(i, "impossible_count", f"count {n} is more than {max_per} swipes in one interval")
                continue
            if (hall, ts) in seen_ts:
                report.warn(i, "duplicate_row", f"a second row for {hall} at {ts.isoformat(sep=' ')}; the first one is kept")
                continue
            seen_ts.add((hall, ts))
        else:
            n = 1
            if "swipe_id" in cols:
                sid = r[cols["swipe_id"]].strip()
                if sid and sid in seen_ids:
                    report.warn(i, "duplicate_swipe", f"swipe id {sid} appears again; counted once")
                    continue
                seen_ids.add(sid)
        meal = parse_meal(r[cols["meal"]], mapping) if "meal" in cols else None
        if "meal" in cols and meal is None and r[cols["meal"]].strip():
            report.warn(i, "unknown_meal", f"meal {r[cols['meal']]!r} is not breakfast/lunch/dinner; using the time of day")
        meal = meal or meal_for(ts.time(), hours)
        if meal is None:
            report.error(i, "outside_meal_hours", f"{ts.time()} is outside every meal's hours and the export names no meal", swipes=n)
            continue
        minutes_seen.add(ts.minute)
        agg[(hall, floor15(ts), meal)] += n
    for key, n in agg.items():
        if n > max_per:
            report.error(None, "impossible_count", f"{key[0]} {key[1]}: {n} swipes in 15 minutes (> {max_per})")
    if "count" in cols and minutes_seen and minutes_seen <= {0}:
        report.warn(None, "coarse_intervals", "every time is on the hour: the export looks hourly, so each hour's swipes land in its first 15-minute interval. Ask for 15-minute (or per-swipe) data.")
    return {k: v for k, v in agg.items() if v <= max_per}


def gaps(agg: dict[tuple[str, datetime, str], int], settings) -> list[tuple[str, date, str, list[str]]]:
    """15-minute intervals inside meal hours with no swipes, per hall/date/meal that has any."""
    hours = meal_hours(settings)
    have: dict[tuple[str, date, str], set[datetime]] = defaultdict(set)
    for (hall, start, meal) in agg:
        have[(hall, start.date(), meal)].add(start)
    out = []
    for (hall, d, meal), starts in sorted(have.items()):
        a, b = hours[meal]
        cur = datetime.combine(d, a)
        cur = floor15(cur)
        missing = []
        while cur.time() < b:
            if cur not in starts:
                missing.append(cur.strftime("%H:%M"))
            cur += timedelta(minutes=15)
        if missing:
            out.append((hall, d, meal, missing))
    return out


def to_rows(agg: dict[tuple[str, datetime, str], int], known_halls: dict[str, str]) -> list[dict]:
    rows = []
    for (hall, local_start, meal), n in sorted(agg.items()):
        tz = ZoneInfo(known_halls.get(hall) or "America/Detroit")
        utc = local_start.replace(tzinfo=tz).astimezone(timezone.utc)
        rows.append({"hall_id": hall, "interval_start": utc.isoformat(), "service_date": local_start.date().isoformat(),
                     "meal_label": meal, "swipe_count": n, "source": "swipes", "is_simulated": False})
    return rows


def run(path: Path, mapping_path: Path, *, db, hall: str | None = None, dry_run: bool = False, out_dir: Path | None = None) -> Report:
    settings = load_settings()
    mapping = load_mapping(mapping_path)
    report = Report("swipes", str(path), dry_run)
    known = {h["hall_id"]: h.get("timezone") or settings.default_timezone for h in db.select("hall", columns="hall_id,timezone")}
    if hall and hall not in known:
        raise ImportError_(f"--hall {hall} is not a known hall")
    agg = build(read_table(path, (mapping.get("options") or {}).get("sheet")), mapping, default_hall=hall, known_halls=known, settings=settings, report=report)
    for h, d, meal, missing in gaps(agg, settings):
        report.warn(None, "gap", f"{h} {d} {meal}: no swipes at {', '.join(missing[:8])}{' …' if len(missing) > 8 else ''} ({len(missing)} intervals; real zeros or missing data?)")
    rows = to_rows(agg, known)
    if rows:
        halls = sorted({r["hall_id"] for r in rows})
        lo, hi = min(r["service_date"] for r in rows), max(r["service_date"] for r in rows)
        sim = {(x["hall_id"], x["interval_start"]) for x in db.select(
            "attendance", {"hall_id": f"in.({','.join(halls)})", "is_simulated": "eq.true", "service_date": f"gte.{lo}", "and": f"(service_date.lte.{hi})"},
            "hall_id,interval_start")}
        sim = {(h, datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()) for h, t in sim}
        clash = [r for r in rows if (r["hall_id"], r["interval_start"]) in sim]
        if clash:
            report.warn(None, "simulated_rows_present", f"{len(clash)} intervals already hold SIMULATED attendance and were skipped "
                        f"(remove the simulated data first: python3 -m forecast.simulate remove --hall {clash[0]['hall_id']})")
            rows = [r for r in rows if (r["hall_id"], r["interval_start"]) not in sim]
    by_meal: dict[str, int] = defaultdict(int)
    for r in rows:
        by_meal[f"{r['hall_id']} {r['meal_label']}"] += r["swipe_count"]
    report.summary = {"intervals": len(rows), "swipes": sum(r["swipe_count"] for r in rows),
                      "dates": f"{min(r['service_date'] for r in rows)} .. {max(r['service_date'] for r in rows)}" if rows else "-",
                      "by hall and meal": dict(sorted(by_meal.items())), "is_simulated": False}
    if not dry_run and rows:
        db.insert("attendance", rows, on_conflict="hall_id,interval_start", upsert=True)
    report.rows_written = len(rows)
    if out_dir:
        report.write(out_dir, Path(path).stem + ".swipes")
    return report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m forecast.importers.swipes", description=__doc__.split("\n\n")[0])
    p.add_argument("file", type=Path)
    p.add_argument("--mapping", type=Path, required=True)
    p.add_argument("--hall", help="hall id for every row when the export has no hall column")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--out", type=Path, default=Path("forecast/out/imports"))
    a = p.parse_args(argv)
    from ..db import Supabase
    try:
        report = run(a.file, a.mapping, db=Supabase.from_env(), hall=a.hall, dry_run=a.dry_run, out_dir=a.out)
    except ImportError_ as e:
        print(f"not imported: {e}")
        return 2
    print(report.text())
    return 1 if report.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
