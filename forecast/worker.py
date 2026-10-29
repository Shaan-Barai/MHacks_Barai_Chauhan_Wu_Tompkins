"""Forecast worker (forecast/README.md): baseline-v1 forecasts + newsvendor prep buffer.

A small local service in the same style as the SAM worker, plus a CLI. It
reads confirmed production history, swipes and the menu cycle from Supabase
(service role key, server only) and writes one `forecast` row per dish x meal.

    python -m forecast.worker run --hall hall-main --start 2026-10-25 --end 2026-10-31
    python -m forecast.worker run --hall hall-main --start ... --end ... --dry-run
    python -m forecast.worker serve        # http://127.0.0.1:8791

POST /run  {"hallId", "start", "end", "dryRun"?}  -> {"written", "skipped", "notes", "forecasts"?}
GET  /health                                      -> model version, settings file

Env: SUPABASE_URL (https://<ref>.supabase.co), SUPABASE_SERVICE_ROLE_KEY,
FORECAST_PORT (8791), WORKER_HOST (127.0.0.1), WORKER_TOKEN (optional; when
set, POST requests must send a matching X-Worker-Token header or get 401).

Simulated inputs make simulated forecasts: is_simulated is set whenever the
dish, its history or the attendance it used is simulated.

Shadow mode (migration 20261028000017): the database locks a forecast row when
its meal's service starts. The worker upserts only rows whose service has not
started; for started services it inserts missing rows and leaves existing ones
untouched. Such late rows are kept but never count as locked forecasts
(created_at >= locks_at), so `python -m forecast.shadow_report` leaves them out.
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

from .config import CONFIG_PATH, impact_score_for, load_settings
from .data import HallData, dishes_for, load_hall
from .db import Supabase, SupabaseError
from .model import MODEL_VERSION, context_multiplier, cost_of_waste_per_lb, make_forecast, relative_errors

MEALS = ("breakfast", "lunch", "dinner")


def _dates(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def build_forecasts(
    data: HallData, start: date, end: date, meals: tuple[str, ...] = MEALS, q_shift: float = 0.0
) -> tuple[list[dict], list[str]]:
    """Forecast rows for every dish x meal in [start, end], each using only data before its date.
    `q_shift` moves every dish's service level in log-odds (evaluation's matched-stockouts mode)."""
    s = load_settings()
    rows: list[dict] = []
    skipped: list[str] = []
    now = datetime.now(timezone.utc).isoformat()
    ctx = s.context
    for day in _dates(start, end):
        for meal in meals:
            served = dishes_for(data, day, meal)
            if not served:
                continue
            adjust = (
                context_multiplier(
                    data.attendance, data.context, day, meal,
                    min_days=int(ctx.get("min_days", 2)), lo=float(ctx.get("min_multiplier", 0.3)), hi=float(ctx.get("max_multiplier", 2.0)),
                )
                if ctx.get("enabled")
                else None
            )
            for dish_id in served:
                dish = data.dishes.get(dish_id)
                if dish is None:
                    skipped.append(f"{day} {meal} {dish_id}: not in the dish table")
                    continue
                same_style = {d for d, x in data.dishes.items() if x.service_style == dish.service_style}
                errors = relative_errors(data.history, day, meal, same_style, data.cycle_start, data.cycle_weeks, data.attendance, s.error_window_days)
                if len(errors) < 5:
                    errors = relative_errors(data.history, day, meal, None, data.cycle_start, data.cycle_weeks, data.attendance, s.error_window_days)
                co = cost_of_waste_per_lb(dish.food_cost_usd_per_lb or s.default_food_cost_usd_per_lb, impact_score_for(dish.impact_food_name, s))
                fc = make_forecast(
                    history=data.history, attendance=data.attendance, target=day, meal=meal, dish_id=dish_id,
                    dish_name=dish.display_name, portion_lb=dish.portion_lb, cycle_start=data.cycle_start, weeks=data.cycle_weeks,
                    cost_under=s.cost_under(dish.service_style), cost_over=co,
                    tray_waste_share=data.tray_waste_share.get(dish_id), errors=errors, q_shift=q_shift,
                    context_adjustment=adjust,
                )
                if fc is None:
                    skipped.append(f"{day} {meal} {dish_id}: no history yet")
                    continue
                simulated = dish.is_simulated or data.attendance_simulated or any(o.is_simulated for o in data.history if o.dish_id == dish_id)
                rows.append({
                    "hall_id": data.hall_id,
                    "service_date": day.isoformat(),
                    "meal_label": meal,
                    "dish_id": dish_id,
                    "expected_diners": fc.expected_diners,
                    "take_rate": fc.take_rate,
                    "demand_lb": fc.demand_lb,
                    "expected_eaten_lb": fc.expected_eaten_lb,
                    "recommended_prep_lb": fc.recommended_prep_lb,
                    "low_lb": fc.low_lb,
                    "high_lb": fc.high_lb,
                    "fss_forecast_lb": data.fss.get((day, meal, dish_id)),
                    "service_level_q": round(fc.q, 3),
                    "basis": fc.basis,
                    "why": fc.why,
                    "model_version": MODEL_VERSION,
                    "generated_at": now,
                    "is_simulated": simulated,
                })
    return rows, skipped


LOCK_MARGIN = timedelta(minutes=2)  # clock skew between this machine and the database


def service_start(day: date, meal: str, tz: str, meals: dict[str, list[str]]) -> datetime:
    """When the meal's service starts, in UTC: the moment the database locks its forecasts."""
    return datetime.combine(day, datetime.strptime(meals[meal][0], "%H:%M").time(), ZoneInfo(tz)).astimezone(timezone.utc)


def split_by_lock(rows: list[dict], tz: str, meals: dict[str, list[str]], now: datetime) -> tuple[list[dict], list[dict]]:
    """(rows whose service has not started: may be revised, rows whose service started: locked)."""
    open_, started = [], []
    for r in rows:
        starts = service_start(date.fromisoformat(r["service_date"]), r["meal_label"], tz, meals)
        (open_ if starts > now + LOCK_MARGIN else started).append(r)
    return open_, started


def run(hall_id: str, start: date, end: date, dry_run: bool = False, db: Supabase | None = None, now: datetime | None = None) -> dict:
    if end < start:
        raise ValueError("end is before start")
    if (end - start).days > 400:
        raise ValueError("at most 400 days per run")
    db = db or Supabase.from_env()
    data = load_hall(db, hall_id)
    rows, skipped = build_forecasts(data, start, end)
    open_rows, started_rows = split_by_lock(rows, data.timezone, load_settings().meals, now or datetime.now(timezone.utc))
    if not dry_run:
        key = "hall_id,service_date,meal_label,dish_id,model_version"
        if open_rows:
            db.insert("forecast", open_rows, on_conflict=key, upsert=True)
        if started_rows:  # locked once the service started: add missing rows (late, never "locked"), revise nothing
            db.insert("forecast", started_rows, on_conflict=key, ignore_duplicates=True)
    return {
        "hallId": hall_id,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "modelVersion": MODEL_VERSION,
        "written": 0 if dry_run else len(rows),
        "forecasts": len(rows),
        "beforeServiceStart": len(open_rows),
        "afterServiceStart": len(started_rows),
        "simulated": sum(1 for r in rows if r["is_simulated"]),
        "skipped": skipped,
        "notes": data.notes,
        **({"rows": rows} if dry_run else {}),
    }


# ---------------------------------------------------------------------------
# HTTP service (same shape as vision/sam/worker.py)
# ---------------------------------------------------------------------------

TOKEN = os.environ.get("WORKER_TOKEN", "")


class Handler(BaseHTTPRequestHandler):
    server_version = "scrap-forecast/1"

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):  # path only, never bodies
        sys.stderr.write(f"[forecast] {self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}\n")

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            return self._send(200, {"ok": True, "model": MODEL_VERSION, "config": str(CONFIG_PATH), "tokenRequired": bool(TOKEN)})
        self._send(404, {"error": {"code": "NOT_FOUND", "message": "Unknown route."}})

    def do_POST(self):
        if self.path.split("?")[0] != "/run":
            return self._send(404, {"error": {"code": "NOT_FOUND", "message": "Unknown route."}})
        if TOKEN and not hmac.compare_digest(self.headers.get("X-Worker-Token", ""), TOKEN):
            return self._send(401, {"error": {"code": "UNAUTHORIZED", "message": "Missing or wrong X-Worker-Token."}})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 64 * 1024:
                return self._send(413, {"error": {"code": "TOO_LARGE", "message": "Request body too large."}})
            body = json.loads(self.rfile.read(length) or b"{}")
            result = run(str(body["hallId"]), date.fromisoformat(body["start"]), date.fromisoformat(body["end"]), bool(body.get("dryRun")))
            self._send(200, result)
        except (KeyError, ValueError, TypeError) as e:
            self._send(400, {"error": {"code": "BAD_REQUEST", "message": f"Send hallId, start and end (YYYY-MM-DD): {e}"}})
        except SupabaseError as e:
            self._send(502, {"error": {"code": "DATABASE_UNAVAILABLE", "message": str(e), "retryable": True}})


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m forecast.worker", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="write forecasts for a date range")
    r.add_argument("--hall", default="hall-main")
    r.add_argument("--start", required=True, type=date.fromisoformat)
    r.add_argument("--end", required=True, type=date.fromisoformat)
    r.add_argument("--dry-run", action="store_true", help="compute and print, write nothing")
    sv = sub.add_parser("serve", help="run the HTTP service")
    sv.add_argument("--port", type=int, default=int(os.environ.get("FORECAST_PORT", "8791")))
    sv.add_argument("--host", default=os.environ.get("WORKER_HOST", "127.0.0.1"))
    a = p.parse_args(argv)
    if a.cmd == "run":
        res = run(a.hall, a.start, a.end, a.dry_run)
        rows = res.pop("rows", None)
        print(json.dumps(res, indent=2))
        if rows:
            for row in rows[:20]:
                print(f"  {row['service_date']} {row['meal_label']:<6} {row['dish_id']:<28} prep {row['recommended_prep_lb']:>7} lb  ({row['low_lb']}–{row['high_lb']})")
        return 0
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"[forecast] {MODEL_VERSION} listening on http://{a.host}:{a.port}", file=sys.stderr)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
