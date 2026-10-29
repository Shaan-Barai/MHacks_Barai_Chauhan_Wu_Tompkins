"""Load the forecast inputs from Supabase: confirmed production history, swipes,
dishes, the menu cycle, and (when the scans allow it) tray-waste shares.

Only CONFIRMED production_log rows are history: unconfirmed sheet readings
never feed a forecast.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime
from statistics import median

from .config import Settings, load_settings, weight_g_per_cm2
from .db import Supabase
from .model import Observation

# Tray waste from scans is only used when scans cover most plates: scaling a
# small sample up to the whole meal would be an extrapolation (AGENTS.md §7).
MIN_SCAN_COVERAGE = 0.8


@dataclass(frozen=True)
class Dish:
    dish_id: str
    display_name: str
    service_style: str
    portion_lb: float | None
    food_cost_usd_per_lb: float | None
    impact_food_name: str | None
    is_simulated: bool


@dataclass
class HallData:
    hall_id: str
    timezone: str
    cycle_start: date | None
    cycle_weeks: int
    dishes: dict[str, Dish]
    history: list[Observation]
    attendance: dict[tuple[date, str], float]
    attendance_simulated: bool
    menu_cycle: dict[tuple[int, int, str], list[str]]  # (week, weekday, meal) -> dish ids
    menu_cycle_simulated: bool
    fss: dict[tuple[date, str, str], float]  # (date, meal, dish) -> FSS forecast lb
    fss_simulated: bool  # the FSS rows are the simulator's stand-in, not a real FSS export
    tray_waste_share: dict[str, float]  # dish -> share (only with enough scan coverage)
    context: dict[date, set[str]]  # day -> context flags set (exam_week, home_game, is_holiday)
    notes: list[str]
    # Weather FORECAST as known before the day's first service (context_day.fc_*): what backtests may use.
    weather_forecast: dict[date, dict] = field(default_factory=dict)
    # Observed weather (context_day temp_high_f/precip_in on observed days). A model may never read it
    # for the day it forecasts; PastView strips it from that day on.
    weather_observed: dict[date, dict] = field(default_factory=dict)


def _f(v) -> float | None:
    return float(v) if v is not None else None


def _d(s: str) -> date:
    return date.fromisoformat(s[:10])


def load_hall(db: Supabase, hall_id: str, settings: Settings | None = None) -> HallData:
    s = settings or load_settings()
    notes: list[str] = []
    hall_rows = db.select("hall", {"hall_id": f"eq.{hall_id}"})
    hall = hall_rows[0] if hall_rows else {}
    cycle_start = _d(hall["menu_cycle_start"]) if hall.get("menu_cycle_start") else None
    if cycle_start is None:
        notes.append("hall has no menu_cycle_start: same-cycle-day baselines are off; weekday averages are used")

    dishes = {
        r["dish_id"]: Dish(
            r["dish_id"], r["display_name"], r["service_style"],
            float(r["portion_lb"]) if r.get("portion_lb") is not None else None,
            float(r["food_cost_usd_per_lb"]) if r.get("food_cost_usd_per_lb") is not None else None,
            r.get("impact_food_name"), bool(r.get("is_simulated")),
        )
        for r in db.select("dish")
    }

    attendance: dict[tuple[date, str], float] = defaultdict(float)
    att_rows = db.select("attendance", {"hall_id": f"eq.{hall_id}"}, "service_date,meal_label,swipe_count,is_simulated")
    for r in att_rows:
        attendance[(_d(r["service_date"]), r["meal_label"])] += r["swipe_count"]

    history: list[Observation] = []
    prod = db.select(
        "production_log",
        {"hall_id": f"eq.{hall_id}", "status": "eq.confirmed"},
        "service_date,meal_label,dish_id,prepped_lb,pan_leftover_lb,ran_out_at,is_simulated",
    )
    for r in prod:
        if not r.get("dish_id") or not r.get("service_date"):
            continue
        day = _d(r["service_date"])
        history.append(
            Observation(
                service_date=day,
                meal=r["meal_label"],
                dish_id=r["dish_id"],
                prepped_lb=float(r["prepped_lb"]) if r.get("prepped_lb") is not None else None,
                leftover_lb=float(r["pan_leftover_lb"]) if r.get("pan_leftover_lb") is not None else None,
                ran_out=r.get("ran_out_at") is not None,
                diners=attendance.get((day, r["meal_label"])) or None,
                is_simulated=bool(r.get("is_simulated")),
            )
        )

    menu_cycle: dict[tuple[int, int, str], list[str]] = defaultdict(list)
    mc_rows = db.select("menu_cycle", {"hall_id": f"eq.{hall_id}"}, "cycle_week,weekday,meal_label,dish_id,is_simulated")
    for r in mc_rows:
        menu_cycle[(r["cycle_week"], r["weekday"], r["meal_label"])].append(r["dish_id"])

    fss: dict[tuple[date, str, str], float] = {}
    fss_rows = db.select("forecast", {"hall_id": f"eq.{hall_id}", "model_version": "eq.fss"}, "service_date,meal_label,dish_id,fss_forecast_lb,is_simulated")
    for r in fss_rows:
        if r.get("fss_forecast_lb") is not None:
            fss[(_d(r["service_date"]), r["meal_label"], r["dish_id"])] = float(r["fss_forecast_lb"])

    share = tray_waste_shares(db, hall_id, dishes, history, attendance, s, notes)
    context: dict[date, set[str]] = {}
    weather_forecast: dict[date, dict] = {}
    weather_observed: dict[date, dict] = {}
    for r in db.select("context_day", {"hall_id": f"eq.{hall_id}"},
                       "service_date,exam_week,home_game,is_holiday,temp_high_f,precip_in,weather_kind,"
                       "fc_temp_high_f,fc_precip_in,fc_lead_hours,fc_source,is_simulated"):
        day = _d(r["service_date"])
        flags = {f for f in ("exam_week", "home_game", "is_holiday") if r.get(f)}
        if flags:
            context[day] = flags
        if r.get("fc_temp_high_f") is not None or r.get("fc_precip_in") is not None:
            weather_forecast[day] = {
                "temp_high_f": _f(r.get("fc_temp_high_f")), "precip_in": _f(r.get("fc_precip_in")),
                "lead_hours": r.get("fc_lead_hours"), "source": r.get("fc_source"),
            }
        # weather_kind 'forecast' marks upcoming days whose observed columns hold the latest forecast.
        if r.get("weather_kind") != "forecast" and (r.get("temp_high_f") is not None or r.get("precip_in") is not None):
            weather_observed[day] = {"temp_high_f": _f(r.get("temp_high_f")), "precip_in": _f(r.get("precip_in")),
                                     "simulated": bool(r.get("is_simulated"))}
    return HallData(
        hall_id=hall_id,
        timezone=hall.get("timezone") or s.default_timezone,
        cycle_start=cycle_start,
        cycle_weeks=int(hall.get("menu_cycle_weeks") or 6),
        dishes=dishes,
        history=history,
        attendance=dict(attendance),
        attendance_simulated=any(r.get("is_simulated") for r in att_rows),
        menu_cycle=dict(menu_cycle),
        menu_cycle_simulated=any(r.get("is_simulated") for r in mc_rows),
        fss=fss,
        fss_simulated=any(r.get("is_simulated") for r in fss_rows),
        tray_waste_share=share,
        context=context,
        notes=notes,
        weather_forecast=weather_forecast,
        weather_observed=weather_observed,
    )


def tray_waste_shares(
    db: Supabase,
    hall_id: str,
    dishes: dict[str, Dish],
    history: list[Observation],
    attendance: dict[tuple[date, str], float],
    settings: Settings,
    notes: list[str],
) -> dict[str, float]:
    """dish -> median share of consumed lb left on trays, from CALIBRATED scans only.

    Grams come from the scan's calibrated area (food_measurement.physical.areaCm2),
    or for plate-scaled scans (plate-scale-v1) from pixels x (assumed plate cm /
    plate px)^2, times the dish's weight_g_per_cm2 from the factors table, so they
    are estimates (see tray_grams). A meal counts only when scans cover >= 80% of
    its diners.
    """
    rows = db.select(
        "food_measurement",
        {"physical": "not.is.null", "capture_event.hall_id": f"eq.{hall_id}"},
        "item_id,physical,capture_event!inner(event_id,hall_id,meal_service!inner(service_date,meal_label))",
    )
    plate_rows, plate_measurements = _plate_scale_rows(db, hall_id)
    if not rows and not plate_rows:
        notes.append("tray waste share = 0: no calibrated or plate-scaled scans (scan pixels are not converted to pounds without one)")
        return {}
    item_dish = {r["item_id"]: r["dish_id"] for r in db.select("menu_item", {"dish_id": "not.is.null"}, "item_id,dish_id")}
    g_per_cm2 = weight_g_per_cm2(tuple(settings.factor_files))
    grams, plates = tray_grams(rows, plate_rows, plate_measurements, item_dish, dishes, g_per_cm2)
    if plate_rows:
        notes.append(f"tray waste uses ESTIMATED grams from {len(plate_rows)} plate-scaled scan(s) (plate-scale-v1: assumed plate diameter, see docs)")
    consumed = {(o.service_date, o.meal, o.dish_id): o.consumed_lb for o in history if not o.censored and o.consumed_lb}
    by_dish: dict[str, list[float]] = defaultdict(list)
    skipped = 0
    for (day, meal, dish_id), g in grams.items():
        diners = attendance.get((day, meal))
        if not diners or len(plates[(day, meal)]) / diners < MIN_SCAN_COVERAGE:
            skipped += 1
            continue
        c = consumed.get((day, meal, dish_id))
        if c:
            by_dish[dish_id].append(min(0.95, g / 453.59237 / c))
    if skipped:
        notes.append(f"{skipped} dish-meal(s) skipped for tray waste: scans covered < {MIN_SCAN_COVERAGE:.0%} of diners")
    return {d: median(v) for d, v in by_dish.items() if v}


def _plate_scale_rows(db: Supabase, hall_id: str) -> tuple[list[dict], list[dict]]:
    """plate-scale-v1 records with a plate diameter for this hall's scans (latest per scan), and their measurements."""
    try:
        rows = db.select(
            "plate_scale_estimate",
            {"plate_diameter_px": "not.is.null", "capture_event.hall_id": f"eq.{hall_id}"},
            "attempt_id,event_id,plate_diameter_px,assumed_plate_diameter_cm,created_at,"
            "capture_event!inner(event_id,hall_id,meal_service!inner(service_date,meal_label))",
        )
    except Exception:  # noqa: BLE001 - table missing on an older database: no plate scale
        return [], []
    latest: dict[str, dict] = {}
    for r in rows:
        if r["event_id"] not in latest or r["created_at"] > latest[r["event_id"]]["created_at"]:
            latest[r["event_id"]] = r
    rows = list(latest.values())
    measurements: list[dict] = []
    ids = [r["attempt_id"] for r in rows]
    for i in range(0, len(ids), 100):
        measurements += db.select("food_measurement", {"attempt_id": f"in.({','.join(ids[i:i + 100])})", "method": "eq.mask_pixel_count"},
                                  "attempt_id,item_id,remaining_area_px,physical")
    return rows, measurements


def tray_grams(
    camera_rows: list[dict],
    plate_rows: list[dict],
    plate_measurements: list[dict],
    item_dish: dict[str, str],
    dishes: dict[str, Dish],
    g_per_cm2: dict[str, float],
) -> tuple[dict[tuple[date, str, str], float], dict[tuple[date, str], set[str]]]:
    """ESTIMATED tray grams per (day, meal, dish) and the scans behind each meal.

    Camera-calibrated measurements: grams = physical.areaCm2 x weight_g_per_cm2.
    Plate-scaled scans (plate-scale-v1, only measurements without a camera
    calibration): grams = pixels x (assumed plate cm / plate px)^2 x weight_g_per_cm2.
    """
    grams: dict[tuple[date, str, str], float] = defaultdict(float)
    plates: dict[tuple[date, str], set[str]] = defaultdict(set)

    def w_for(item_id):
        dish = dishes.get(item_dish.get(item_id or "", ""))
        w = g_per_cm2.get(" ".join((dish.impact_food_name or "").lower().split())) if dish else None
        return dish, w

    for r in camera_rows:
        svc = r["capture_event"]["meal_service"]
        key = (_d(svc["service_date"]), svc["meal_label"])
        plates[key].add(r["capture_event"]["event_id"])
        dish, w = w_for(r.get("item_id"))
        area = (r.get("physical") or {}).get("areaCm2")
        if dish and area is not None and w:
            grams[(key[0], key[1], dish.dish_id)] += float(area) * w
    by_attempt: dict[str, list[dict]] = defaultdict(list)
    for m in plate_measurements:
        by_attempt[m["attempt_id"]].append(m)
    for p in plate_rows:
        svc = p["capture_event"]["meal_service"]
        key = (_d(svc["service_date"]), svc["meal_label"])
        k = (float(p["assumed_plate_diameter_cm"]) / float(p["plate_diameter_px"])) ** 2
        plates[key].add(p["event_id"])
        for m in by_attempt.get(p["attempt_id"], []):
            if m.get("physical"):
                continue  # already counted above from the camera calibration
            dish, w = w_for(m.get("item_id"))
            if dish and w:
                grams[(key[0], key[1], dish.dish_id)] += float(m["remaining_area_px"]) * k * w
    return grams, plates


def dishes_for(data: HallData, day: date, meal: str) -> list[str]:
    """The dishes served at a meal: the menu cycle when there is one, else what was served
    the same weekday and meal most recently."""
    if data.cycle_start is not None and data.menu_cycle:
        from .model import cycle_position

        week, weekday = cycle_position(day, data.cycle_start, data.cycle_weeks)
        if (week, weekday, meal) in data.menu_cycle:
            return sorted(set(data.menu_cycle[(week, weekday, meal)]))
    past = [o for o in data.history if o.meal == meal and o.service_date < day and o.service_date.isoweekday() == day.isoweekday()]
    if not past:
        return []
    last = max(o.service_date for o in past)
    return sorted({o.dish_id for o in past if o.service_date == last})


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))
