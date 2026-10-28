"""Demand models behind one interface, for the walk-forward comparison (forecast/backtest.py).

Every model sees only a `PastView`: the history, swipes and context strictly
BEFORE the target date (context for the target date itself is allowed: the
academic calendar, game schedule and holidays are published in advance). It
returns a point forecast of demand in pounds, or None when it has nothing to go
on. Prep amounts and the 10-90% range come from the model's own past errors in
the backtest (the same method for every model), so models differ only in the
point forecast.

Censoring: a meal that RAN OUT only tells us demand was at least what left the
pan. The new models leave those meals out of their inputs (baseline-v1 keeps
its own rule: a ran-out last cycle counts as "at least"), and the backtest
leaves them out of WAPE and bias.

model_version names:
  baseline-v1         the production model (model.py: cycle day, fallbacks, diner scaling)
  seasonal-naive-v1   the dish's last uncensored same weekday-meal (one week back when served then)
  moving-avg-4-v1     mean of the dish's last 4 uncensored same weekday-meals
  exp-smoothing-v1    simple exponential smoothing (alpha 0.3) over the dish's same-meal series
  gbm-v1              scikit-learn HistGradientBoostingRegressor on calendar, context and lag features
                      (optional dependency; retrained weekly on uncensored meals before the target)
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from statistics import fmean

from .model import Observation, baseline, expected_diners, scaled_demand

CONTEXT_KEYS = ("exam_week", "home_game", "is_holiday")


class LookAheadError(RuntimeError):
    """A model asked for data on or after the date it is forecasting."""


class PastView:
    """History, swipes and context known before `cutoff`. Asking for later data raises LookAheadError."""

    def __init__(self, history: list[Observation], attendance: dict[tuple[date, str], float],
                 context: dict[date, set[str]], cutoff: date, cycle_start: date | None = None, cycle_weeks: int = 6,
                 day_types: dict[date, int] | None = None):
        self.cutoff = cutoff
        self.history = [o for o in history if o.service_date < cutoff]
        self.attendance = {k: v for k, v in attendance.items() if k[0] < cutoff}
        self._context = {d: f for d, f in context.items() if d <= cutoff}
        self._day_types = {d: t for d, t in (day_types or {}).items() if d < cutoff}
        self.cycle_start = cycle_start
        self.cycle_weeks = cycle_weeks

    def context_on(self, day: date) -> set[str]:
        """Calendar flags: allowed up to and including the target date (published ahead), never later."""
        if day > self.cutoff:
            raise LookAheadError(f"context for {day} asked while forecasting {self.cutoff}")
        return self._context.get(day, set())

    def diners_on(self, day: date, meal: str) -> float | None:
        if day >= self.cutoff:
            raise LookAheadError(f"attendance for {day} asked while forecasting {self.cutoff}")
        return self.attendance.get((day, meal))

    def day_type(self, day: date) -> int | None:
        if day >= self.cutoff:
            raise LookAheadError(f"day type for {day} asked while forecasting {self.cutoff}")
        return self._day_types.get(day)

    def series(self, dish_id: str, meal: str, weekday: int | None = None) -> list[Observation]:
        """The dish's uncensored past meals with a known amount, oldest first."""
        return sorted(
            (o for o in self.history if o.dish_id == dish_id and o.meal == meal and not o.censored and o.consumed_lb is not None
             and (weekday is None or o.service_date.isoweekday() == weekday)),
            key=lambda o: o.service_date,
        )


@dataclass
class Model:
    version: str

    def fit(self, view: PastView) -> None:  # most models need no training
        return None

    def predict(self, view: PastView, target: date, meal: str, dish_id: str) -> float | None:
        raise NotImplementedError


class BaselineV1(Model):
    def __init__(self):
        super().__init__("baseline-v1")

    def predict(self, view, target, meal, dish_id):
        b = baseline(view.history, target, meal, dish_id, view.cycle_start, view.cycle_weeks)
        if b is None:
            return None
        demand, _ = scaled_demand(b, expected_diners(view.attendance, target, meal))
        return demand


class SeasonalNaive(Model):
    def __init__(self):
        super().__init__("seasonal-naive-v1")

    def predict(self, view, target, meal, dish_id):
        s = view.series(dish_id, meal, target.isoweekday())
        return s[-1].consumed_lb if s else None


class MovingAverage(Model):
    def __init__(self, n: int = 4):
        super().__init__(f"moving-avg-{n}-v1")
        self.n = n

    def predict(self, view, target, meal, dish_id):
        s = view.series(dish_id, meal, target.isoweekday())[-self.n:]
        return fmean(o.consumed_lb for o in s) if s else None


class ExpSmoothing(Model):
    def __init__(self, alpha: float = 0.3):
        super().__init__("exp-smoothing-v1")
        self.alpha = alpha

    def predict(self, view, target, meal, dish_id):
        s = view.series(dish_id, meal)
        if not s:
            return None
        level = s[0].consumed_lb
        for o in s[1:]:
            level = self.alpha * o.consumed_lb + (1 - self.alpha) * level
        return level


def gbm_features(view: PastView, target: date, meal: str, dish_id: str, dish_index: dict[str, int]) -> list[float]:
    """Features known before `target`: calendar, context for the day, lags of this dish, expected diners."""
    nan = float("nan")
    same = view.series(dish_id, meal, target.isoweekday())
    allm = view.series(dish_id, meal)
    ctx = view.context_on(target)
    diners = expected_diners(view.attendance, target, meal)
    last = allm[-1].service_date if allm else None
    feats = [
        float(target.isoweekday()),
        float({"breakfast": 0, "lunch": 1, "dinner": 2}[meal]),
        float(dish_index.get(dish_id, -1)),
        diners if diners is not None else nan,
        same[-1].consumed_lb if same else nan,
        fmean(o.consumed_lb for o in same[-4:]) if same else nan,
        fmean(o.consumed_lb for o in allm[-4:]) if allm else nan,
        float((target - last).days) if last else nan,
        *(1.0 if k in ctx else 0.0 for k in CONTEXT_KEYS),
    ]
    # Day type (optional clustering): the type of the same weekday last week, which is known by now.
    dt = view.day_type(target - timedelta(days=7)) if view._day_types else None
    feats.append(float(dt) if dt is not None else nan)
    return feats


class GradientBoosting(Model):
    """HistGradientBoostingRegressor (scikit-learn). Training rows are uncensored past meals, each with
    features computed from data before ITS own date, so training never sees the future either."""

    RETRAIN_DAYS = 7

    def __init__(self, dish_ids: list[str], random_state: int = 0):
        super().__init__("gbm-v1")
        import numpy as np  # optional dependency (with scikit-learn)
        from sklearn.ensemble import HistGradientBoostingRegressor

        self._np = np
        self._cls = HistGradientBoostingRegressor
        self.dish_index = {d: i for i, d in enumerate(sorted(dish_ids))}
        self.random_state = random_state
        self.model = None
        self.trained_on: date | None = None
        self._feature_cache: dict[tuple, list[float]] = {}
        self.full_history: list[Observation] | None = None
        self.full_attendance = None
        self.full_context = None

    def bind(self, history, attendance, context, cycle_start, cycle_weeks, day_types=None):
        """The backtest hands over the complete record once; every use goes through a PastView cut at a date."""
        self.full_history, self.full_attendance, self.full_context = history, attendance, context
        self._cycle = (cycle_start, cycle_weeks)
        self._day_types = day_types

    def _features_at(self, o: Observation) -> list[float]:
        key = (o.service_date, o.meal, o.dish_id)
        if key not in self._feature_cache:
            v = PastView(self.full_history, self.full_attendance, self.full_context, o.service_date, *self._cycle, day_types=self._day_types)
            self._feature_cache[key] = gbm_features(v, o.service_date, o.meal, o.dish_id, self.dish_index)
        return self._feature_cache[key]

    def fit(self, view: PastView) -> None:
        if self.trained_on is not None and (view.cutoff - self.trained_on).days < self.RETRAIN_DAYS:
            return
        rows = [o for o in view.history if not o.censored and o.consumed_lb is not None]
        if len(rows) < 30:
            self.model = None
            return
        X = [self._features_at(o) for o in rows]
        y = [o.consumed_lb for o in rows]
        np = self._np
        Xa = np.array(X, dtype=float)
        # Columns with fewer than 2 distinct known values carry no information (and trip the binner).
        self.keep = [j for j in range(Xa.shape[1]) if len(np.unique(Xa[~np.isnan(Xa[:, j]), j])) >= 2]
        cat = [self.keep.index(2)] if 2 in self.keep else None
        m = self._cls(max_iter=200, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=5,
                      categorical_features=cat, random_state=self.random_state)
        m.fit(Xa[:, self.keep], np.array(y, dtype=float))
        self.model = m
        self.trained_on = view.cutoff

    def predict(self, view, target, meal, dish_id):
        if self.model is None or not view.series(dish_id, meal):
            return None
        x = self._np.array([gbm_features(view, target, meal, dish_id, self.dish_index)], dtype=float)[:, self.keep]
        return max(0.0, float(self.model.predict(x)[0]))


def available_models(dish_ids: list[str], include_gbm: bool = True) -> tuple[list[Model], list[str]]:
    models: list[Model] = [BaselineV1(), SeasonalNaive(), MovingAverage(4), ExpSmoothing()]
    notes: list[str] = []
    if include_gbm:
        try:
            models.append(GradientBoosting(dish_ids))
        except ImportError:
            notes.append("gbm-v1 skipped: scikit-learn is not installed for this Python (use .venv/bin/python)")
    return models, notes
