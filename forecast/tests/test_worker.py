"""Worker, simulator and client guards (no database)."""

import unittest
from datetime import date, timedelta

from forecast.data import HallData, Dish, dishes_for
from forecast.db import Supabase, SupabaseError
from forecast.model import Observation
from forecast.simulate import DISHES, _menu, dish_id, simulated_tray_waste_lb
from forecast.worker import build_forecasts

MON = date(2026, 9, 7)


def hall(history, *, simulated_dish=False, attendance=None, menu_cycle=None):
    return HallData(
        hall_id="h1", timezone="America/Detroit", cycle_start=MON, cycle_weeks=6,
        dishes={
            "rice": Dish("rice", "Sticky Rice", "side", 0.35, None, "Sticky Rice", simulated_dish),
            "ham": Dish("ham", "Baked Boneless Ham", "entree", 0.38, None, "Baked Boneless Ham", False),
        },
        history=history, attendance=attendance or {}, attendance_simulated=False,
        menu_cycle=menu_cycle or {}, menu_cycle_simulated=False, fss={}, tray_waste_share={}, notes=[],
    )


class Worker(unittest.TestCase):
    def test_forecast_rows_use_only_the_past_and_label_simulated_inputs(self):
        hist = [Observation(MON + timedelta(days=7 * i), "lunch", "rice", 30.0 + i, 2.0, False) for i in range(6)]
        target = MON + timedelta(days=42)
        rows, skipped = build_forecasts(hall(hist, simulated_dish=True), target, target, ("lunch",))
        self.assertEqual(len(rows), 1, skipped)
        r = rows[0]
        self.assertEqual((r["service_date"], r["meal_label"], r["dish_id"]), (target.isoformat(), "lunch", "rice"))
        self.assertTrue(r["is_simulated"], "a simulated dish makes a simulated forecast")
        self.assertEqual(r["basis"], "last_cycle")
        self.assertAlmostEqual(r["demand_lb"], 28.0, msg="the same cycle day one cycle ago: 30 prepped - 2 left")
        self.assertLessEqual(r["low_lb"], r["recommended_prep_lb"])
        self.assertLessEqual(r["recommended_prep_lb"], r["high_lb"])
        self.assertTrue(0 < r["service_level_q"] < 1)
        self.assertIn("Sticky Rice", r["why"])

    def test_menu_cycle_decides_the_dishes_and_unknown_dishes_are_skipped(self):
        target = MON + timedelta(days=42)  # cycle week 1, Monday
        hist = [Observation(MON, "lunch", d, 20.0, 1.0, False) for d in ("rice", "ham")]
        data = hall(hist, menu_cycle={(1, 1, "lunch"): ["ham", "ghost"]})
        self.assertEqual(dishes_for(data, target, "lunch"), ["ghost", "ham"])
        rows, skipped = build_forecasts(data, target, target, ("lunch",))
        self.assertEqual([r["dish_id"] for r in rows], ["ham"])
        self.assertTrue(any("ghost" in s and "dish table" in s for s in skipped))

    def test_no_history_means_no_forecast_not_zero(self):
        rows, skipped = build_forecasts(hall([], menu_cycle={(1, 1, "lunch"): ["rice"]}), MON + timedelta(days=42), MON + timedelta(days=42), ("lunch",))
        self.assertEqual(rows, [])
        self.assertTrue(skipped and "no history" in skipped[0])


class Simulator(unittest.TestCase):
    def test_menus_are_deterministic_distinct_and_balanced(self):
        ids = {dish_id(d[0]) for d in DISHES}
        self.assertEqual(len(DISHES), 15)
        for w in range(1, 7):
            for wd in range(1, 8):
                for meal in ("lunch", "dinner"):
                    m = _menu(w, wd, meal)
                    self.assertEqual(m, _menu(w, wd, meal))
                    self.assertEqual(len(m), len(set(m)), "no dish twice in one meal")
                    self.assertTrue(set(m) <= ids)
                    styles = [next(d[2] for d in DISHES if dish_id(d[0]) == x) for x in m]
                    self.assertEqual((styles.count("entree"), styles.count("side"), styles.count("self_serve")), (2, 2, 2))

    def test_simulated_ids_and_tray_waste(self):
        self.assertEqual(dish_id("Michigan Farmers 4 Bean Stew"), "sim-michigan-farmers-4-bean-stew")
        for d in DISHES:
            w = simulated_tray_waste_lb(dish_id(d[0]), MON, "lunch", 100.0)
            self.assertTrue(4.0 <= w <= 14.0, w)
        self.assertEqual(simulated_tray_waste_lb("x", MON, "lunch", -5), 0.0)


class ClientGuards(unittest.TestCase):
    def test_refuses_a_dashboard_link_or_a_missing_key(self):
        with self.assertRaises(SupabaseError):
            Supabase("https://supabase.com/dashboard/org/abc", "k")
        with self.assertRaises(SupabaseError):
            Supabase("https://abcdefghijklmnopqrst.supabase.co", "")

    def test_refuses_unfiltered_deletes_and_updates(self):
        db = Supabase("https://abcdefghijklmnopqrst.supabase.co", "sb_secret_test")
        with self.assertRaises(SupabaseError):
            db.delete("production_log", {})
        with self.assertRaises(SupabaseError):
            db.update("hall", {}, {"menu_cycle_start": None})


if __name__ == "__main__":
    unittest.main()
