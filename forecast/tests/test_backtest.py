"""Model comparison: no look-ahead, hand-checked models, censoring, metrics, and the two unsupervised helpers."""

import importlib.util
import unittest
from datetime import date, timedelta

from forecast.backtest import compare, run_models, score, spread
from forecast.config import load_settings
from forecast.data import Dish, HallData
from forecast.model import Observation
from forecast.models import (BaselineV1, ExpSmoothing, LookAheadError, MovingAverage, PastView, SeasonalNaive,
                             available_models, gbm_features)
from forecast.unsupervised import day_types, kmeans, robust_z_anomalies, without_anomalies

HAS_SKLEARN = importlib.util.find_spec("sklearn") is not None and importlib.util.find_spec("numpy") is not None
START = date(2026, 9, 7)  # a Monday


def synthetic(days=35, poison_from: date | None = None, ran_out_every=9) -> HallData:
    """Two dishes served every lunch; demand follows the weekday. SIMULATED, for tests only."""
    hist, att, ctx = [], {}, {}
    for i in range(days):
        d = START + timedelta(days=i)
        diners = 500 + 40 * d.isoweekday()
        att[(d, "lunch")] = diners
        for k, dish in enumerate(("a", "b")):
            demand = (20 + 3 * d.isoweekday() + 5 * k) * (1 + 0.05 * ((i * 7 + k) % 5 - 2))
            ran_out = i % ran_out_every == 4 and k == 0
            prepped = round(demand * (0.95 if ran_out else 1.15), 2)
            hist.append(Observation(d, "lunch", dish, prepped, 0.0 if ran_out else round(prepped - demand, 2), ran_out, diners, True))
        if d.isoweekday() == 6:
            ctx[d] = {"home_game"}
    if poison_from:
        for i in range(60):
            d = poison_from + timedelta(days=i)
            att[(d, "lunch")] = 10 ** 6
            ctx[d] = {"exam_week", "home_game", "is_holiday"}
            hist.extend(Observation(d, "lunch", dish, 10 ** 5, 0.0, False, 10 ** 6, True) for dish in ("a", "b"))
    dishes = {x: Dish(x, x.upper(), "entree", 0.3, 5.0, None, True) for x in ("a", "b")}
    return HallData("h", "America/Detroit", None, 6, dishes, hist, att, True, {}, False,
                    {(o.service_date, o.meal, o.dish_id): o.prepped_lb * 1.25 for o in hist}, True, {}, ctx, [])


class NoLookAhead(unittest.TestCase):
    def test_view_refuses_future_data(self):
        data = synthetic()
        v = PastView(data.history, data.attendance, data.context, START + timedelta(days=14))
        self.assertTrue(all(o.service_date < v.cutoff for o in v.history))
        with self.assertRaises(LookAheadError):
            v.diners_on(v.cutoff, "lunch")
        with self.assertRaises(LookAheadError):
            v.context_on(v.cutoff + timedelta(days=1))
        v.context_on(v.cutoff)  # the target day's calendar is published ahead: allowed

    def test_poisoned_future_changes_no_earlier_forecast(self):
        """Absurd rows from day 28 on must not move any forecast for days before 28: fails if any feature peeks."""
        poison = START + timedelta(days=28)
        s = load_settings()
        models_a, _ = available_models(["a", "b"], include_gbm=HAS_SKLEARN)
        models_b, _ = available_models(["a", "b"], include_gbm=HAS_SKLEARN)
        clean = run_models(synthetic(), poison - timedelta(days=1), s, models_a)
        dirty = run_models(synthetic(poison_from=poison), poison - timedelta(days=1), s, models_b)
        for m in clean:
            self.assertTrue(clean[m], m)
            self.assertEqual({k: round(p.demand, 9) for k, p in clean[m].items()},
                             {k: round(p.demand, 9) for k, p in dirty[m].items()}, f"{m} used future data")
            self.assertEqual({k: p.errors for k, p in clean[m].items()}, {k: p.errors for k, p in dirty[m].items()}, m)

    def test_gbm_features_ignore_future(self):
        poison = START + timedelta(days=28)
        a, b = synthetic(), synthetic(poison_from=poison)
        va = PastView(a.history, a.attendance, a.context, poison - timedelta(days=1))
        vb = PastView(b.history, b.attendance, b.context, poison - timedelta(days=1))
        fa = gbm_features(va, va.cutoff, "lunch", "a", {"a": 0, "b": 1})
        fb = gbm_features(vb, vb.cutoff, "lunch", "a", {"a": 0, "b": 1})
        self.assertEqual(str(fa), str(fb))  # str: NaN == NaN


class Models(unittest.TestCase):
    def setUp(self):
        d0 = date(2026, 9, 7)
        self.hist = [Observation(d0 + timedelta(days=7 * i), "lunch", "a", v + 5, 5.0, False, 500) for i, v in enumerate([10.0, 20.0, 30.0, 40.0, 50.0])]
        self.hist.append(Observation(d0 + timedelta(days=35), "lunch", "a", 99.0, 0.0, True, 500))  # ran out: censored
        self.view = PastView(self.hist, {}, {}, d0 + timedelta(days=42))
        self.target = d0 + timedelta(days=42)

    def test_hand_checked_points(self):
        self.assertEqual(SeasonalNaive().predict(self.view, self.target, "lunch", "a"), 50.0)  # last uncensored same weekday
        self.assertEqual(MovingAverage(4).predict(self.view, self.target, "lunch", "a"), 35.0)  # (20+30+40+50)/4
        # ES alpha 0.3: 10 → 13 → 18.1 → 24.67 → 32.269
        self.assertAlmostEqual(ExpSmoothing(0.3).predict(self.view, self.target, "lunch", "a"), 32.269, places=6)
        self.assertIsNone(SeasonalNaive().predict(self.view, self.target, "lunch", "zzz"))  # no history: no forecast, not 0

    def test_censored_meals_are_not_used_as_demand(self):
        # The ran-out meal (99 lb prepped, all gone) would drag the averages; it is left out.
        self.assertNotEqual(SeasonalNaive().predict(self.view, self.target, "lunch", "a"), 99.0)
        self.assertIsNotNone(BaselineV1().predict(self.view, self.target, "lunch", "a"))


class Metrics(unittest.TestCase):
    def test_spread_and_default(self):
        self.assertAlmostEqual(spread(100, [-0.1, 0.0, 0.1, 0.2, 0.3], 0.5), 110.0)
        self.assertGreater(spread(100, [], 0.9), 100)  # default ±25% normal spread above the median at q 0.9

    def test_compare_on_synthetic_is_labeled_and_consistent(self):
        r = compare(synthetic(), START + timedelta(days=21), START + timedelta(days=34), include_gbm=False)
        self.assertTrue(r["simulated"])
        self.assertIn("SIMULATED", r["label"])
        self.assertEqual(r["comparisonLabel"], "Simulated FSS (assumed +25% over-prep)")
        versions = {x["model_version"] for x in r["rows"]}
        self.assertEqual(versions, {"baseline-v1", "seasonal-naive-v1", "moving-avg-4-v1", "exp-smoothing-v1", "fss"})
        fss = next(x for x in r["rows"] if x["model_version"] == "fss")
        for x in r["rows"]:
            self.assertEqual(x["meals"], r["scoredMeals"])  # every row on the same meals
            if x["mode"] == "matched_stockouts":
                self.assertLessEqual(x["stockouts"], fss["stockouts"])
            if x["interval_coverage_10_90"] is not None:
                self.assertTrue(0 <= x["interval_coverage_10_90"] <= 1)
        self.assertGreater(r["censoredMeals"], 0)

    def test_wape_excludes_censored(self):
        data = synthetic()
        from forecast.backtest import Pred
        keys = [(o.service_date, o.meal, o.dish_id) for o in data.history if o.service_date >= START + timedelta(days=20)]
        exact = {k: Pred(next(o.consumed_lb for o in data.history if (o.service_date, o.meal, o.dish_id) == k), []) for k in keys}
        r = score(data, exact, keys, load_settings())
        # Perfect point forecasts on uncensored meals; censored meals (consumed = lower bound) are not in WAPE.
        self.assertAlmostEqual(r["wape"], 0.0)
        self.assertAlmostEqual(r["bias"], 0.0)

    @unittest.skipUnless(HAS_SKLEARN, "scikit-learn not installed for this Python (gbm-v1 runs under .venv/bin/python)")
    def test_gbm_runs(self):
        r = compare(synthetic(days=56), START + timedelta(days=42), START + timedelta(days=55), include_gbm=True)
        self.assertIn("gbm-v1", {x["model_version"] for x in r["rows"]})


class Unsupervised(unittest.TestCase):
    def test_kmeans_separates_obvious_groups(self):
        pts = [[0.0, 0.0], [0.1, 0.0], [0.0, 0.1], [5.0, 5.0], [5.1, 5.0], [5.0, 5.1]]
        labels, cents = kmeans(pts, 2, seed=1)
        self.assertEqual(len(set(labels[:3])), 1)
        self.assertEqual(len(set(labels[3:])), 1)
        self.assertNotEqual(labels[0], labels[3])
        self.assertEqual(kmeans(pts, 2, seed=1), (labels, cents))  # deterministic

    def test_day_types_cover_every_day(self):
        data = synthetic()
        types = day_types(data.attendance, data.context, k=3)
        self.assertEqual(set(types), {d for d, _ in data.attendance})
        self.assertLessEqual(len(set(types.values())), 3)

    def test_clustering_flag_is_off_by_default(self):
        self.assertFalse(load_settings().clustering.get("enabled"))
        self.assertFalse(load_settings().anomaly.get("enabled"))

    def test_robust_z_flags_outlier_and_routes_it_out_of_training(self):
        d0 = date(2026, 9, 1)
        hist = [Observation(d0 + timedelta(days=i), "lunch", "a", 20 + (i % 3), 0.0, False) for i in range(10)]
        hist.append(Observation(d0 + timedelta(days=10), "lunch", "a", 400.0, 0.0, False))  # typo: 400 instead of 40
        flagged = robust_z_anomalies(hist)
        self.assertEqual([f["service_date"] for f in flagged], ["2026-09-11"])
        self.assertIn("robust z", flagged[0]["reason"])
        kept = without_anomalies(hist, flagged)
        self.assertEqual(len(kept), 10)
        self.assertEqual(len(hist), 11)  # nothing deleted from the source list

    def test_robust_z_needs_enough_rows_and_spread(self):
        d0 = date(2026, 9, 1)
        few = [Observation(d0 + timedelta(days=i), "lunch", "a", 20.0, 0.0, False) for i in range(3)]
        self.assertEqual(robust_z_anomalies(few + [Observation(d0, "lunch", "a", 500.0, 0.0, False)]), [])


if __name__ == "__main__":
    unittest.main()
