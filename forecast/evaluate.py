"""Evaluation harness: how did forecasts do once the meals happened?

    python -m forecast.evaluate --hall hall-main --start 2026-09-26 --end 2026-10-23 [--dry-run]

Two modes, both printed:

  default   Our stored forecasts at the configured service levels vs. the
            comparison forecast (FSS). Writes one forecast_outcome row per
            dish x past meal (skipped with --dry-run).
  matched   A fair leftover comparison: every dish's service level is moved
            together (in log-odds) until our stockouts are no more than the
            comparison forecast's, then leftover lb and $ are compared at
            (about) equal stockouts. Computed in memory; writes nothing.

Definitions (forecast/model.py):
  * WAPE = sum |forecast - consumed| / sum consumed over meals that did NOT run
    out (a ran-out meal's true demand is unknown). Ours: its demand forecast.
  * stockout = that prep amount would not have covered demand (below what was
    consumed, or at/below it on a ran-out meal).
  * leftover = max(0, prep - consumed) on meals that did not run out, the same
    formula for both forecasts; $ = lb x (food cost + Waste Impact Score).

The comparison forecast is labeled from the data: when its rows are the
simulator's stand-in it is "Simulated FSS (assumed +25% over-prep)". It reads
whatever is in the tables, so it runs on real data later with no code changes.
"""

from __future__ import annotations

import argparse
import json
from datetime import date

from .config import Settings, impact_score_for, load_settings
from .data import HallData, load_hall
from .db import Supabase
from .model import MODEL_VERSION, Outcome, cost_of_waste_per_lb, evaluate, shift_q, wape
from .simulate import simulated_tray_waste_lb

SIMULATED_FSS_LABEL = "Simulated FSS (assumed +25% over-prep)"
REAL_FSS_LABEL = "FSS"


def comparison_label(data: HallData) -> str:
    return SIMULATED_FSS_LABEL if data.fss_simulated else REAL_FSS_LABEL


def _co(data: HallData, dish_id: str, s: Settings) -> float:
    dish = data.dishes.get(dish_id)
    return cost_of_waste_per_lb((dish.food_cost_usd_per_lb if dish else None) or s.default_food_cost_usd_per_lb, impact_score_for(dish.impact_food_name if dish else None, s))


def score(data: HallData, forecasts: list[dict], s: Settings) -> dict:
    """Ours vs. the comparison forecast on the meals that have an actual, with $ on the same formula."""
    actual = {(o.service_date, o.meal, o.dish_id): o for o in data.history}
    ours, comp, point = [], [], []
    ours_usd = comp_usd = 0.0
    for f in forecasts:
        key = (date.fromisoformat(str(f["service_date"])), f["meal_label"], f["dish_id"])
        o = actual.get(key)
        if o is None or o.consumed_lb is None:
            continue
        prep = float(f["recommended_prep_lb"])
        co = _co(data, f["dish_id"], s)
        ours.append(Outcome(prep, o.consumed_lb, o.censored, o.leftover_lb))
        point.append((float(f["demand_lb"]) if f.get("demand_lb") is not None else prep, o.consumed_lb, o.censored))
        if not o.censored:
            ours_usd += max(0.0, prep - o.consumed_lb) * co
        fss = data.fss.get(key)
        if fss is not None:
            comp.append(Outcome(fss, o.consumed_lb, o.censored, o.leftover_lb))
            if not o.censored:
                comp_usd += max(0.0, fss - o.consumed_lb) * co
    mine = evaluate(ours)
    mine["wape_demand_forecast"] = wape([(f, a) for f, a, c in point if not c])
    mine["leftover_usd"] = round(ours_usd, 2)
    other = evaluate(comp) if comp else None
    if other is not None:
        other["leftover_usd"] = round(comp_usd, 2)
    return {"ours": mine, "comparison": other}


def matched(data: HallData, start: date, end: date, target_stockouts: int, s: Settings) -> dict:
    """Smallest shared q shift at which our stockouts <= target; leftover compared there."""
    from .worker import build_forecasts  # local import: worker imports evaluate's siblings

    def at(shift: float) -> dict:
        rows, _ = build_forecasts(data, start, end, q_shift=shift)
        return score(data, rows, s)

    lo, hi = -2.0, 8.0  # stockouts fall as the shift rises
    best = at(hi)
    if best["ours"]["stockouts"] > target_stockouts:
        return {"shift": hi, "reached": False, **best}
    for _ in range(18):
        mid = (lo + hi) / 2
        r = at(mid)
        if r["ours"]["stockouts"] <= target_stockouts:
            hi, best = mid, r
        else:
            lo = mid
    return {"shift": round(hi, 3), "reached": True, **best}


def run(hall_id: str, start: date, end: date, dry_run: bool = False, db: Supabase | None = None, modes: tuple[str, ...] = ("default", "matched")) -> dict:
    db = db or Supabase.from_env()
    s = load_settings()
    data = load_hall(db, hall_id, s)
    label = comparison_label(data)
    stored = db.select(
        "forecast",
        {"hall_id": f"eq.{hall_id}", "model_version": f"eq.{MODEL_VERSION}", "service_date": f"gte.{start}", "and": f"(service_date.lte.{end})"},
        "forecast_id,service_date,meal_label,dish_id,demand_lb,recommended_prep_lb,fss_forecast_lb,service_level_q,is_simulated",
    )
    out: dict = {"hallId": hall_id, "window": [start.isoformat(), end.isoformat()], "comparisonLabel": label, "notes": data.notes}

    if "default" in modes:
        default = score(data, stored, s)
        qs = [float(f["service_level_q"]) for f in stored if f.get("service_level_q") is not None]
        default["ours"]["mean_service_level_q"] = round(sum(qs) / len(qs), 3) if qs else None
        out["default"] = default
        out["outcomesWritten"] = 0 if dry_run else write_outcomes(db, data, stored, s, hall_id)
        out["simulatedOutcomes"] = sum(1 for f in stored if f.get("is_simulated"))

    if "matched" in modes:
        target = (out.get("default") or score(data, stored, s))["comparison"]
        if target is None:
            out["matched"] = {"skipped": "no comparison forecast in this window"}
        else:
            m = matched(data, start, end, int(target["stockouts"]), s)
            base_q = [float(f["service_level_q"]) for f in stored if f.get("service_level_q") is not None]
            m["mean_service_level_q"] = round(sum(shift_q(q, m["shift"]) for q in base_q) / len(base_q), 3) if base_q else None
            m["target_stockouts"] = int(target["stockouts"])
            out["matched"] = m
    return out


def write_outcomes(db: Supabase, data: HallData, stored: list[dict], s: Settings, hall_id: str) -> int:
    actual = {(o.service_date, o.meal, o.dish_id): o for o in data.history}
    rows = []
    for f in stored:
        key = (date.fromisoformat(f["service_date"]), f["meal_label"], f["dish_id"])
        o = actual.get(key)
        if o is None or o.consumed_lb is None:
            continue
        co = _co(data, f["dish_id"], s)
        prep = float(f["recommended_prep_lb"])
        fss_lb = float(f["fss_forecast_lb"]) if f.get("fss_forecast_lb") is not None else data.fss.get(key)
        simulated = bool(f.get("is_simulated")) or o.is_simulated
        share = data.tray_waste_share.get(f["dish_id"])
        if share:
            tray_lb, tray_src = round(o.consumed_lb * share, 2), "calibrated_scans"
        elif simulated:
            tray_lb, tray_src = simulated_tray_waste_lb(f["dish_id"], key[0], key[1], o.consumed_lb), "simulated"
        else:
            tray_lb, tray_src = None, None
        rows.append({
            "forecast_id": f["forecast_id"], "hall_id": hall_id, "service_date": f["service_date"], "meal_label": f["meal_label"],
            "dish_id": f["dish_id"], "model_version": MODEL_VERSION, "recommended_prep_lb": prep, "fss_forecast_lb": fss_lb,
            "prepped_lb": o.prepped_lb, "consumed_lb": round(o.consumed_lb, 2), "consumed_is_lower_bound": o.censored,
            "error_lb": round(prep - o.consumed_lb, 2), "fss_error_lb": round(fss_lb - o.consumed_lb, 2) if fss_lb is not None else None,
            "ran_out": o.censored, "pan_leftover_lb": o.leftover_lb, "tray_waste_lb": tray_lb, "tray_waste_source": tray_src,
            "leftover_cost_usd": round((o.leftover_lb or 0.0) * co, 2),
            "tray_waste_cost_usd": round(tray_lb * co, 2) if tray_lb is not None else None, "is_simulated": simulated,
        })
    if rows:
        db.insert("forecast_outcome", rows, on_conflict="hall_id,service_date,meal_label,dish_id,model_version", upsert=True)
    return len(rows)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m forecast.evaluate", description=__doc__.split("\n\n")[0])
    p.add_argument("--hall", default="hall-main")
    p.add_argument("--start", required=True, type=date.fromisoformat)
    p.add_argument("--end", required=True, type=date.fromisoformat)
    p.add_argument("--dry-run", action="store_true", help="write no forecast_outcome rows")
    p.add_argument("--mode", choices=["default", "matched", "both"], default="both")
    a = p.parse_args(argv)
    modes = ("default", "matched") if a.mode == "both" else (a.mode,)
    print(json.dumps(run(a.hall, a.start, a.end, a.dry_run, modes=modes), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
