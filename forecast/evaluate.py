"""Evaluation harness: how did forecasts do once the meals happened?

    python -m forecast.evaluate --hall hall-main --start 2026-10-01 --end 2026-10-24 [--dry-run]

For every dish x past meal with a CONFIRMED production row and a baseline-v1
forecast, it writes one forecast_outcome row and prints, for our model and
the FSS forecast (when present):

  * WAPE (weighted absolute % error) = sum |forecast - consumed| / sum consumed,
    over meals that did NOT run out (a ran-out meal's true demand is unknown).
    Ours is scored on its demand forecast; FSS on its forecast.
  * stockouts: meals where the prep amount was below what was consumed (for a
    ran-out meal, consumed is a lower bound, so this is a certain shortfall).
  * leftover lb: what that prep amount would have left in the pan.
  * actual pan leftover, and tray waste in lb and $, where known.

It reads whatever is in the tables, so it runs on real data later with no code
changes. Simulated rows stay labeled: an outcome is is_simulated when its
inputs are, and simulated tray waste is marked tray_waste_source='simulated'.
"""

from __future__ import annotations

import argparse
import json
from datetime import date

from .config import impact_score_for, load_settings
from .data import load_hall
from .db import Supabase
from .model import MODEL_VERSION, Outcome, cost_of_waste_per_lb, evaluate, wape
from .simulate import simulated_tray_waste_lb


def run(hall_id: str, start: date, end: date, dry_run: bool = False, db: Supabase | None = None) -> dict:
    db = db or Supabase.from_env()
    s = load_settings()
    data = load_hall(db, hall_id, s)
    forecasts = db.select(
        "forecast",
        {"hall_id": f"eq.{hall_id}", "model_version": f"eq.{MODEL_VERSION}", "service_date": f"gte.{start}", "and": f"(service_date.lte.{end})"},
        "forecast_id,service_date,meal_label,dish_id,demand_lb,recommended_prep_lb,fss_forecast_lb,is_simulated",
    )
    actual = {(o.service_date, o.meal, o.dish_id): o for o in data.history if start <= o.service_date <= end}
    rows, ours, fss, ours_point = [], [], [], []
    for f in forecasts:
        key = (date.fromisoformat(f["service_date"]), f["meal_label"], f["dish_id"])
        o = actual.get(key)
        if o is None or o.consumed_lb is None:
            continue
        dish = data.dishes.get(f["dish_id"])
        co = cost_of_waste_per_lb((dish.food_cost_usd_per_lb if dish else None) or s.default_food_cost_usd_per_lb, impact_score_for(dish.impact_food_name if dish else None, s))
        prep = float(f["recommended_prep_lb"])
        fss_lb = float(f["fss_forecast_lb"]) if f.get("fss_forecast_lb") is not None else data.fss.get(key)
        consumed = o.consumed_lb
        simulated = bool(f.get("is_simulated")) or o.is_simulated
        share = data.tray_waste_share.get(f["dish_id"])
        if share:
            tray_lb, tray_src = round(consumed * share, 2), "calibrated_scans"
        elif simulated:
            tray_lb, tray_src = simulated_tray_waste_lb(f["dish_id"], key[0], key[1], consumed), "simulated"
        else:
            tray_lb, tray_src = None, None
        ours.append(Outcome(prep, consumed, o.censored, o.leftover_lb))
        ours_point.append(Outcome(float(f["demand_lb"]) if f.get("demand_lb") is not None else prep, consumed, o.censored, o.leftover_lb))
        if fss_lb is not None:
            fss.append(Outcome(fss_lb, consumed, o.censored, o.leftover_lb))
        rows.append({
            "forecast_id": f["forecast_id"],
            "hall_id": hall_id,
            "service_date": f["service_date"],
            "meal_label": f["meal_label"],
            "dish_id": f["dish_id"],
            "model_version": MODEL_VERSION,
            "recommended_prep_lb": prep,
            "fss_forecast_lb": fss_lb,
            "prepped_lb": o.prepped_lb,
            "consumed_lb": round(consumed, 2),
            "consumed_is_lower_bound": o.censored,
            "error_lb": round(prep - consumed, 2),
            "fss_error_lb": round(fss_lb - consumed, 2) if fss_lb is not None else None,
            "ran_out": o.censored,
            "pan_leftover_lb": o.leftover_lb,
            "tray_waste_lb": tray_lb,
            "tray_waste_source": tray_src,
            "leftover_cost_usd": round((o.leftover_lb or 0.0) * co, 2),
            "tray_waste_cost_usd": round(tray_lb * co, 2) if tray_lb is not None else None,
            "is_simulated": simulated,
        })
    if rows and not dry_run:
        db.insert("forecast_outcome", rows, on_conflict="hall_id,service_date,meal_label,dish_id,model_version", upsert=True)
    point_pairs = [(o.forecast_lb, o.consumed_lb) for o in ours_point if not o.censored]
    summary = {
        "hallId": hall_id,
        "window": [start.isoformat(), end.isoformat()],
        "outcomesWritten": 0 if dry_run else len(rows),
        "simulatedOutcomes": sum(1 for r in rows if r["is_simulated"]),
        "ours": {**evaluate(ours), "wape_demand_forecast": wape(point_pairs), "model": MODEL_VERSION},
        "fss": evaluate(fss) if fss else None,
        "actual": {
            "pan_leftover_lb": round(sum(r["pan_leftover_lb"] or 0 for r in rows), 2),
            "ran_out_meals": sum(1 for r in rows if r["ran_out"]),
            "tray_waste_lb": round(sum(r["tray_waste_lb"] or 0 for r in rows), 2) if any(r["tray_waste_lb"] is not None for r in rows) else None,
            "tray_waste_sources": sorted({r["tray_waste_source"] for r in rows if r["tray_waste_source"]}),
            "leftover_cost_usd": round(sum(r["leftover_cost_usd"] or 0 for r in rows), 2),
        },
        "notes": data.notes,
    }
    return summary


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m forecast.evaluate", description=__doc__.split("\n\n")[0])
    p.add_argument("--hall", default="hall-main")
    p.add_argument("--start", required=True, type=date.fromisoformat)
    p.add_argument("--end", required=True, type=date.fromisoformat)
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    print(json.dumps(run(a.hall, a.start, a.end, a.dry_run), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
