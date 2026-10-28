"""context_import: calendar flags come only from the source files; simulated rows are never overwritten."""

import unittest
from datetime import date

from forecast import context_import as ci


class CalendarDays(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = ci.load_sources()
        cls.cal = ci.calendar_days(cls.src, date(2026, 8, 1), date(2027, 5, 31))

    def test_every_source_file_names_its_url(self):
        self.assertTrue(self.src["academic"]["source_url"].startswith("https://"))
        self.assertTrue(self.src["football"]["source_url"].startswith("https://mgoblue.com/"))
        for h in self.src["holidays"]["holidays"]:
            self.assertTrue(h["source_url"].startswith("https://"), h["name"])

    def test_registrar_dates(self):
        self.assertTrue(self.cal[date(2026, 8, 31)]["first_class_day"])
        self.assertTrue(self.cal[date(2026, 8, 31)]["class_day"])
        self.assertTrue(self.cal[date(2026, 10, 19)]["break_day"])
        self.assertFalse(self.cal[date(2026, 10, 19)]["class_day"])
        self.assertTrue(self.cal[date(2026, 12, 12)]["study_day"])
        exam = [d for d, r in self.cal.items() if r["exam_week"]]
        self.assertEqual(len(exam), 12)  # Dec 14-18, Dec 21, Apr 29-30, May 3-6
        self.assertEqual(min(exam), date(2026, 12, 14))
        self.assertFalse(self.cal[date(2026, 9, 5)]["class_day"])  # a Saturday
        self.assertIsNone(self.cal[date(2026, 8, 15)]["class_day"])  # summer 2026 calendar not fetched: unknown

    def test_home_games_only(self):
        games = sorted(d.isoformat() for d, r in self.cal.items() if r["home_game"])
        self.assertEqual(games, ["2026-09-05", "2026-09-12", "2026-09-19", "2026-09-26", "2026-10-17", "2026-10-24", "2026-11-07", "2026-11-21"])
        self.assertFalse(self.cal[date(2026, 11, 28)]["home_game"])  # at Ohio State
        self.assertIn("football", self.cal[date(2026, 11, 7)]["urls"])

    def test_holidays_carry_their_urls(self):
        yk = self.cal[date(2026, 9, 21)]
        self.assertTrue(yk["is_holiday"])
        self.assertIn("Yom Kippur", yk["holiday_name"])
        self.assertTrue(all(u.startswith("https://www.hebcal.com/") for u in yk["urls"]["holidays"]))


class Rows(unittest.TestCase):
    def test_simulated_rows_are_skipped_not_overwritten(self):
        cal = ci.calendar_days(ci.load_sources(), date(2026, 9, 11), date(2026, 9, 13))
        rows = ci.build_rows(["hall-main", "hall-b"], cal, {}, "2026-10-28T00:00:00+00:00")
        keep, skipped = ci.drop_simulated(rows, {("hall-main", "2026-09-12")})
        self.assertEqual(skipped, [("hall-main", "2026-09-12")])
        self.assertEqual(len(keep), 5)
        self.assertTrue(all(r["is_simulated"] is False for r in keep))

    def test_no_weather_means_null_not_zero(self):
        cal = ci.calendar_days(ci.load_sources(), date(2027, 3, 1), date(2027, 3, 1))
        row = ci.build_rows(["h"], cal, {}, "t")[0]
        self.assertIsNone(row["temp_high_f"])
        self.assertIsNone(row["precip_in"])
        self.assertNotIn("weather", row["source_urls"])

    def test_weather_kind_and_url(self):
        out = {}
        data = {"daily": {"time": ["2026-10-27", "2026-10-29"], "temperature_2m_max": [50.1, 48.0],
                          "precipitation_sum": [0.0, 0.2], "weather_code": [3, 61]}}
        ci._merge_daily(out, data, "forecast", "https://api.open-meteo.com/x", observed_before=date(2026, 10, 28))
        self.assertEqual(out[date(2026, 10, 27)]["weather_kind"], "observed")
        self.assertEqual(out[date(2026, 10, 29)]["weather_kind"], "forecast")
        self.assertEqual(out[date(2026, 10, 29)]["weather_summary"], "rain")

    def test_test_halls_skipped(self):
        self.assertEqual(ci.real_halls(["hall-main", "hall-e2e-x", "hall-test", "hall-live-1", "hall-b"]), ["hall-main", "hall-b"])


if __name__ == "__main__":
    unittest.main()
