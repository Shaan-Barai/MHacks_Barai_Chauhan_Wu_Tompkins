"""Real, sourced context days for every hall (Run 3, Phase 3): re-runnable.

    python3 -m forecast.context_import [--start 2026-08-01] [--end 2027-05-31] [--dry-run] [--hall H ...]

Inputs (each row keeps the URL of every source it used, in context_day.source_urls):
- forecast/context_sources/um_academic_calendar_2026_27.json   U-M Registrar calendar
- forecast/context_sources/michigan_football_2026.json          official 2026 schedule
- forecast/context_sources/religious_holidays_2026_27.json      Hebcal / Aladhan
- Open-Meteo for Ann Arbor, fetched live: the archive API for past dates and
  the forecast API (16 days) for upcoming ones. Later dates get no weather (null).
- Weather FORECASTS as known before each day (Run 4): Open-Meteo's Previous
  Runs API, `_previous_day1` = the value forecast 24 h before each hour, so the
  whole day was forecast before its first service. Stored separately in
  context_day.fc_* (fc_lead_hours = 24); backtests read only these. A day is
  filled only once its last hour's day-ahead forecast exists (from 05:00 local
  that day). The Historical Forecast API is not used: it stitches the first
  hours of each successive model run, so part of a day comes from runs issued
  during that day, after a service may have started.

The calendar files are hand-copied from the fetched pages (URL and fetch date
inside each file); this script never invents dates. Rows are written with
is_simulated = false. A date that already holds a SIMULATED row for that hall is
skipped and reported, never overwritten (simulate.py's `remove` deletes those;
re-run this afterwards to fill the gap). Test halls (hall-e2e-*, hall-live-*,
hall-test, hall-smoke, hall-detect-*) are skipped.
"""

from __future__ import annotations

import argparse
import json
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .db import Supabase, _ssl_context

SOURCES = Path(__file__).resolve().parent / "context_sources"
ANN_ARBOR = (42.2808, -83.7430)
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast"
DAY_AHEAD_HOURS = 24
DAILY = "temperature_2m_max,precipitation_sum,weather_code"
TEST_HALL_PREFIXES = ("hall-e2e-", "hall-live-", "hall-detect-")
TEST_HALLS = {"hall-test", "hall-smoke"}

# WMO weather codes (Open-Meteo docs) to a few plain words.
WMO = [(0, "clear"), (3, "partly cloudy"), (48, "fog"), (57, "drizzle"), (67, "rain"), (77, "snow"),
       (82, "rain showers"), (86, "snow showers"), (99, "thunderstorm")]


def wmo_summary(code) -> str | None:
    if code is None:
        return None
    for top, words in WMO:
        if code <= top:
            return words
    return None


def load_sources(folder: Path = SOURCES) -> dict:
    return {
        "academic": json.loads((folder / "um_academic_calendar_2026_27.json").read_text()),
        "football": json.loads((folder / "michigan_football_2026.json").read_text()),
        "holidays": json.loads((folder / "religious_holidays_2026_27.json").read_text()),
    }


def _days(start: str, end: str):
    d, e = date.fromisoformat(start), date.fromisoformat(end)
    while d <= e:
        yield d
        d += timedelta(days=1)


def calendar_days(sources: dict, start: date, end: date) -> dict[date, dict]:
    """Per-date flags from the calendar files only (no weather, no hall)."""
    out: dict[date, dict] = {}
    for d in _days(start.isoformat(), end.isoformat()):
        out[d] = {"exam_week": False, "home_game": False, "is_holiday": False, "holiday_name": None, "academic_note": None,
                  "class_day": None, "study_day": False, "break_day": False, "first_class_day": False, "events": [], "urls": {}}
    acad = sources["academic"]
    term_spans = []  # (first class day, last class day) per term, for class_day
    firsts = sorted(date.fromisoformat(p["start"]) for p in acad["periods"] if p["kind"] == "first_class_day")
    lasts = sorted(date.fromisoformat(p["start"]) for p in acad["periods"] if p["kind"] == "last_class_day")
    for f in firsts:
        last = next((l for l in lasts if l >= f), None)
        term_spans.append((f, last))
    no_class: set[date] = set()
    for p in acad["periods"]:
        for d in _days(p["start"], p["end"]):
            if d not in out:
                continue
            row = out[d]
            row["urls"]["academic"] = acad["source_url"]
            row["academic_note"] = "; ".join(x for x in (row["academic_note"], p["label"]) if x)
            kind = p["kind"]
            if kind == "final_exams":
                row["exam_week"] = True
                no_class.add(d)
            elif kind == "study_day":
                row["study_day"] = True
                no_class.add(d)
            elif kind == "break":
                row["break_day"] = True
                no_class.add(d)
            elif kind == "no_classes":
                no_class.add(d)
            elif kind == "first_class_day":
                row["first_class_day"] = True
    # class_day is known only from the first listed term on (the summer 2026 calendar was not fetched).
    for d, row in out.items():
        if firsts and d >= firsts[0]:
            in_term = any(f <= d and (l is None or d <= l) for f, l in term_spans)
            row["class_day"] = in_term and d.isoweekday() <= 5 and d not in no_class
            row["urls"].setdefault("academic", acad["source_url"])
    fb = sources["football"]
    for g in fb["games"]:
        d = date.fromisoformat(g["date"])
        if d in out and g["home"]:
            out[d]["home_game"] = True
            out[d]["events"].append(f"Home football: {g['opponent']}")
            out[d]["urls"]["football"] = fb["source_url"]
    for h in sources["holidays"]["holidays"]:
        for d in _days(h["start"], h["end"]):
            if d in out:
                row = out[d]
                row["is_holiday"] = True
                row["holiday_name"] = "; ".join(x for x in (row["holiday_name"], h["name"]) if x)
                row["urls"].setdefault("holidays", [])
                if h["source_url"] not in row["urls"]["holidays"]:
                    row["urls"]["holidays"].append(h["source_url"])
    return out


def _get_json(url: str, params: dict) -> dict:
    full = f"{url}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(full, timeout=60, context=_ssl_context()) as res:
        return json.loads(res.read().decode()), full


def fetch_weather(start: date, end: date, today: date) -> tuple[dict[date, dict], list[str]]:
    """Observed (archive) up to 5 days ago, forecast for the rest of the 16-day window."""
    lat, lon = ANN_ARBOR
    base = {"latitude": lat, "longitude": lon, "daily": DAILY, "temperature_unit": "fahrenheit",
            "precipitation_unit": "inch", "timezone": "America/Detroit"}
    out: dict[date, dict] = {}
    log: list[str] = []
    arch_end = min(end, today - timedelta(days=5))
    if start <= arch_end:
        try:
            data, url = _get_json(ARCHIVE_URL, {**base, "start_date": start.isoformat(), "end_date": arch_end.isoformat()})
            _merge_daily(out, data, "observed", url)
            log.append(f"archive {start}..{arch_end}: {len(out)} days")
        except Exception as e:  # noqa: BLE001 - logged, weather stays null
            log.append(f"archive failed: {e}")
    fc_start = max(start, arch_end + timedelta(days=1))
    fc_end = min(end, today + timedelta(days=15))
    if fc_start <= fc_end:
        try:
            data, url = _get_json(FORECAST_URL, {**base, "start_date": fc_start.isoformat(), "end_date": fc_end.isoformat()})
            n = len(out)
            # Days before today in the forecast API are its recent analysis, not a forecast.
            _merge_daily(out, data, "forecast", url, observed_before=today)
            log.append(f"forecast API {fc_start}..{fc_end}: {len(out) - n} days")
        except Exception as e:  # noqa: BLE001
            log.append(f"forecast failed: {e}")
    return out, log


def fetch_forecast_weather(start: date, end: date, now_local: datetime) -> tuple[dict[date, dict], list[str]]:
    """Day-ahead forecasts (each hour forecast 24 h before it), aggregated to the local day."""
    lat, lon = ANN_ARBOR
    last = min(end, now_local.date() if now_local.time() >= datetime.strptime("05:00", "%H:%M").time() else now_local.date() - timedelta(days=1))
    if last < start:
        return {}, ["day-ahead forecasts: nothing to fetch"]
    try:
        data, url = _get_json(PREVIOUS_RUNS_URL, {
            "latitude": lat, "longitude": lon, "hourly": "temperature_2m_previous_day1,precipitation_previous_day1",
            "temperature_unit": "fahrenheit", "precipitation_unit": "inch", "timezone": "America/Detroit",
            "start_date": start.isoformat(), "end_date": last.isoformat()})
    except Exception as e:  # noqa: BLE001 - logged, forecast weather stays null
        return {}, [f"day-ahead forecasts failed: {e}"]
    out = day_ahead_daily(data, url)
    return out, [f"day-ahead forecasts (Previous Runs API) {start}..{last}: {len(out)} days"]


def day_ahead_daily(data: dict, url: str) -> dict[date, dict]:
    """Hourly `_previous_day1` values -> per local day: max temperature, total precipitation. A day with
    any missing hour is left out (a partial day would understate rain or the high)."""
    h = data.get("hourly") or {}
    by_day: dict[date, list[tuple]] = {}
    for t, temp, rain in zip(h.get("time", []), h.get("temperature_2m_previous_day1", []), h.get("precipitation_previous_day1", [])):
        by_day.setdefault(date.fromisoformat(t[:10]), []).append((temp, rain))
    out = {}
    for d, vals in by_day.items():
        if len(vals) < 23 or any(t is None or r is None for t, r in vals):  # 23: the spring-forward day
            continue
        out[d] = {"fc_temp_high_f": round(max(t for t, _ in vals), 1), "fc_precip_in": round(max(0.0, sum(r for _, r in vals)), 2),
                  "fc_lead_hours": DAY_AHEAD_HOURS, "fc_source": "open-meteo-previous-runs", "fc_source_url": url}
    return out


def _merge_daily(out: dict, data: dict, kind: str, url: str, observed_before: date | None = None) -> None:
    d = data.get("daily") or {}
    for i, day in enumerate(d.get("time", [])):
        t, p, c = d["temperature_2m_max"][i], d["precipitation_sum"][i], d["weather_code"][i]
        if t is None and p is None:
            continue
        dd = date.fromisoformat(day)
        k = "observed" if observed_before and dd < observed_before else kind
        out[dd] = {"temp_high_f": t, "precip_in": max(0.0, p) if p is not None else None,
                   "weather_summary": wmo_summary(c), "weather_kind": k, "url": url}


FC_KEYS = ("fc_temp_high_f", "fc_precip_in", "fc_lead_hours", "fc_source", "fc_source_url")


def build_rows(halls: list[str], cal: dict[date, dict], weather: dict[date, dict], now_iso: str,
               forecast_weather: dict[date, dict] | None = None) -> list[dict]:
    rows = []
    for hall in halls:
        for d, c in sorted(cal.items()):
            w = weather.get(d, {})
            fc = (forecast_weather or {}).get(d)
            urls = dict(c["urls"])
            if w:
                urls["weather"] = w["url"]
            rows.append({
                "hall_id": hall, "service_date": d.isoformat(),
                "weather_summary": w.get("weather_summary"), "temp_high_f": w.get("temp_high_f"), "precip_in": w.get("precip_in"),
                "weather_kind": w.get("weather_kind"),
                "exam_week": c["exam_week"], "home_game": c["home_game"], "is_holiday": c["is_holiday"], "holiday_name": c["holiday_name"],
                "events_note": "; ".join(c["events"]) or None, "academic_note": c["academic_note"], "class_day": c["class_day"],
                "study_day": c["study_day"], "break_day": c["break_day"], "first_class_day": c["first_class_day"],
                "source_urls": urls, "is_simulated": False, "imported_at": now_iso, "updated_at": now_iso,
                **{k: (fc or {}).get(k) for k in FC_KEYS}, "fc_fetched_at": now_iso if fc else None,
            })
    return rows


def real_halls(all_halls: list[str]) -> list[str]:
    return [h for h in all_halls if h not in TEST_HALLS and not h.startswith(TEST_HALL_PREFIXES)]


def drop_simulated(rows: list[dict], simulated: set[tuple[str, str]]) -> tuple[list[dict], list[tuple[str, str]]]:
    keep = [r for r in rows if (r["hall_id"], r["service_date"]) not in simulated]
    skipped = [(r["hall_id"], r["service_date"]) for r in rows if (r["hall_id"], r["service_date"]) in simulated]
    return keep, skipped


def summarize(rows: list[dict]) -> list[dict]:
    by: dict[str, dict] = {}
    for r in rows:
        s = by.setdefault(r["hall_id"], {"hall": r["hall_id"], "days": 0, "weather": 0, "observed": 0, "forecast": 0, "exam": 0,
                                          "study": 0, "break": 0, "class": 0, "home_game": 0, "holiday": 0})
        s["days"] += 1
        s["weather"] += r["temp_high_f"] is not None
        s["observed"] += r["weather_kind"] == "observed"
        s["forecast"] += r["weather_kind"] == "forecast"
        s["exam"] += r["exam_week"]
        s["study"] += r["study_day"]
        s["break"] += r["break_day"]
        s["class"] += bool(r["class_day"])
        s["home_game"] += r["home_game"]
        s["holiday"] += r["is_holiday"]
    return list(by.values())


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m forecast.context_import", description=__doc__.split("\n\n")[0])
    p.add_argument("--start", default="2026-08-01")
    p.add_argument("--end", default="2027-05-31")
    p.add_argument("--hall", action="append", help="limit to these halls (default: every non-test hall)")
    p.add_argument("--today", help="override today's date (tests)")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    start, end = date.fromisoformat(a.start), date.fromisoformat(a.end)
    today = date.fromisoformat(a.today) if a.today else datetime.now().date()
    db = Supabase.from_env()
    halls = a.hall or real_halls([h["hall_id"] for h in db.select("hall", columns="hall_id")])
    cal = calendar_days(load_sources(), start, end)
    weather, wlog = fetch_weather(start, end, today)
    now_local = datetime.combine(today, datetime.now().time()) if a.today else datetime.now()
    fc_weather, fclog = fetch_forecast_weather(start, end, now_local)
    wlog += fclog
    now_iso = datetime.now(timezone.utc).isoformat()
    rows = build_rows(halls, cal, weather, now_iso, fc_weather)
    sim = {(r["hall_id"], r["service_date"]) for r in db.select("context_day", {"is_simulated": "eq.true"}, "hall_id,service_date")}
    rows, skipped = drop_simulated(rows, sim)
    print(f"halls: {', '.join(halls)}")
    for line in wlog:
        print(f"weather: {line}")
    if skipped:
        print(f"skipped {len(skipped)} hall-days that hold SIMULATED rows (kept as they are): "
              f"{skipped[0][0]} {min(s[1] for s in skipped)}..{max(s[1] for s in skipped)}")
    print("hall | days | with weather (observed/forecast) | class days | exam | study | break | home games | holidays")
    for s in summarize(rows):
        print(f"{s['hall']} | {s['days']} | {s['weather']} ({s['observed']}/{s['forecast']}) | {s['class']} | {s['exam']} | {s['study']} | "
              f"{s['break']} | {s['home_game']} | {s['holiday']}")
    if a.dry_run:
        print("dry run: nothing written")
        return 0
    db.insert("context_day", rows, on_conflict="hall_id,service_date", upsert=True)
    print(f"upserted {len(rows)} rows (is_simulated = false); {sum(1 for r in rows if r['fc_source'])} with a day-ahead weather forecast")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
