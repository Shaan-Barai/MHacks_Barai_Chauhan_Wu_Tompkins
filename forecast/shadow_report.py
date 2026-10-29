"""Shadow-mode report: LOCKED forecasts vs. FSS vs. actuals over any date range.

    python -m forecast.shadow_report --hall hall-main --start 2026-10-24 --end 2026-10-30 [--model baseline-v1] [--json]

A forecast counts as LOCKED only when the database recorded it before its
meal's service started and kept it unchanged from then on (migration
20261028000017: created_at < locks_at, lock_tracked, and the service has
started). Everything else is counted and left out, never scored:
  * late             written after the service started (backfills, re-runs);
  * before shadow    written before shadow mode existed, so it may have been
                     revised after its service;
  * not started      the service has not started yet.

Scored on the same dish-meals for both: a locked forecast, an FSS forecast
and a confirmed actual (production_log). The metrics are those of
forecast/evaluate.py:
  * WAPE and bias on meals that did not run out (a ran-out meal's demand is
    unknown);
  * stockouts;
  * pan leftover in lb and $ (food cost + Waste Impact Score).

At matched stockouts, every locked prep amount is multiplied by one shared
factor k: the smallest k at which its stockouts are no more than FSS's. Leftovers
are then compared at equal risk of running out. k is printed; stored forecasts
are never changed.

The result is labeled SIMULATED when any input it used (a forecast, FSS row,
production row or attendance count) is simulated.
"""

from __future__ import annotations

import argparse
import json
from datetime import date, datetime, timezone

from .config import Settings, load_settings
from .data import HallData, load_hall, parse_iso
from .db import Supabase
from .evaluate import _co, comparison_label
from .model import MODEL_VERSION, Outcome, evaluate, wape

SIMULATED_LABEL = "SIMULATED: at least one input is simulated, not M-Dining records"


def classify(rows: list[dict], now: datetime) -> dict[str, list[dict]]:
    """Split stored forecast rows into locked / late / before_shadow / not_started."""
    out: dict[str, list[dict]] = {"locked": [], "late": [], "before_shadow": [], "not_started": []}
    for r in rows:
        locks_at = parse_iso(r["locks_at"])
        if locks_at > now:
            out["not_started"].append(r)
        elif not r.get("lock_tracked", False):
            out["before_shadow"].append(r)
        elif parse_iso(r["created_at"]) >= locks_at:
            out["late"].append(r)
        else:
            out["locked"].append(r)
    return out


def _side(data: HallData, pairs: list[tuple[tuple, float]], s: Settings) -> dict:
    """Metrics for (key, prep lb) pairs against the actuals."""
    actual = {(o.service_date, o.meal, o.dish_id): o for o in data.history}
    outs, point, usd, bn, bd = [], [], 0.0, 0.0, 0.0
    for k, prep in pairs:
        o = actual[k]
        outs.append(Outcome(prep, o.consumed_lb, o.censored, o.leftover_lb))
        if not o.censored:
            point.append((prep, o.consumed_lb))
            bn += prep - o.consumed_lb
            bd += o.consumed_lb
            usd += max(0.0, prep - o.consumed_lb) * _co(data, k[2], s)
    r = evaluate(outs)
    r.update({"wape": wape(point), "bias": bn / bd if bd else None, "leftover_usd": round(usd, 2)})
    return r


def matched_scale(data: HallData, pairs: list[tuple[tuple, float]], target_stockouts: int, s: Settings) -> dict:
    """Smallest shared factor k (0.2-5) with stockouts(k x prep) <= target; metrics there."""
    lo, hi = 0.2, 5.0
    best = _side(data, [(k, p * hi) for k, p in pairs], s)
    if best["stockouts"] > target_stockouts:
        return {**best, "scale": hi, "reached": False}
    for _ in range(30):
        mid = (lo + hi) / 2
        r = _side(data, [(k, p * mid) for k, p in pairs], s)
        if r["stockouts"] <= target_stockouts:
            hi, best = mid, r
        else:
            lo = mid
    return {**best, "scale": round(hi, 4), "reached": True}


def report(data: HallData, rows: list[dict], start: date, end: date, model: str, s: Settings, now: datetime) -> dict:
    groups = classify(rows, now)
    actual = {(o.service_date, o.meal, o.dish_id): o for o in data.history}
    locked = {(date.fromisoformat(str(r["service_date"])), r["meal_label"], r["dish_id"]): r for r in groups["locked"]}
    keys = sorted(k for k in locked if k in actual and actual[k].consumed_lb is not None and k in data.fss)
    ours = [(k, float(locked[k]["recommended_prep_lb"])) for k in keys]
    fss = [(k, data.fss[k]) for k in keys]
    used_simulated = (
        any(locked[k].get("is_simulated") for k in keys)
        or any(actual[k].is_simulated for k in keys)
        or (data.fss_simulated and bool(keys))
        or (data.attendance_simulated and bool(keys))
    )
    # With nothing scored, the label still warns when the window's inputs are simulated.
    present_simulated = any(r.get("is_simulated") for r in rows) or data.fss_simulated or any(o.is_simulated for o in data.history)
    if keys:
        label = SIMULATED_LABEL if used_simulated else "real data"
    else:
        label = "nothing scored" + (" (this window's inputs are SIMULATED)" if present_simulated else "")
    out: dict = {
        "hallId": data.hall_id, "window": [start.isoformat(), end.isoformat()], "model": model,
        "simulated": used_simulated if keys else present_simulated, "label": label,
        "comparisonLabel": comparison_label(data),
        "rows": {g: len(v) for g, v in groups.items()},
        "scoredMeals": len(keys),
        "censoredMeals": sum(1 for k in keys if actual[k].censored),
        "lockedWithoutActualOrFss": len(locked) - len(keys),
        "notes": list(data.notes),
    }
    if not keys:
        out["notes"].append("no locked forecast in this window has both an FSS forecast and a confirmed actual")
        return out
    out["locked"] = _side(data, ours, s)
    out["fss"] = _side(data, fss, s)
    out["lockedMatched"] = matched_scale(data, ours, int(out["fss"]["stockouts"]), s)
    return out


def run(hall_id: str, start: date, end: date, model: str = MODEL_VERSION, db: Supabase | None = None, now: datetime | None = None) -> dict:
    db = db or Supabase.from_env()
    s = load_settings()
    data = load_hall(db, hall_id, s)
    rows = db.select(
        "forecast",
        {"hall_id": f"eq.{hall_id}", "model_version": f"eq.{model}", "service_date": f"gte.{start}", "and": f"(service_date.lte.{end})"},
        "service_date,meal_label,dish_id,recommended_prep_lb,created_at,locks_at,lock_tracked,is_simulated",
    )
    return report(data, rows, start, end, model, s, now or datetime.now(timezone.utc))


def table(r: dict) -> str:
    lines = [f"{r['label']}", f"hall {r['hallId']}  {r['window'][0]}..{r['window'][1]}  model {r['model']}  vs. {r['comparisonLabel']}",
             "forecast rows: " + ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in r["rows"].items()),
             f"scored dish-meals (locked + FSS + actual): {r['scoredMeals']} ({r['censoredMeals']} ran out)"]
    if "locked" not in r:
        return "\n".join(lines + r["notes"])

    def f(x, pct=False):
        return "—" if x is None else (f"{x * 100:.1f}%" if pct else f"{x:,.0f}")
    lines.append("forecast | WAPE | bias | stockouts | leftover lb | leftover $")
    m = r["lockedMatched"]
    for name, x in ((f"{r['model']} (locked)", r["locked"]), (f"{r['model']} (locked) x {m['scale']} matched", m),
                    (r["comparisonLabel"], r["fss"])):
        lines.append(f"{name} | {f(x['wape'], True)} | {f(x['bias'], True)} | {x['stockouts']} | {f(x['leftover_lb'])} | ${f(x['leftover_usd'])}")
    if not m["reached"]:
        lines.append("matched stockouts not reached even at 5x the locked amounts")
    return "\n".join(lines + r["notes"])


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m forecast.shadow_report", description=__doc__.split("\n\n")[0])
    p.add_argument("--hall", default="hall-main")
    p.add_argument("--start", required=True, type=date.fromisoformat)
    p.add_argument("--end", required=True, type=date.fromisoformat)
    p.add_argument("--model", default=MODEL_VERSION)
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    if a.end < a.start:
        p.error("end is before start")
    r = run(a.hall, a.start, a.end, a.model)
    print(json.dumps(r, indent=2, default=str) if a.json else table(r))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
