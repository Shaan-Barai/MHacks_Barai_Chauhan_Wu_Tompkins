"""Walk-forward model comparison: every model, the same meals, no look-ahead.

    .venv/bin/python -m forecast.backtest --hall hall-main --start 2026-09-26 --end 2026-10-23 [--no-gbm] [--write]

For each day from the first day with history to `end`, every model is fitted
and asked for each dish served at each meal, through a PastView cut at that day
(models.py). A model's 10-90% range and prep amounts come from its OWN relative
errors over the previous `error_window_days` (same meal), exactly as baseline-v1
does in production: fewer than 5 errors means a default ±25% normal spread.

Scored on the meals in [start, end] that have an actual and a forecast from
EVERY model (so all rows below are on the same meals):
- WAPE and bias of the point forecast: uncensored meals only (a ran-out meal's
  true demand is unknown);
- stockouts and pan leftover (lb, $ at each dish's Co) of the prep amount at the
  default service levels (config.toml), with model.evaluate's censoring rules;
- the same at MATCHED stockouts: one shared log-odds shift per model, the
  smallest at which its stockouts are <= the comparison forecast's (FSS);
- interval coverage: share of uncensored actuals inside the model's 10-90%
  range (target about 80%).

Anything built from simulated rows is labeled SIMULATED in the output and in
forecast_model_comparison.is_simulated. Writes nothing unless --write.
"""

from __future__ import annotations

import argparse
import json
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from statistics import NormalDist

from .config import Settings, impact_score_for, load_settings
from .data import HallData, dishes_for
from .model import (DEFAULT_CV, HIGH_Q, LOW_Q, MIN_ERRORS_FOR_EMPIRICAL, Outcome, cost_of_waste_per_lb, evaluate, newsvendor_q,
                    quantile, shift_q, wape)
from .models import GradientBoosting, Model, PastView, available_models
from .unsupervised import day_types, robust_z_anomalies, without_anomalies

OUT = Path(__file__).resolve().parent / "out"
COMPARISON = "fss"


@dataclass
class Pred:
    demand: float
    errors: list[float]  # this model's relative errors known before the day (same meal)


def _days(a: date, b: date):
    d = a
    while d <= b:
        yield d
        d += timedelta(days=1)


def spread(demand: float, errors: list[float], q: float) -> float:
    if len(errors) >= MIN_ERRORS_FOR_EMPIRICAL:
        x = quantile(errors, q)
    else:
        x = DEFAULT_CV * NormalDist().inv_cdf(q)
    return max(0.0, demand * (1.0 + x))


def run_models(data: HallData, end: date, s: Settings, models: list[Model], train_history=None) -> dict[str, dict[tuple, Pred]]:
    """Walk forward to `end`. Returns model -> (day, meal, dish) -> Pred. `train_history` (default: all
    confirmed history) is what models may learn from; actuals for errors always come from data.history."""
    history = train_history if train_history is not None else data.history
    actual = {(o.service_date, o.meal, o.dish_id): o for o in data.history}
    if not data.history:
        return {m.version: {} for m in models}
    first = min(o.service_date for o in data.history) + timedelta(days=1)
    clustering = bool(s.clustering.get("enabled"))
    for m in models:
        if isinstance(m, GradientBoosting):
            m.bind(history, data.attendance, data.context, data.cycle_start, data.cycle_weeks,
                   weather_forecast=data.weather_forecast, weather_observed=data.weather_observed)
    preds: dict[str, dict[tuple, Pred]] = {m.version: {} for m in models}
    errs: dict[str, dict[str, list[tuple[date, float]]]] = {m.version: defaultdict(list) for m in models}
    window = timedelta(days=s.error_window_days)
    for day in _days(first, end):
        types = None
        if clustering:
            past_att = {k: v for k, v in data.attendance.items() if k[0] < day}
            types = day_types(past_att, {d: f for d, f in data.context.items() if d < day},
                              int(s.clustering.get("k", 4)), int(s.clustering.get("seed", 0)))
        view = PastView(history, data.attendance, data.context, day, data.cycle_start, data.cycle_weeks, day_types=types,
                        weather_forecast=data.weather_forecast, weather_observed=data.weather_observed)
        for m in models:
            if isinstance(m, GradientBoosting) and types is not None:
                m._day_types = types
            m.fit(view)
        for meal in ("breakfast", "lunch", "dinner"):
            served = dishes_for(data, day, meal)
            for m in models:
                known = [e for d0, e in errs[m.version][meal] if day - window <= d0 < day]
                for dish in served:
                    p = m.predict(view, day, meal, dish)
                    if p is not None and p > 0:
                        preds[m.version][(day, meal, dish)] = Pred(p, known)
        # The day's actuals become known after it: add each model's errors for the next days.
        for m in models:
            for (d0, meal, dish), p in preds[m.version].items():
                if d0 != day:
                    continue
                o = actual.get((d0, meal, dish))
                if o is None or o.consumed_lb is None:
                    continue
                if o.censored and o.consumed_lb < p.demand:
                    continue  # true error unknown (demand was at least consumed)
                errs[m.version][meal].append((d0, o.consumed_lb / p.demand - 1.0))
    return preds


def _q(data: HallData, dish_id: str, s: Settings, shift: float) -> tuple[float, float]:
    dish = data.dishes.get(dish_id)
    style = dish.service_style if dish else "other"
    co = cost_of_waste_per_lb((dish.food_cost_usd_per_lb if dish else None) or s.default_food_cost_usd_per_lb,
                              impact_score_for(dish.impact_food_name if dish else None, s))
    return shift_q(newsvendor_q(s.cost_under(style), co), shift), co


def score(data: HallData, preds: dict[tuple, Pred], keys: list[tuple], s: Settings, shift: float = 0.0) -> dict:
    actual = {(o.service_date, o.meal, o.dish_id): o for o in data.history}
    outs, point, inside, n_int, qs = [], [], 0, 0, []
    usd = 0.0
    bias_num = bias_den = 0.0
    for k in keys:
        o, p = actual[k], preds[k]
        q, co = _q(data, k[2], s, shift)
        qs.append(q)
        prep = spread(p.demand, p.errors, q)
        outs.append(Outcome(prep, o.consumed_lb, o.censored, o.leftover_lb))
        if not o.censored:
            point.append((p.demand, o.consumed_lb))
            bias_num += p.demand - o.consumed_lb
            bias_den += o.consumed_lb
            usd += max(0.0, prep - o.consumed_lb) * co
            lo, hi = spread(p.demand, p.errors, LOW_Q), spread(p.demand, p.errors, HIGH_Q)
            n_int += 1
            inside += lo <= o.consumed_lb <= hi
    r = evaluate(outs)
    r.update({
        "wape": wape(point),
        "bias": bias_num / bias_den if bias_den > 0 else None,
        "leftover_usd": round(usd, 2),
        "interval_coverage_10_90": inside / n_int if n_int else None,
        "mean_q": round(sum(qs) / len(qs), 3) if qs else None,
        "q_shift": round(shift, 3),
    })
    return r


def score_fss(data: HallData, keys: list[tuple], s: Settings) -> dict | None:
    actual = {(o.service_date, o.meal, o.dish_id): o for o in data.history}
    outs, point, usd, bn, bd = [], [], 0.0, 0.0, 0.0
    for k in keys:
        f = data.fss.get(k)
        if f is None:
            continue
        o = actual[k]
        outs.append(Outcome(f, o.consumed_lb, o.censored, o.leftover_lb))
        if not o.censored:
            point.append((f, o.consumed_lb))
            bn += f - o.consumed_lb
            bd += o.consumed_lb
            usd += max(0.0, f - o.consumed_lb) * _q(data, k[2], s, 0.0)[1]
    if not outs:
        return None
    r = evaluate(outs)
    r.update({"wape": wape(point), "bias": bn / bd if bd else None, "leftover_usd": round(usd, 2),
              "interval_coverage_10_90": None, "mean_q": None, "q_shift": None})
    return r


def matched(data: HallData, preds, keys, s: Settings, target_stockouts: int) -> dict:
    lo, hi = -3.0, 8.0
    best = score(data, preds, keys, s, hi)
    if best["stockouts"] > target_stockouts:
        return {**best, "reached": False}
    for _ in range(20):
        mid = (lo + hi) / 2
        r = score(data, preds, keys, s, mid)
        if r["stockouts"] <= target_stockouts:
            hi, best = mid, r
        else:
            lo = mid
    return {**best, "reached": True}


def compare(data: HallData, start: date, end: date, s: Settings | None = None, include_gbm: bool = True) -> dict:
    s = s or load_settings()
    notes = list(data.notes)
    train = None
    anomalies: list[dict] = []
    if s.anomaly.get("enabled"):
        anomalies = robust_z_anomalies(data.history, float(s.anomaly.get("threshold", 3.5)), int(s.anomaly.get("min_rows", 5)))
        train = without_anomalies(data.history, anomalies)
        notes.append(f"anomaly flag ON: {len(anomalies)} production rows routed to review and left out of training")
    models, mnotes = available_models(sorted(data.dishes), include_gbm)
    notes += mnotes
    if s.clustering.get("enabled"):
        notes.append("day-type clustering ON (k-means, per fold on past days only)")
    preds = run_models(data, end, s, models, train)
    actual = {(o.service_date, o.meal, o.dish_id): o for o in data.history}
    keys = sorted(k for k, o in actual.items() if start <= k[0] <= end and o.consumed_lb is not None
                  and all(k in preds[m.version] for m in models))
    fss = score_fss(data, keys, s)
    target = fss["stockouts"] if fss else None
    simulated = data.fss_simulated or data.attendance_simulated or any(o.is_simulated for o in data.history)
    rows = []
    for m in models:
        rows.append({"model_version": m.version, "mode": "default", **score(data, preds[m.version], keys, s)})
        if target is not None:
            rows.append({"model_version": m.version, "mode": "matched_stockouts", **matched(data, preds[m.version], keys, s, target)})
    if fss:
        rows.append({"model_version": COMPARISON, "mode": "as_given", **fss})
    return {
        "hallId": data.hall_id, "window": [start.isoformat(), end.isoformat()], "simulated": simulated,
        "label": "SIMULATED: every number comes from simulated data, not M-Dining records" if simulated else "real data",
        "comparisonLabel": ("Simulated FSS (assumed +25% over-prep)" if data.fss_simulated else "FSS") if fss else None,
        "scoredMeals": len(keys), "censoredMeals": sum(1 for k in keys if actual[k].censored),
        "predictionCounts": {m.version: len(preds[m.version]) for m in models},
        "matchedStockoutTarget": target, "rows": rows, "anomalies": anomalies, "notes": notes,
        "settings": {"error_window_days": s.error_window_days, "service_level": s.service_level,
                     "clustering": s.clustering, "anomaly": s.anomaly},
    }


def table(result: dict) -> str:
    def f(x, pct=False, d=1):
        if x is None:
            return "—"
        return f"{x * 100:.{d}f}%" if pct else (f"{x:,.{d}f}" if isinstance(x, float) else f"{x:,}")
    lines = [f"{result['label']} · hall {result['hallId']} · {result['window'][0]}..{result['window'][1]} · "
             f"{result['scoredMeals']} dish-meals ({result['censoredMeals']} ran out, censored)",
             "| model | mode | WAPE | bias | stockouts | leftover lb | leftover $ | 10–90% coverage | mean q |",
             "|---|---|---|---|---|---|---|---|---|"]
    for r in result["rows"]:
        name = result["comparisonLabel"] if r["model_version"] == COMPARISON else r["model_version"]
        lines.append(f"| {name} | {r['mode']} | {f(r['wape'], True)} | {f(r['bias'], True)} | {r['stockouts']} | {f(r['leftover_lb'], d=0)} | "
                     f"${f(r['leftover_usd'], d=0)} | {f(r['interval_coverage_10_90'], True, 0)} | {f(r['mean_q'], d=3)} |")
    return "\n".join(lines)


def write(db, result: dict) -> str:
    run_id = "bt_" + uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat()
    rows = [{
        "run_id": run_id, "hall_id": result["hallId"], "window_start": result["window"][0], "window_end": result["window"][1],
        "model_version": r["model_version"], "mode": r["mode"], "meals": r["meals"], "censored_meals": r["censored_meals"],
        "wape": r["wape"], "bias": r["bias"], "stockouts": r["stockouts"], "leftover_lb": r["leftover_lb"],
        "leftover_usd": r["leftover_usd"], "interval_coverage": r["interval_coverage_10_90"], "mean_q": r["mean_q"],
        "q_shift": r["q_shift"], "comparison_label": result["comparisonLabel"], "is_simulated": result["simulated"],
        "generated_at": now, "notes": result["notes"],
    } for r in result["rows"]]
    db.insert("forecast_model_comparison", rows)
    return run_id


def main(argv: list[str] | None = None) -> int:
    from .data import load_hall
    from .db import Supabase

    p = argparse.ArgumentParser(prog="python -m forecast.backtest", description=__doc__.split("\n\n")[0])
    p.add_argument("--hall", default="hall-main")
    p.add_argument("--start", required=True)
    p.add_argument("--end", required=True)
    p.add_argument("--no-gbm", action="store_true")
    p.add_argument("--write", action="store_true", help="store the table in forecast_model_comparison")
    a = p.parse_args(argv)
    db = Supabase.from_env()
    data = load_hall(db, a.hall)
    result = compare(data, date.fromisoformat(a.start), date.fromisoformat(a.end), include_gbm=not a.no_gbm)
    OUT.mkdir(exist_ok=True)
    name = f"model_comparison{'_SIMULATED' if result['simulated'] else ''}_{a.hall}_{a.start}_{a.end}.json"
    (OUT / name).write_text(json.dumps(result, indent=1, default=str))
    print(table(result))
    for n in result["notes"]:
        print(f"note: {n}")
    print(f"→ forecast/out/{name}")
    if a.write:
        print(f"stored as run {write(db, result)} in forecast_model_comparison")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
