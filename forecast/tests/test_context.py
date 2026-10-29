"""Context adjustments to expected diners (exam week, home game, holiday): off by default."""

import unittest
from datetime import date, timedelta

from forecast.config import load_settings
from forecast.data import Dish, HallData
from forecast.model import Observation, context_multiplier, make_forecast
from forecast.worker import build_forecasts

MON = date(2026, 9, 7)
SAT = MON + timedelta(days=5)


def saturdays(n):
    return [SAT + timedelta(days=7 * i) for i in range(n)]


class ContextMultiplier(unittest.TestCase):
    def test_off_by_default(self):
        self.assertFalse(load_settings().context.get("enabled"), "context adjustments must be opt-in")

    def test_no_flags_on_the_target_day_is_no_adjustment(self):
        att = {(d, "dinner"): 800.0 for d in saturdays(6)}
        adj = context_multiplier(att, {}, saturdays(6)[-1] + timedelta(days=7), "dinner")
        self.assertEqual(adj.multiplier, 1.0)
        self.assertEqual(adj.applied, {})

    def test_home_game_effect_is_estimated_from_past_flagged_days(self):
        days = saturdays(6)
        att = {(d, "dinner"): 1000.0 for d in days}
        att[(days[1], "dinner")] = 800.0  # home game: 0.8x
        att[(days[3], "dinner")] = 700.0  # home game: 0.7x
        ctx = {days[1]: {"home_game"}, days[3]: {"home_game"}}
        target = days[-1] + timedelta(days=7)
        ctx[target] = {"home_game"}
        adj = context_multiplier(att, ctx, target, "dinner")
        self.assertAlmostEqual(adj.applied["home_game"], (0.8 + 0.7) / 2)
        self.assertAlmostEqual(adj.multiplier, 0.75)

    def test_too_little_history_skips_the_flag(self):
        days = saturdays(4)
        att = {(d, "dinner"): 1000.0 for d in days}
        att[(days[1], "dinner")] = 500.0
        target = days[-1] + timedelta(days=7)
        ctx = {days[1]: {"is_holiday"}, target: {"is_holiday"}}
        adj = context_multiplier(att, ctx, target, "dinner", min_days=2)
        self.assertEqual(adj.multiplier, 1.0)
        self.assertEqual(adj.skipped, ["is_holiday"])

    def test_flags_multiply_and_the_result_is_clamped(self):
        days = saturdays(8)
        att = {(d, "dinner"): 1000.0 for d in days}
        for d in days[0:2]:
            att[(d, "dinner")] = 400.0
        for d in days[2:4]:
            att[(d, "dinner")] = 500.0
        ctx = {**{d: {"is_holiday"} for d in days[0:2]}, **{d: {"exam_week"} for d in days[2:4]}}
        target = days[-1] + timedelta(days=7)
        ctx[target] = {"is_holiday", "exam_week"}
        adj = context_multiplier(att, ctx, target, "dinner", lo=0.3)
        self.assertAlmostEqual(adj.applied["is_holiday"], 0.4)
        self.assertAlmostEqual(adj.applied["exam_week"], 0.5)
        self.assertAlmostEqual(adj.multiplier, 0.3, msg="0.4 x 0.5 = 0.2, clamped to the 0.3 floor")
        self.assertAlmostEqual(context_multiplier(att, ctx, target, "dinner", lo=0.1).multiplier, 0.2, msg="unclamped: the flags multiply")

    def test_never_uses_the_target_day_or_later(self):
        days = saturdays(5)
        att = {(d, "dinner"): 1000.0 for d in days}
        target = days[2]
        att[(target, "dinner")] = 100.0
        ctx = {target: {"home_game"}, days[3]: {"home_game"}, days[4]: {"home_game"}}
        adj = context_multiplier(att, ctx, target, "dinner")
        self.assertEqual(adj.applied, {}, "only earlier flagged days count")


class ForecastWithContext(unittest.TestCase):
    def hall(self, context):
        hist = [Observation(SAT + timedelta(days=7 * i), "dinner", "rice", 40.0, 0.0, False, 1000.0) for i in range(6)]
        att = {(SAT + timedelta(days=7 * i), "dinner"): 1000.0 for i in range(6)}
        att[(SAT + timedelta(days=7), "dinner")] = 600.0
        att[(SAT + timedelta(days=21), "dinner")] = 600.0
        return HallData(
            hall_id="h1", timezone="America/Detroit", cycle_start=None, cycle_weeks=6,
            dishes={"rice": Dish("rice", "Sticky Rice", "side", 0.35, None, "Sticky Rice", False)},
            history=hist, attendance=att, attendance_simulated=False, menu_cycle={}, menu_cycle_simulated=False,
            fss={}, fss_simulated=False, tray_waste_share={}, context=context, notes=[],
        )

    def test_disabled_flag_leaves_forecasts_unchanged(self):
        target = SAT + timedelta(days=42)
        ctx = {SAT + timedelta(days=7): {"home_game"}, SAT + timedelta(days=21): {"home_game"}, target: {"home_game"}}
        with_ctx, _ = build_forecasts(self.hall(ctx), target, target, ("dinner",))
        without, _ = build_forecasts(self.hall({}), target, target, ("dinner",))
        self.assertEqual(with_ctx[0]["demand_lb"], without[0]["demand_lb"], "config has context.enabled = false")

    def test_an_applied_adjustment_scales_diners_and_says_so(self):
        target = SAT + timedelta(days=42)
        ctx = {SAT + timedelta(days=7): {"home_game"}, SAT + timedelta(days=21): {"home_game"}, target: {"home_game"}}
        data = self.hall(ctx)
        adj = context_multiplier(data.attendance, data.context, target, "dinner")
        self.assertAlmostEqual(adj.multiplier, 0.6, places=3)
        args = dict(history=data.history, attendance=data.attendance, target=target, meal="dinner", dish_id="rice", dish_name="Sticky Rice",
                    portion_lb=0.35, cycle_start=None, weeks=6, cost_under=9.0, cost_over=1.0, tray_waste_share=None, errors=[])
        plain = make_forecast(**args)
        adjusted = make_forecast(**args, context_adjustment=adj)
        self.assertLess(adjusted.demand_lb, plain.demand_lb)
        self.assertIn("home game x0.60", adjusted.why)
        self.assertIn("estimated from past days", adjusted.why)


if __name__ == "__main__":
    unittest.main()
