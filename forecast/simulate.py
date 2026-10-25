"""ONE clearly labeled SIMULATED dataset to exercise the forecast pipeline end to end.

No real production data exists yet. This writes 6+ weeks of made-up history
for one hall (2 meals a day, 15 dishes from the factors table) and marks EVERY
row it creates `is_simulated = true`. Nothing here is a fact about any dining
hall; it only lets the worker, evaluation, prep sheets and dashboard run.

    python -m forecast.simulate generate --hall hall-main [--weeks 6] [--end 2026-10-24] [--seed sim-v1]
    python -m forecast.simulate remove   --hall hall-main     # deletes ONLY is_simulated rows

generate is re-runnable: it first removes the hall's simulated rows, then
writes a fresh set (the same seed gives the same data).

What the simulation assumes (all invented, documented so nobody mistakes it):
  * Diners per meal: lunch ~700, dinner ~900, within ATTENDANCE_MIN..MAX (.env),
    -30% on weekends, -15% Friday dinner, -50% on one simulated holiday,
    -20% at dinner on simulated home-game Saturdays, +8% in the simulated
    exam week; swipes spread over 15-minute intervals with a midday peak.
  * True demand = diners x take rate x portion lb x random noise (sd ~18%).
  * The kitchen preps what a simulated "FSS" forecast says: the average demand
    x 1.25 x noise (it over-preps and ignores attendance swings).
  * Ran out when demand > prepped (time scaled within the meal); leftover =
    prepped - demand otherwise. Tray waste is a fixed 4-14% of eaten food per dish.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from .config import load_settings
from .db import Supabase, load_env

SIM_PREFIX = "sim-"
GENERATOR = "forecast-sim-v1"

# (food name in factors/menu_waste_factors_EastQuad.csv, station, service style, portion lb, take rate)
DISHES = [
    ("Baked Boneless Ham", "Signature Maize", "entree", 0.38, 0.22),
    ("Ancho Flank Steak", "Halal", "entree", 0.40, 0.24),
    ("Vegetable Cannelloni", "24 Carrots", "entree", 0.45, 0.12),
    ("Michigan Farmers 4 Bean Stew", "24 Carrots", "entree", 0.50, 0.10),
    ("Pepperoni Pizza", "Pizziti", "entree", 0.33, 0.30),
    ("Cheese Pizza", "Pizziti", "entree", 0.31, 0.20),
    ("Oven Roasted Garlic Potatoes", "Signature Maize", "side", 0.30, 0.28),
    ("Baked Sweet Potatoes", "Signature Maize", "side", 0.30, 0.14),
    ("Roasted Cauliflower", "Signature Maize", "side", 0.22, 0.12),
    ("Sticky Rice", "Halal", "side", 0.35, 0.30),
    ("Halal Rice", "Halal", "side", 0.35, 0.25),
    ("Farro", "24 Carrots", "side", 0.25, 0.08),
    ("Vegetable Stir Fry Blend", "Halal", "side", 0.25, 0.16),
    ("Broccoli Cheddar Soup", "Soup", "self_serve", 0.50, 0.15),
    ("Lettuce", "Salad Bar", "self_serve", 0.10, 0.35),
]
MEALS = ("lunch", "dinner")
BASE_DINERS = {"lunch": 700, "dinner": 900}


def dish_id(name: str) -> str:
    return SIM_PREFIX + "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-").replace("--", "-")


def _hash01(*parts: object) -> float:
    h = hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


def simulated_tray_waste_lb(dish: str, day: date, meal: str, eaten_lb: float) -> float:
    """SIMULATED tray waste: a fixed 4-14% of eaten food per dish (labeled 'simulated' wherever used)."""
    share = 0.04 + 0.10 * _hash01("tray", dish)
    return round(max(0.0, eaten_lb) * share, 2)


def _menu(week: int, weekday: int, meal: str) -> list[str]:
    entrees = [d for d in DISHES if d[2] == "entree"]
    sides = [d for d in DISHES if d[2] == "side"]
    selfserve = [d for d in DISHES if d[2] == "self_serve"]
    k = (week - 1) * 7 + (weekday - 1) + (0 if meal == "lunch" else 3)
    chosen = [entrees[k % 6], entrees[(k + 3) % 6], sides[k % 7], sides[(k + 4) % 7], *selfserve]
    return [dish_id(d[0]) for d in chosen]


def _intervals(meal: str, total: int, rng: random.Random, settings) -> list[tuple[time, int]]:
    start_s, end_s = settings.meals[meal]
    start = datetime.strptime(start_s, "%H:%M")
    end = datetime.strptime(end_s, "%H:%M")
    slots = []
    t = start
    while t < end:
        slots.append(t.time())
        t += timedelta(minutes=15)
    n = len(slots)
    weights = [1.0 - abs((i + 0.5) / n - 0.45) * 1.6 + rng.uniform(-0.05, 0.05) for i in range(n)]
    weights = [max(0.05, w) for w in weights]
    raw = [total * w / sum(weights) for w in weights]
    counts = [int(x) for x in raw]
    for i in sorted(range(n), key=lambda i: raw[i] - counts[i], reverse=True)[: total - sum(counts)]:
        counts[i] += 1
    return list(zip(slots, counts))


def remove(db: Supabase, hall_id: str) -> dict[str, int]:
    """Delete ONLY rows marked is_simulated (for this hall), plus simulated dishes no real row uses."""
    removed: dict[str, int] = {}
    for table in ("forecast_outcome", "forecast", "production_log", "attendance", "context_day", "menu_cycle"):
        removed[table] = db.delete(table, {"hall_id": f"eq.{hall_id}", "is_simulated": "eq.true"})
    still_used = {r["dish_id"] for t in ("production_log", "forecast", "menu_cycle", "forecast_outcome") for r in db.select(t, {"dish_id": f"like.{SIM_PREFIX}*"}, "dish_id")}
    sim_dishes = [r["dish_id"] for r in db.select("dish", {"is_simulated": "eq.true"}, "dish_id")]
    removed["dish"] = 0
    for d in sim_dishes:
        if d not in still_used:
            removed["dish"] += db.delete("dish", {"dish_id": f"eq.{d}", "is_simulated": "eq.true"})
    # The cycle anchor was set by generate only when the hall had none; drop it if no real cycle remains.
    if not db.select("menu_cycle", {"hall_id": f"eq.{hall_id}"}, "menu_cycle_id"):
        hall = db.select("hall", {"hall_id": f"eq.{hall_id}"}, "menu_cycle_start")
        if hall and hall[0].get("menu_cycle_start"):
            db.update("hall", {"hall_id": f"eq.{hall_id}"}, {"menu_cycle_start": None})
            removed["hall.menu_cycle_start"] = 1
    return removed


def generate(db: Supabase, hall_id: str, end: date, weeks: int = 6, seed: str = "sim-v1", future_days: int = 7) -> dict:
    if weeks < 6:
        raise ValueError("at least 6 weeks")
    load_env()
    lo = int(os.environ.get("ATTENDANCE_MIN") or 300)
    hi = int(os.environ.get("ATTENDANCE_MAX") or 1200)
    settings = load_settings()
    rng = random.Random(f"{seed}|{hall_id}")
    removed = remove(db, hall_id)

    hall = (db.select("hall", {"hall_id": f"eq.{hall_id}"}) or [{}])[0]
    tz = ZoneInfo(hall.get("timezone") or settings.default_timezone)
    start = end - timedelta(days=7 * weeks - 1)
    cycle_start = date.fromisoformat(hall["menu_cycle_start"]) if hall.get("menu_cycle_start") else start - timedelta(days=start.isoweekday() - 1)
    if not hall:
        db.insert("hall", [{"hall_id": hall_id, "timezone": settings.default_timezone}])
    if not hall.get("menu_cycle_start"):
        db.update("hall", {"hall_id": f"eq.{hall_id}"}, {"menu_cycle_start": cycle_start.isoformat(), "menu_cycle_weeks": 6})

    db.insert("dish", [
        {"dish_id": dish_id(n), "display_name": n, "category": station, "service_style": style, "portion_lb": portion,
         "impact_food_name": n, "is_simulated": True}
        for n, station, style, portion, _ in DISHES
    ], on_conflict="dish_id", upsert=True)
    info = {dish_id(d[0]): d for d in DISHES}

    cycle_rows = [
        {"hall_id": hall_id, "cycle_week": w, "weekday": wd, "meal_label": m, "dish_id": d, "station": info[d][1], "is_simulated": True}
        for w in range(1, 7) for wd in range(1, 8) for m in MEALS for d in _menu(w, wd, m)
    ]
    db.insert("menu_cycle", cycle_rows)

    d21 = start + timedelta(days=21)
    holiday = d21 + timedelta(days=(8 - d21.isoweekday()) % 7)  # the first Monday on or after day 21
    exam_start = end - timedelta(days=6)
    context, swipes, production, fss_rows = [], [], [], []
    expected = {}  # (dish, meal) -> long-run mean demand, what the simulated FSS knows
    for d, (_, _, _, portion, take) in info.items():
        for m in MEALS:
            # Week-average diners: 5 weekdays at 1.0 and 2 weekend days at 0.7.
            expected[(d, m)] = BASE_DINERS[m] * (5 + 2 * 0.7) / 7 * take * portion

    day = start
    while day <= end + timedelta(days=future_days):
        past = day <= end
        wd = day.isoweekday()
        home_game = wd == 6 and rng.random() < 0.5
        is_holiday = day == holiday
        exam = exam_start <= day <= end
        if past:
            context.append({
                "hall_id": hall_id, "service_date": day.isoformat(),
                "weather_summary": rng.choice(["sunny", "cloudy", "rain", "windy", "snow flurries"]),
                "temp_high_f": round(rng.uniform(38, 68), 1), "precip_in": round(max(0.0, rng.gauss(0.05, 0.12)), 2),
                "exam_week": exam, "home_game": home_game, "is_holiday": is_holiday,
                "holiday_name": "Fall Break (simulated)" if is_holiday else None,
                "events_note": "Simulated context day", "is_simulated": True,
            })
        week = ((day - cycle_start).days // 7) % 6 + 1
        for m in MEALS:
            factor = (0.7 if wd >= 6 else 1.0) * (0.85 if (wd == 5 and m == "dinner") else 1.0)
            factor *= 0.5 if is_holiday else 1.0
            factor *= 0.8 if (home_game and m == "dinner") else 1.0
            factor *= 1.08 if exam else 1.0
            diners = int(min(hi, max(lo, round(BASE_DINERS[m] * factor * rng.uniform(0.93, 1.07)))))
            if past:
                for slot, n in _intervals(m, diners, rng, settings):
                    start_utc = datetime.combine(day, slot, tz).astimezone(timezone.utc)
                    swipes.append({"hall_id": hall_id, "interval_start": start_utc.isoformat(), "service_date": day.isoformat(),
                                   "meal_label": m, "swipe_count": n, "source": "simulated", "is_simulated": True})
            for d in _menu(week, wd, m):
                name, station, style, portion, take = info[d]
                fss = round(expected[(d, m)] * 1.25 * math.exp(rng.gauss(0, 0.12)) * 2) / 2
                fss_rows.append({
                    "hall_id": hall_id, "service_date": day.isoformat(), "meal_label": m, "dish_id": d,
                    "recommended_prep_lb": fss, "fss_forecast_lb": fss, "model_version": "fss", "basis": "fss",
                    "why": "Simulated FSS (existing system) forecast.", "is_simulated": True,
                })
                if not past:
                    continue
                demand = diners * take * portion * math.exp(rng.gauss(0, 0.18))
                prepped = max(0.5, fss)
                ran_out = demand > prepped
                leftover = 0.0 if ran_out else round(prepped - demand, 2)
                ran_out_at = None
                if ran_out:
                    s_start, s_end = (datetime.combine(day, datetime.strptime(x, "%H:%M").time(), tz) for x in settings.meals[m])
                    ran_out_at = (s_start + (s_end - s_start) * min(0.97, prepped / demand)).astimezone(timezone.utc).isoformat()
                production.append({
                    "hall_id": hall_id, "service_date": day.isoformat(), "meal_label": m, "dish_id": d, "station": station,
                    "prepped_lb": prepped, "prepped_portions": round(prepped / portion), "pan_leftover_lb": leftover,
                    "ran_out_at": ran_out_at, "source": "demo", "status": "confirmed", "confirmed_by": "simulation",
                    "confirmed_at": datetime.now(timezone.utc).isoformat(), "is_simulated": True,
                })
        day += timedelta(days=1)

    db.insert("context_day", context)
    db.insert("attendance", swipes)
    db.insert("production_log", production)
    db.insert("forecast", fss_rows)
    return {
        "hallId": hall_id, "seed": seed, "generator": GENERATOR, "start": start.isoformat(), "end": end.isoformat(),
        "cycleStart": cycle_start.isoformat(), "removedFirst": removed,
        "written": {"dish": len(DISHES), "menu_cycle": len(cycle_rows), "context_day": len(context), "attendance": len(swipes),
                    "production_log": len(production), "forecast(fss)": len(fss_rows)},
        "ranOutMeals": sum(1 for p in production if p["ran_out_at"]),
        "label": "SIMULATED: every row has is_simulated = true",
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m forecast.simulate", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate")
    g.add_argument("--hall", default="hall-main")
    g.add_argument("--weeks", type=int, default=6)
    g.add_argument("--end", type=date.fromisoformat, default=None, help="last simulated day (default: yesterday)")
    g.add_argument("--seed", default=None, help="default: ATTENDANCE_SEED from .env, else sim-v1")
    r = sub.add_parser("remove")
    r.add_argument("--hall", default="hall-main")
    a = p.parse_args(argv)
    db = Supabase.from_env()
    if a.cmd == "remove":
        print(json.dumps({"removed": remove(db, a.hall), "label": "only is_simulated rows were deleted"}, indent=2))
        return 0
    load_env()
    seed = a.seed or os.environ.get("ATTENDANCE_SEED") or "sim-v1"
    end = a.end or (date.today() - timedelta(days=1))
    print(json.dumps(generate(db, a.hall, end, a.weeks, seed), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
