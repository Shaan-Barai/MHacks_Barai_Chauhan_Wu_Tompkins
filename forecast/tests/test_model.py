"""Unit tests for the forecast formulas (no database).

    python3 -m unittest discover -s forecast/tests -t .
"""

import unittest
from datetime import date, timedelta

from forecast.config import impact_score_for, load_settings
from forecast.model import (
    LB_PER_KG,
    Observation,
    Outcome,
    baseline,
    consumed,
    cost_of_waste_per_lb,
    cycle_position,
    evaluate,
    expected_diners,
    make_forecast,
    newsvendor_q,
    prep_from_errors,
    quantile,
    relative_errors,
    scaled_demand,
    waste_adjusted,
    wape,
)

MON = date(2026, 9, 7)  # a Monday: cycle week 1


def obs(day, lb, *, leftover=0.0, ran_out=False, dish="rice", meal="lunch", diners=None, prepped=None):
    """An observation that consumed `lb` (prepped - leftover)."""
    p = prepped if prepped is not None else lb + leftover
    return Observation(day, meal, dish, p, None if ran_out and leftover == 0 else leftover, ran_out, diners)


class Newsvendor(unittest.TestCase):
    def test_critical_ratio(self):
        self.assertAlmostEqual(newsvendor_q(17, 3), 0.85)
        self.assertAlmostEqual(newsvendor_q(1, 1), 0.5)
        for bad in [(0, 1), (1, 0), (-1, 2), (float("inf"), 1)]:
            with self.assertRaises(ValueError):
                newsvendor_q(*bad)

    def test_quantile_interpolates(self):
        vals = [0.0, 10.0, 20.0, 30.0, 40.0]
        self.assertEqual(quantile(vals, 0.0), 0.0)
        self.assertEqual(quantile(vals, 1.0), 40.0)
        self.assertEqual(quantile(vals, 0.5), 20.0)
        self.assertAlmostEqual(quantile(vals, 0.85), 34.0)  # pos 3.4 -> 30 + 0.4 * 10
        self.assertEqual(quantile([5.0, 1.0, 3.0], 0.5), 3.0, "order does not matter")

    def test_prep_is_the_q_th_percentile_of_demand(self):
        # Errors -20%..+20% in 5% steps; q = 0.85 -> +14%; prep = demand x 1.14.
        errors = [x / 100 for x in range(-20, 25, 5)]
        prep, low, high, method = prep_from_errors(100.0, errors, 0.85)
        self.assertAlmostEqual(prep, 100.0 * (1 + quantile(errors, 0.85)))
        self.assertAlmostEqual(prep, 114.0)
        self.assertAlmostEqual(low, 100.0 * (1 + quantile(errors, 0.10)))
        self.assertAlmostEqual(high, 100.0 * (1 + quantile(errors, 0.90)))
        self.assertIn("empirical", method)

    def test_higher_q_never_preps_less(self):
        errors = [-0.3, -0.1, 0.0, 0.05, 0.1, 0.2, 0.4]
        preps = [prep_from_errors(50.0, errors, q)[0] for q in (0.3, 0.5, 0.6, 0.85, 0.95)]
        self.assertEqual(preps, sorted(preps))

    def test_too_few_errors_use_a_default_spread(self):
        prep, low, high, method = prep_from_errors(100.0, [0.1, -0.1], 0.85)
        self.assertIn("default spread", method)
        self.assertAlmostEqual(prep, 100.0 * (1 + 0.25 * 1.0364333894937898), places=1)  # z(0.85) ~ 1.036
        self.assertLess(low, 100.0)
        self.assertGreater(high, 100.0)

    def test_prep_never_negative(self):
        self.assertEqual(prep_from_errors(10.0, [-2.0] * 6, 0.1)[0], 0.0)

    def test_cost_of_waste_includes_the_impact_score(self):
        co = cost_of_waste_per_lb(3.0, 5.07)  # ham: $5.07/kg
        self.assertAlmostEqual(co, 3.0 + 5.07 / LB_PER_KG)
        self.assertEqual(cost_of_waste_per_lb(3.0, None), 3.0)
        # A higher impact score lowers q: wasting that dish costs more.
        self.assertLess(newsvendor_q(23.2, cost_of_waste_per_lb(3.0, 5.07)), newsvendor_q(23.2, cost_of_waste_per_lb(3.0, 0.26)))

    def test_config_defaults_give_the_target_service_levels(self):
        s = load_settings()
        co = cost_of_waste_per_lb(s.default_food_cost_usd_per_lb, 2.40)
        self.assertAlmostEqual(newsvendor_q(s.cost_under("entree"), co), 0.85, places=2)
        self.assertAlmostEqual(newsvendor_q(s.cost_under("side"), co), 0.60, places=2)
        self.assertLess(newsvendor_q(s.cost_under("self_serve"), co), 0.5)
        self.assertEqual(impact_score_for("Baked Boneless Ham"), 5.07)
        self.assertIsNone(impact_score_for("Not A Food"))


class Censoring(unittest.TestCase):
    def test_ran_out_is_a_lower_bound(self):
        self.assertEqual(consumed(20.0, 5.0, False), (15.0, False))
        self.assertEqual(consumed(20.0, None, True), (20.0, True), "ran out: everything left the pan, demand >= 20")
        self.assertEqual(consumed(20.0, None, False), (None, False), "unknown leftover: no observation")
        self.assertEqual(consumed(None, 1.0, False), (None, False))
        self.assertEqual(consumed(5.0, 9.0, False), (0.0, False), "never negative")

    def test_baseline_from_a_ran_out_meal_is_at_least_that_much(self):
        target = MON + timedelta(days=42)
        hist = [
            obs(MON, 30.0, ran_out=True),  # same cycle day last cycle: ran out at 30
            obs(MON + timedelta(days=14), 40.0),  # Mondays averaging 40
            obs(MON + timedelta(days=21), 40.0),
        ]
        b = baseline(hist, target, "lunch", "rice", MON)
        self.assertEqual(b.basis, "last_cycle_ran_out")
        self.assertTrue(b.lower_bound)
        self.assertAlmostEqual(b.lb, (30 + 40 + 40) / 3, msg="max(observed 30, recent Monday average)")
        # If the recent average is lower than what ran out, the observed lower bound stands.
        low_hist = [obs(MON, 30.0, ran_out=True), obs(MON + timedelta(days=14), 10.0)]
        self.assertAlmostEqual(baseline(low_hist, target, "lunch", "rice", MON).lb, 30.0)

    def test_error_spread_keeps_censored_meals_only_when_already_under_forecast(self):
        mondays = [MON + timedelta(days=7 * i) for i in range(5)]
        hist = [obs(d, 20.0) for d in mondays[:4]]
        att = {}
        # The 5th Monday ran out at 30 (forecast ~20): demand was at least +50%, keep it.
        errs_high = relative_errors(hist + [obs(mondays[4], 30.0, ran_out=True)], mondays[4] + timedelta(days=1), "lunch", None, None, 6, att)
        self.assertIn(0.5, [round(e, 6) for e in errs_high])
        # Ran out at 10 (below the forecast): the true error is unknown, drop it.
        errs_low = relative_errors(hist + [obs(mondays[4], 10.0, ran_out=True)], mondays[4] + timedelta(days=1), "lunch", None, None, 6, att)
        self.assertNotIn(-0.5, [round(e, 6) for e in errs_low])
        self.assertEqual(len(errs_low), len(errs_high) - 1)

    def test_evaluation_never_scores_wape_on_ran_out_meals(self):
        outcomes = [
            Outcome(110.0, 100.0, False, 5.0),  # over by 10
            Outcome(90.0, 100.0, False, 0.0),  # under by 10 -> stockout
            Outcome(50.0, 80.0, True, 0.0),  # ran out at >= 80, prep 50 -> certain stockout, excluded from WAPE
        ]
        r = evaluate(outcomes)
        self.assertAlmostEqual(r["wape"], 20.0 / 200.0)
        self.assertEqual(r["stockouts"], 2)
        self.assertEqual(r["censored_meals"], 1)
        self.assertEqual(r["leftover_lb"], 10.0)
        self.assertIsNone(wape([]))

    def test_a_ran_out_meal_prepped_at_exactly_the_forecast_is_a_stockout(self):
        # The kitchen prepped the FSS amount (40 lb) and ran out: consumed = 40, demand >= 40.
        self.assertEqual(evaluate([Outcome(40.0, 40.0, True, 0.0)])["stockouts"], 1)
        # A larger prep would have covered at least that much: not a certain stockout.
        self.assertEqual(evaluate([Outcome(45.0, 40.0, True, 0.0)])["stockouts"], 0)
        # Uncensored: exactly enough is not a stockout.
        self.assertEqual(evaluate([Outcome(40.0, 40.0, False, 0.0)])["stockouts"], 0)


class WasteAndDemand(unittest.TestCase):
    def test_waste_adjustment(self):
        self.assertAlmostEqual(waste_adjusted(100.0, 0.12), 88.0)
        self.assertEqual(waste_adjusted(100.0, 0.0), 100.0)
        self.assertEqual(waste_adjusted(100.0, -0.2), 100.0, "clamped at 0")
        self.assertAlmostEqual(waste_adjusted(100.0, 3.0), 5.0, msg="clamped at 95%")

    def test_cycle_position(self):
        self.assertEqual(cycle_position(MON, MON), (1, 1))
        self.assertEqual(cycle_position(MON + timedelta(days=9), MON), (2, 3))
        self.assertEqual(cycle_position(MON + timedelta(days=42), MON), (1, 1), "wraps after 6 weeks")
        self.assertEqual(cycle_position(MON - timedelta(days=1), MON), (6, 7), "before the anchor counts backwards")
        with self.assertRaises(ValueError):
            cycle_position(MON, MON + timedelta(days=1))

    def test_baseline_fallbacks_in_order(self):
        tue = MON + timedelta(days=1)
        target = MON + timedelta(days=42)  # Monday, cycle week 1
        self.assertEqual(baseline([obs(MON, 12.0)], target, "lunch", "rice", MON).basis, "last_cycle")
        self.assertEqual(baseline([obs(MON + timedelta(days=7), 12.0)], target, "lunch", "rice", MON).basis, "dish_weekday_meal_avg")
        self.assertEqual(baseline([obs(tue, 12.0)], target, "lunch", "rice", MON).basis, "dish_meal_avg")
        self.assertEqual(baseline([obs(MON, 12.0, dish="soup")], target, "lunch", "rice", MON).basis, "hall_weekday_meal_avg")
        self.assertIsNone(baseline([], target, "lunch", "rice", MON))
        self.assertIsNone(baseline([obs(target, 12.0)], target, "lunch", "rice", MON), "never uses the target day itself")

    def test_demand_scales_with_expected_diners(self):
        target = MON + timedelta(days=42)
        hist = [obs(MON, 40.0, diners=800)]
        att = {(MON + timedelta(days=7 * i), "lunch"): 1000.0 for i in range(1, 6)}
        b = baseline(hist, target, "lunch", "rice", MON)
        self.assertEqual(expected_diners(att, target, "lunch"), 1000.0)
        demand, scale = scaled_demand(b, 1000.0)
        self.assertAlmostEqual(scale, 1.25)
        self.assertAlmostEqual(demand, 50.0)

    def test_make_forecast_end_to_end(self):
        target = MON + timedelta(days=42)
        hist = [obs(MON, 40.0, diners=800)]
        att = {(MON + timedelta(days=7 * i), "lunch"): 1000.0 for i in range(1, 6)}
        f = make_forecast(
            history=hist, attendance=att, target=target, meal="lunch", dish_id="rice", dish_name="Sticky Rice", portion_lb=0.35,
            cycle_start=MON, weeks=6, cost_under=17.0, cost_over=3.0, tray_waste_share=0.1, errors=[x / 100 for x in range(-20, 25, 5)],
        )
        self.assertAlmostEqual(f.demand_lb, 50.0)
        self.assertAlmostEqual(f.expected_eaten_lb, 45.0, msg="10% tray waste from calibrated scans")
        self.assertAlmostEqual(f.recommended_prep_lb, 57.0, msg="q = 0.85 -> +14%")
        self.assertLessEqual(f.low_lb, f.recommended_prep_lb)
        self.assertGreaterEqual(f.high_lb, f.recommended_prep_lb)
        self.assertAlmostEqual(f.take_rate, round(50.0 / (0.35 * 1000.0), 4))
        self.assertEqual(f.tray_waste_source, "calibrated_scans")
        self.assertIn("same cycle day last cycle", f.why)
        self.assertIn("85%", f.why)
        no_scans = make_forecast(
            history=hist, attendance=att, target=target, meal="lunch", dish_id="rice", dish_name="Sticky Rice", portion_lb=0.35,
            cycle_start=MON, weeks=6, cost_under=17.0, cost_over=3.0, tray_waste_share=None, errors=[],
        )
        self.assertEqual(no_scans.tray_waste_share, 0.0)
        self.assertEqual(no_scans.tray_waste_source, "none")
        self.assertEqual(no_scans.expected_eaten_lb, no_scans.demand_lb)


if __name__ == "__main__":
    unittest.main()
