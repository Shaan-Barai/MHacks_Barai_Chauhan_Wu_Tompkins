"""Unit tests for the Nutrition5k weight test's pure functions (standard library only)."""

import math
import unittest

import n5k


def dish(did, *ings):
    return {"dish_id": did, "total_g": sum(g for _, g in ings), "ingredients": [{"id": "", "name": n, "grams": g} for n, g in ings]}


class Geometry(unittest.TestCase):
    def test_focal_from_intel_vertical_fov(self):
        # (480 / 2) / tan(21.25°) = 617.2 px for the 640 × 480 colour image.
        self.assertAlmostEqual(n5k.focal_px(), 240 / math.tan(math.radians(21.25)), places=6)
        self.assertAlmostEqual(n5k.focal_px(), 617.16, places=1)

    def test_pixel_area_scales_with_distance_squared(self):
        a = n5k.pixel_area_cm2(35.9)
        self.assertAlmostEqual(a, (35.9 / n5k.focal_px()) ** 2)
        self.assertAlmostEqual(n5k.pixel_area_cm2(71.8) / a, 4.0)


class Selection(unittest.TestCase):
    def test_small_sauces_are_skipped_but_big_ones_count(self):
        self.assertTrue(n5k.is_skipped({"name": "olive oil", "grams": 4}))
        self.assertFalse(n5k.is_skipped({"name": "olive oil", "grams": 12}))
        self.assertFalse(n5k.is_skipped({"name": "cauliflower", "grams": 3}))

    def test_dominant_food_after_skipping(self):
        c = n5k.classify(dish("dish_1", ("cauliflower", 90), ("olive oil", 5), ("salt", 0.5), ("parsley", 3)))
        self.assertEqual(c["food_type"], "cauliflower")
        self.assertEqual(c["csv_food"], "Roasted Cauliflower")
        self.assertEqual(c["visible_g"], 90)
        self.assertEqual(len(c["skipped"]), 3)

    def test_mixed_or_unmapped_dishes_are_left_out(self):
        self.assertIsNone(n5k.classify(dish("dish_1", ("cauliflower", 50), ("steak", 50))))
        self.assertIsNone(n5k.classify(dish("dish_1", ("almonds", 40))))

    def test_scans_minutes_apart_share_a_plate_group(self):
        g = n5k.plate_groups(["dish_1000", "dish_1100", "dish_1350", "dish_2000"])
        self.assertEqual(g["dish_1100"], "dish_1000")
        self.assertEqual(g["dish_1350"], "dish_1000")
        self.assertEqual(g["dish_2000"], "dish_2000")

    def test_split_is_fixed_and_half_per_type_one_dish_per_plate(self):
        cands = [{"dish_id": f"dish_{1000 * i}", "food_type": t} for i in range(1, 25) for t in ("a",)]
        cands += [{"dish_id": f"dish_{1000 * i + 10}", "food_type": "a"} for i in range(1, 5)]  # same plates
        groups = n5k.plate_groups([c["dish_id"] for c in cands])
        s1 = n5k.select_sample(cands, groups, per_type=10, seed=42)
        s2 = n5k.select_sample(cands, groups, per_type=10, seed=42)
        self.assertEqual(s1, s2)
        self.assertEqual(len(s1), 10)
        self.assertEqual(sum(x["half"] == "fit" for x in s1), 5)
        self.assertEqual(len({x["plate_group"] for x in s1}), 10)


class Metrics(unittest.TestCase):
    def test_fit_ratio_through_origin(self):
        self.assertAlmostEqual(n5k.fit_ratio([(1, 2), (2, 4), (3, 6)]), 2.0)
        self.assertIsNone(n5k.fit_ratio([]))

    def test_errors(self):
        e = n5k.errors([(110, 100), (40, 50)])
        self.assertEqual(e["n"], 2)
        self.assertEqual(e["mae_g"], 10.0)
        self.assertEqual(e["mape_pct"], 15.0)
        self.assertEqual(e["bias_g"], 0.0)
        self.assertEqual(e["bias_pct"], -5.0)

    def test_missing_estimates_are_not_zero(self):
        self.assertEqual(n5k.errors([(None, 100)])["n"], 0)


if __name__ == "__main__":
    unittest.main()
