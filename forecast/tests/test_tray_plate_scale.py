"""plate-scale-v1 in the forecast: estimated tray grams by hand, and the >= 80% coverage rule still applies."""

import unittest
from datetime import date

from forecast import data as d
from forecast.config import load_settings
from forecast.model import Observation


def dish(dish_id, food):
    return d.Dish(dish_id, dish_id, "entree", None, None, food, False)


SVC = {"service_date": "2026-10-14", "meal_label": "lunch"}


def plate(event, attempt, px=890.0, cm=26.7):
    return {"attempt_id": attempt, "event_id": event, "plate_diameter_px": px, "assumed_plate_diameter_cm": cm,
            "created_at": "2026-10-14T16:00:00Z", "capture_event": {"event_id": event, "meal_service": SVC}}


class TrayGrams(unittest.TestCase):
    def test_hand_computed(self):
        # 100,000 px x (26.7/890)^2 = 90 cm2; x 0.5 g/cm2 = 45 g
        grams, plates = d.tray_grams(
            [], [plate("e1", "a1")],
            [{"attempt_id": "a1", "item_id": "i-rice", "remaining_area_px": 100000, "physical": None},
             {"attempt_id": "a1", "item_id": None, "remaining_area_px": 5000, "physical": None}],
            {"i-rice": "rice"}, {"rice": dish("rice", "Sticky Rice")}, {"sticky rice": 0.5})
        self.assertAlmostEqual(grams[(date(2026, 10, 14), "lunch", "rice")], 45.0, places=9)
        self.assertEqual(plates[(date(2026, 10, 14), "lunch")], {"e1"})
        self.assertEqual(len(grams), 1)  # unclassified food gets no grams

    def test_camera_calibration_wins_no_double_count(self):
        camera = [{"item_id": "i-rice", "physical": {"areaCm2": 10}, "capture_event": {"event_id": "e1", "meal_service": SVC}}]
        grams, plates = d.tray_grams(
            camera, [plate("e1", "a1")],
            [{"attempt_id": "a1", "item_id": "i-rice", "remaining_area_px": 100000, "physical": {"areaCm2": 10}}],
            {"i-rice": "rice"}, {"rice": dish("rice", "Sticky Rice")}, {"sticky rice": 0.5})
        self.assertAlmostEqual(grams[(date(2026, 10, 14), "lunch", "rice")], 5.0)  # 10 cm2 x 0.5, once
        self.assertEqual(plates[(date(2026, 10, 14), "lunch")], {"e1"})


class FakeDB:
    def __init__(self, tables):
        self.tables = tables

    def select(self, table, filters=None, columns="*", order=None):
        return [dict(r) for r in self.tables.get(table, [])]


class Coverage(unittest.TestCase):
    def shares(self, diners):
        db = FakeDB({
            "food_measurement": [],
            "plate_scale_estimate": [plate(f"e{i}", f"a{i}") for i in range(4)],
            "menu_item": [{"item_id": "i-rice", "dish_id": "rice"}],
        })
        # _plate_scale_rows reads food_measurement twice (camera rows, then plate measurements); serve both.
        measurements = [{"attempt_id": f"a{i}", "item_id": "i-rice", "remaining_area_px": 100000, "physical": None} for i in range(4)]
        calls = {"n": 0}
        orig = db.select

        def select(table, filters=None, columns="*", order=None):
            if table == "food_measurement":
                calls["n"] += 1
                return [] if calls["n"] == 1 else measurements
            return orig(table, filters, columns, order)
        db.select = select
        hist = [Observation(service_date=date(2026, 10, 14), meal="lunch", dish_id="rice", prepped_lb=10, leftover_lb=0,
                            ran_out=False, diners=diners, is_simulated=True)]
        notes = []
        s = load_settings()
        out = d.tray_waste_shares(db, "h", {"rice": dish("rice", "Sticky Rice")}, hist, {(date(2026, 10, 14), "lunch"): diners}, s, notes)
        return out, notes

    def test_needs_80_percent_of_diners(self):
        out, notes = self.shares(diners=5)  # 4 scans / 5 diners = 80%
        self.assertIn("rice", out)
        self.assertTrue(any("plate-scale" in n for n in notes))
        out, notes = self.shares(diners=6)  # 4 / 6 = 67%: skipped
        self.assertEqual(out, {})
        self.assertTrue(any("covered < 80%" in n for n in notes))


if __name__ == "__main__":
    unittest.main()
