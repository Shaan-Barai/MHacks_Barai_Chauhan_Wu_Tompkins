"""Baseline forecast + newsvendor prep buffer: pure functions, no I/O.

Vocabulary (all weights in pounds):
  consumed  = prepped - pan leftover: what left the pan. When the dish RAN OUT,
              true demand was higher, so consumed is only a LOWER BOUND
              ("censored"); it is never treated as true demand.
  demand    = what diners would take if there were enough: the forecast target.
  eaten     = demand x (1 - tray waste share): what was actually eaten.
  prep      = the q-th percentile of demand, q = Cu / (Cu + Co) (newsvendor),
              Cu = cost of running out per lb, Co = cost of one wasted lb.

Model "baseline-v1":
  1. Same dish, same cycle day (6-week menu cycle), same meal, one cycle ago.
  2. Else the dish's recent average for that weekday and meal.
  3. Else the dish's recent average for that meal on any weekday.
  4. Else the hall's average per-dish demand for that weekday and meal.
  The baseline is then scaled by expected diners / diners at the baseline meal
  (so a busier day gets more food), and the buffer comes from the spread of
  this same model's recent walk-forward errors.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, timedelta
from statistics import NormalDist, fmean

MODEL_VERSION = "baseline-v1"
LB_PER_KG = 2.2046226218
RECENT_N = 4
MIN_ERRORS_FOR_EMPIRICAL = 5
DEFAULT_CV = 0.25
LOW_Q, HIGH_Q = 0.10, 0.90


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def cycle_position(day: date, cycle_start: date, weeks: int = 6) -> tuple[int, int]:
    """(cycle week 1..weeks, ISO weekday 1..7) of a date, given the Monday of week 1."""
    if cycle_start.isoweekday() != 1:
        raise ValueError("cycle_start must be a Monday")
    week = ((day - cycle_start).days // 7) % weeks + 1
    return week, day.isoweekday()


def consumed(prepped_lb: float | None, leftover_lb: float | None, ran_out: bool) -> tuple[float | None, bool]:
    """(pounds that left the pan, is_lower_bound). A ran-out meal is censored: 'at least this much'."""
    if prepped_lb is None:
        return None, ran_out
    left = 0.0 if leftover_lb is None and ran_out else leftover_lb
    if left is None:
        return None, ran_out
    return max(0.0, prepped_lb - left), ran_out


def newsvendor_q(cost_under: float, cost_over: float) -> float:
    """Critical ratio q = Cu / (Cu + Co): how often prep should cover demand."""
    if cost_under <= 0 or cost_over <= 0 or not math.isfinite(cost_under + cost_over):
        raise ValueError("costs must be finite and positive")
    return cost_under / (cost_under + cost_over)


def quantile(values: list[float], q: float) -> float:
    """Linear-interpolated q-quantile (the usual 'type 7'); q in [0, 1]."""
    if not values:
        raise ValueError("no values")
    if not 0.0 <= q <= 1.0:
        raise ValueError("q must be in [0, 1]")
    s = sorted(values)
    pos = q * (len(s) - 1)
    lo = math.floor(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def waste_adjusted(demand_lb: float, tray_waste_share: float) -> float:
    """Expected eaten lb = demand x (1 - tray waste share). Share is clamped to [0, 0.95]."""
    share = min(0.95, max(0.0, tray_waste_share))
    return demand_lb * (1.0 - share)


def cost_of_waste_per_lb(food_cost_usd_per_lb: float, impact_score_usd_per_kg: float | None) -> float:
    """Co: what one wasted pound costs = food cost + Waste Impact Score (USD/kg -> USD/lb)."""
    impact = (impact_score_usd_per_kg or 0.0) / LB_PER_KG
    return food_cost_usd_per_lb + impact


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Observation:
    """One dish at one past meal (from confirmed production_log rows)."""

    service_date: date
    meal: str
    dish_id: str
    prepped_lb: float | None
    leftover_lb: float | None
    ran_out: bool
    diners: float | None = None  # attendance for that meal (sum of swipes)
    is_simulated: bool = False

    @property
    def consumed_lb(self) -> float | None:
        return consumed(self.prepped_lb, self.leftover_lb, self.ran_out)[0]

    @property
    def censored(self) -> bool:
        return self.ran_out


@dataclass(frozen=True)
class Baseline:
    lb: float
    basis: str  # last_cycle | last_cycle_ran_out | dish_weekday_meal_avg | dish_meal_avg | hall_weekday_meal_avg
    source_date: date | None
    diners_then: float | None
    lower_bound: bool = False


def _usable(o: Observation) -> bool:
    return o.consumed_lb is not None


def _avg(obs: list[Observation]) -> tuple[float, float | None] | None:
    vals = [o.consumed_lb for o in obs if _usable(o)]
    if not vals:
        return None
    diners = [o.diners for o in obs if o.diners]
    return fmean(vals), (fmean(diners) if diners else None)


def baseline(
    history: list[Observation],
    target: date,
    meal: str,
    dish_id: str,
    cycle_start: date | None,
    weeks: int = 6,
) -> Baseline | None:
    """Baseline demand lb for a dish at a future meal, using only history before `target`."""
    past = sorted((o for o in history if o.service_date < target and o.meal == meal and _usable(o)), key=lambda o: o.service_date)
    mine = [o for o in past if o.dish_id == dish_id]
    same_weekday = [o for o in mine if o.service_date.isoweekday() == target.isoweekday()][-RECENT_N:]
    weekday_avg = _avg(same_weekday)

    # 1. Same cycle day, one cycle ago (or the most recent same cycle day).
    if cycle_start is not None:
        pos = cycle_position(target, cycle_start, weeks)
        same_day = [o for o in mine if cycle_position(o.service_date, cycle_start, weeks) == pos]
        exact = [o for o in same_day if o.service_date == target - timedelta(days=7 * weeks)]
        last = (exact or same_day[-1:] or [None])[-1]
        if last is not None:
            lb = last.consumed_lb or 0.0
            if last.censored:
                # Ran out: demand was at least `lb`. Use the larger of that and the recent average.
                if weekday_avg and weekday_avg[0] > lb:
                    lb = weekday_avg[0]
                return Baseline(lb, "last_cycle_ran_out", last.service_date, last.diners, lower_bound=True)
            return Baseline(lb, "last_cycle", last.service_date, last.diners)

    # 2. Recent average for that weekday and meal.
    if weekday_avg:
        return Baseline(weekday_avg[0], "dish_weekday_meal_avg", same_weekday[-1].service_date, weekday_avg[1])
    # 3. Recent average for that meal, any weekday.
    meal_avg = _avg(mine[-RECENT_N:])
    if meal_avg:
        return Baseline(meal_avg[0], "dish_meal_avg", mine[-1].service_date, meal_avg[1])
    # 4. The hall's average per-dish demand for that weekday and meal.
    hall_same = [o for o in past if o.service_date.isoweekday() == target.isoweekday()][-RECENT_N * 8 :]
    hall_avg = _avg(hall_same)
    if hall_avg:
        return Baseline(hall_avg[0], "hall_weekday_meal_avg", None, hall_avg[1])
    return None


def expected_diners(attendance: dict[tuple[date, str], float], target: date, meal: str) -> float | None:
    """Mean diners at the same weekday and meal over the last 4 weeks of attendance."""
    days = sorted(((d, n) for (d, m), n in attendance.items() if m == meal and d < target and d.isoweekday() == target.isoweekday()))
    vals = [n for _, n in days[-RECENT_N:]]
    return fmean(vals) if vals else None


def scaled_demand(b: Baseline, diners_expected: float | None) -> tuple[float, float]:
    """(demand lb, attendance scale factor). Scales the baseline by expected / baseline-meal diners."""
    if diners_expected and b.diners_then and b.diners_then > 0:
        scale = diners_expected / b.diners_then
        return b.lb * scale, scale
    return b.lb, 1.0


# ---------------------------------------------------------------------------
# Forecast
# ---------------------------------------------------------------------------


@dataclass
class Forecast:
    service_date: date
    meal: str
    dish_id: str
    expected_diners: float | None
    take_rate: float | None
    demand_lb: float
    expected_eaten_lb: float
    recommended_prep_lb: float
    low_lb: float
    high_lb: float
    q: float
    basis: str
    error_count: int
    tray_waste_share: float
    tray_waste_source: str  # 'calibrated_scans' | 'none'
    why: str
    lower_bound_basis: bool = False
    is_simulated: bool = False
    notes: list[str] = field(default_factory=list)


def relative_errors(
    history: list[Observation],
    before: date,
    meal: str,
    dishes: set[str] | None,
    cycle_start: date | None,
    weeks: int,
    attendance: dict[tuple[date, str], float],
    window_days: int = 42,
) -> list[float]:
    """Walk-forward errors of this model over the last `window_days`: actual / forecast - 1.

    Censored (ran-out) meals: the actual is a lower bound. If it is already above
    the forecast, the error is at least that big, so it is kept (conservative);
    if it is below, the true error is unknown, so it is left out.
    """
    out: list[float] = []
    for o in history:
        if not (before - timedelta(days=window_days) <= o.service_date < before) or o.meal != meal or not _usable(o):
            continue
        if dishes is not None and o.dish_id not in dishes:
            continue
        b = baseline(history, o.service_date, meal, o.dish_id, cycle_start, weeks)
        if b is None or b.lb <= 0:
            continue
        fc, _ = scaled_demand(b, attendance.get((o.service_date, meal)) or expected_diners(attendance, o.service_date, meal))
        if fc <= 0:
            continue
        actual = o.consumed_lb or 0.0
        if o.censored and actual < fc:
            continue
        out.append(actual / fc - 1.0)
    return out


def prep_from_errors(demand_lb: float, errors: list[float], q: float) -> tuple[float, float, float, str]:
    """(recommended prep, low, high, method) from the error spread around the demand forecast."""
    if len(errors) >= MIN_ERRORS_FOR_EMPIRICAL:
        up = quantile(errors, q)
        lo = quantile(errors, LOW_Q)
        hi = quantile(errors, HIGH_Q)
        method = f"empirical ({len(errors)} recent errors)"
    else:
        z = NormalDist()
        up, lo, hi = DEFAULT_CV * z.inv_cdf(q), DEFAULT_CV * z.inv_cdf(LOW_Q), DEFAULT_CV * z.inv_cdf(HIGH_Q)
        method = f"default spread (only {len(errors)} recent errors)"
    clamp = lambda x: max(0.0, round(demand_lb * (1.0 + x), 2))  # noqa: E731
    return clamp(up), clamp(lo), clamp(hi), method


def make_forecast(
    *,
    history: list[Observation],
    attendance: dict[tuple[date, str], float],
    target: date,
    meal: str,
    dish_id: str,
    dish_name: str,
    portion_lb: float | None,
    cycle_start: date | None,
    weeks: int,
    cost_under: float,
    cost_over: float,
    tray_waste_share: float | None,
    errors: list[float],
) -> Forecast | None:
    b = baseline(history, target, meal, dish_id, cycle_start, weeks)
    if b is None:
        return None
    diners = expected_diners(attendance, target, meal)
    demand, scale = scaled_demand(b, diners)
    q = newsvendor_q(cost_under, cost_over)
    prep, low, high, method = prep_from_errors(demand, errors, q)
    share = tray_waste_share if tray_waste_share is not None else 0.0
    eaten = waste_adjusted(demand, share)
    take = demand / (portion_lb * diners) if portion_lb and diners else None
    basis_text = {
        "last_cycle": f"same cycle day last cycle ({b.source_date})",
        "last_cycle_ran_out": f"same cycle day last cycle ({b.source_date}), which RAN OUT, so demand was at least that",
        "dish_weekday_meal_avg": "its recent average for this weekday and meal",
        "dish_meal_avg": "its recent average for this meal",
        "hall_weekday_meal_avg": "the hall's average dish for this weekday and meal (no history for this dish)",
    }[b.basis]
    parts = [f"{dish_name}: {demand:.1f} lb expected from {basis_text}"]
    if abs(scale - 1.0) >= 0.03:
        parts.append(f"x{scale:.2f} for {diners:.0f} expected diners")
    parts.append(f"prep covers demand {round(q * 100)}% of the time ({method})")
    if share > 0:
        parts.append(f"{share * 100:.0f}% tray waste from calibrated scans")
    return Forecast(
        service_date=target,
        meal=meal,
        dish_id=dish_id,
        expected_diners=round(diners) if diners else None,
        take_rate=min(1.0, round(take, 4)) if take is not None else None,
        demand_lb=round(demand, 2),
        expected_eaten_lb=round(eaten, 2),
        recommended_prep_lb=prep,
        low_lb=min(low, prep),
        high_lb=max(high, prep),
        q=q,
        basis=b.basis,
        error_count=len(errors),
        tray_waste_share=share,
        tray_waste_source="calibrated_scans" if tray_waste_share else "none",
        why="; ".join(parts) + ".",
        lower_bound_basis=b.lower_bound,
    )


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Outcome:
    forecast_lb: float | None  # recommended prep (ours) or FSS forecast
    consumed_lb: float
    censored: bool
    leftover_lb: float | None


def wape(pairs: list[tuple[float, float]]) -> float | None:
    """Weighted absolute % error: sum |forecast - actual| / sum actual (None without actuals)."""
    total = sum(a for _, a in pairs)
    if total <= 0:
        return None
    return sum(abs(f - a) for f, a in pairs) / total


def evaluate(outcomes: list[Outcome]) -> dict[str, float | int | None]:
    """WAPE (uncensored meals only: a ran-out meal's true demand is unknown), stockouts, leftovers.

    Stockouts count meals where that prep amount would not have been enough:
    below what was consumed, or, for a ran-out meal (true demand >= consumed),
    at or below what was consumed. So when the kitchen prepped exactly this
    amount and ran out, it counts. Leftover = max(0, forecast - consumed) on
    uncensored meals, i.e. what this forecast would have left in the pan.
    """
    scored = [o for o in outcomes if o.forecast_lb is not None]
    pairs = [(o.forecast_lb, o.consumed_lb) for o in scored if not o.censored]
    stockouts = sum(
        1
        for o in scored
        if (o.censored and o.forecast_lb <= o.consumed_lb + 1e-9) or (not o.censored and o.forecast_lb < o.consumed_lb - 1e-9)
    )
    leftover = sum(max(0.0, o.forecast_lb - o.consumed_lb) for o in scored if not o.censored)
    return {
        "meals": len(scored),
        "censored_meals": sum(1 for o in scored if o.censored),
        "wape": wape(pairs),
        "stockouts": stockouts,
        "leftover_lb": round(leftover, 2),
    }
