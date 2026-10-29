"""Run 4: backtests see only weather FORECASTS, shadow-mode locking, and the locked-forecast report."""

import importlib.util
import re
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from forecast import context_import as ci
from forecast.backtest import run_models
from forecast.config import load_settings
from forecast.model import Observation
from forecast.models import LookAheadError, Model, PastView, available_models, gbm_features
from forecast.shadow_report import classify, report
from forecast.simulate import simulated_forecast_weather
from forecast.tests.test_backtest import START, synthetic
from forecast.worker import service_start, split_by_lock

HAS_SKLEARN = importlib.util.find_spec("sklearn") is not None and importlib.util.find_spec("numpy") is not None
MIGRATION = Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "20261028000017_forecast_weather_and_shadow_lock.sql"


def with_weather(data, observed_temp: float):
    """Forecast weather for every day (mild), observed weather set to `observed_temp`. SIMULATED, tests only."""
    days = sorted({o.service_date for o in data.history})
    data.weather_forecast = {d: {"temp_high_f": 50.0 + d.day % 7, "precip_in": 0.1 * (d.day % 3), "lead_hours": 24} for d in days}
    data.weather_observed = {d: {"temp_high_f": observed_temp, "precip_in": observed_temp / 100} for d in days}
    return data


class ObservedWeatherIsNeverSeenForTheTargetDay(unittest.TestCase):
    def test_view_refuses_observed_weather_on_or_after_the_target_day(self):
        data = with_weather(synthetic(), 60.0)
        cutoff = START + timedelta(days=14)
        v = PastView(data.history, data.attendance, data.context, cutoff,
                     weather_forecast=data.weather_forecast, weather_observed=data.weather_observed)
        with self.assertRaises(LookAheadError):
            v.observed_weather_on(cutoff)
        with self.assertRaises(LookAheadError):
            v.observed_weather_on(cutoff + timedelta(days=1))
        with self.assertRaises(LookAheadError):
            v.forecast_weather_on(cutoff + timedelta(days=1))
        self.assertIsNotNone(v.forecast_weather_on(cutoff))  # issued >= 24 h ahead: known before the day
        self.assertEqual(v.observed_weather_on(cutoff - timedelta(days=1))["temp_high_f"], 60.0)  # yesterday is over
        self.assertNotIn(cutoff, v._weather_observed)  # not even stored in the view

    def test_a_backtest_that_reads_the_target_days_observed_weather_fails(self):
        class Cheater(Model):
            def __init__(self):
                super().__init__("cheater-v0")

            def predict(self, view, target, meal, dish_id):
                return 10.0 + (view.observed_weather_on(target) or {}).get("temp_high_f", 0.0)

        data = with_weather(synthetic(), 60.0)
        with self.assertRaises(LookAheadError):
            run_models(data, START + timedelta(days=20), load_settings(), [Cheater()])

    def test_observed_weather_changes_no_forecast(self):
        """Absurd observed weather on every day must not move any model's forecast (gbm included when installed)."""
        s = load_settings()
        end = START + timedelta(days=30)
        models_a, _ = available_models(["a", "b"], include_gbm=HAS_SKLEARN)
        models_b, _ = available_models(["a", "b"], include_gbm=HAS_SKLEARN)
        a = run_models(with_weather(synthetic(), 60.0), end, s, models_a)
        b = run_models(with_weather(synthetic(), 9999.0), end, s, models_b)
        for m in a:
            self.assertTrue(a[m], m)
            self.assertEqual({k: round(p.demand, 9) for k, p in a[m].items()}, {k: round(p.demand, 9) for k, p in b[m].items()},
                             f"{m} used observed weather")

    def test_gbm_features_use_the_forecast_for_the_target_day(self):
        data = with_weather(synthetic(), 60.0)
        target = START + timedelta(days=20)

        def feats(fc_temp, obs_temp):
            fc = {**data.weather_forecast, target: {"temp_high_f": fc_temp, "precip_in": 0.3}}
            obs = {**data.weather_observed, target: {"temp_high_f": obs_temp, "precip_in": 0.0}}
            v = PastView(data.history, data.attendance, data.context, target, weather_forecast=fc, weather_observed=obs)
            return gbm_features(v, target, "lunch", "a", {"a": 0, "b": 1})

        self.assertEqual(str(feats(40.0, 10.0)), str(feats(40.0, 95.0)))  # the day's observed weather is invisible
        self.assertNotEqual(str(feats(40.0, 10.0)), str(feats(80.0, 10.0)))  # its forecast is a feature
        self.assertIn(80.0, feats(80.0, 10.0))


class ForecastWeatherSources(unittest.TestCase):
    def test_day_ahead_daily_is_max_and_sum_of_complete_days(self):
        hours = [f"2026-10-0{d}T{h:02d}:00" for d in (1, 2) for h in range(24)]
        temp = [50.0 + (h % 24) * 0.5 for h in range(48)]
        rain = [0.01] * 24 + [0.02] * 23 + [None]  # day 2 is missing an hour: left out
        out = ci.day_ahead_daily({"hourly": {"time": hours, "temperature_2m_previous_day1": temp,
                                             "precipitation_previous_day1": rain}}, "https://previous-runs-api.open-meteo.com/x")
        self.assertEqual(list(out), [date(2026, 10, 1)])
        d = out[date(2026, 10, 1)]
        self.assertEqual((d["fc_temp_high_f"], d["fc_precip_in"], d["fc_lead_hours"], d["fc_source"]),
                         (61.5, 0.24, 24, "open-meteo-previous-runs"))
        self.assertTrue(d["fc_source_url"].startswith("https://previous-runs-api.open-meteo.com/"))

    def test_rows_keep_forecast_and_observed_weather_apart(self):
        cal = ci.calendar_days(ci.load_sources(), date(2026, 10, 1), date(2026, 10, 2))
        obs = {date(2026, 10, 1): {"temp_high_f": 70.0, "precip_in": 0.0, "weather_summary": "clear", "weather_kind": "observed", "url": "u"}}
        fc = {date(2026, 10, 1): {"fc_temp_high_f": 66.0, "fc_precip_in": 0.2, "fc_lead_hours": 24,
                                  "fc_source": "open-meteo-previous-runs", "fc_source_url": "f"}}
        r1, r2 = ci.build_rows(["h"], cal, obs, "t", fc)
        self.assertEqual((r1["temp_high_f"], r1["fc_temp_high_f"], r1["fc_lead_hours"], r1["fc_fetched_at"]), (70.0, 66.0, 24, "t"))
        self.assertIsNone(r2["fc_temp_high_f"])
        self.assertIsNone(r2["fc_fetched_at"])

    def test_simulated_forecast_weather_is_labeled_and_deterministic(self):
        a = simulated_forecast_weather("hall-main", date(2026, 10, 1), 50.0, 0.2)
        self.assertEqual(a, simulated_forecast_weather("hall-main", date(2026, 10, 1), 50.0, 0.2))
        self.assertEqual(a["fc_source"], "simulated")
        self.assertLessEqual(abs(a["fc_temp_high_f"] - 50.0), 6.0)
        self.assertTrue(0.1 <= a["fc_precip_in"] <= 0.3)
        self.assertIsNone(simulated_forecast_weather("h", date(2026, 10, 1), None, None)["fc_temp_high_f"])


class ShadowMode(unittest.TestCase):
    def test_lock_times_in_the_migration_match_config(self):
        sql = MIGRATION.read_text()
        starts = dict(re.findall(r"\('(breakfast|lunch|dinner)', '(\d\d:\d\d)'\)", sql))
        self.assertEqual(starts, {m: v[0] for m, v in load_settings().meals.items()})

    def test_worker_revises_only_services_that_have_not_started(self):
        meals = load_settings().meals
        starts = service_start(date(2026, 10, 28), "lunch", "America/Detroit", meals)
        self.assertEqual(starts, datetime(2026, 10, 28, 15, 0, tzinfo=timezone.utc))  # 11:00 EDT
        rows = [{"service_date": "2026-10-28", "meal_label": m} for m in ("lunch", "dinner")]
        open_, started = split_by_lock(rows, "America/Detroit", meals, starts + timedelta(minutes=5))
        self.assertEqual(([r["meal_label"] for r in open_], [r["meal_label"] for r in started]), (["dinner"], ["lunch"]))
        open_, started = split_by_lock(rows, "America/Detroit", meals, starts - timedelta(minutes=1))  # inside the margin
        self.assertEqual([r["meal_label"] for r in started], ["lunch"])

    def test_report_scores_only_locked_forecasts_and_labels_simulated(self):
        data = synthetic()
        now = datetime(2027, 1, 1, tzinfo=timezone.utc)
        rows = []
        for i, o in enumerate(sorted(data.history, key=lambda o: (o.service_date, o.dish_id))):
            locks = datetime.combine(o.service_date, datetime.min.time(), timezone.utc) + timedelta(hours=15)
            kind = ("locked", "late", "before_shadow")[i % 3]
            created = locks - timedelta(hours=20) if kind != "late" else locks + timedelta(days=2)
            rows.append({"service_date": o.service_date.isoformat(), "meal_label": o.meal, "dish_id": o.dish_id,
                         "recommended_prep_lb": (o.consumed_lb or 1.0) * (1.1 if kind == "locked" else 50.0),
                         "created_at": created.isoformat(), "locks_at": locks.isoformat(),
                         "lock_tracked": kind != "before_shadow", "is_simulated": True})
        rows.append({**rows[0], "service_date": "2027-02-01", "created_at": "2027-01-01T00:00:00+00:00",
                     "locks_at": "2027-02-01T15:00:00+00:00", "lock_tracked": True})
        groups = classify(rows, now)
        self.assertEqual({k: len(v) for k, v in groups.items()},
                         {"locked": len(data.history) // 3 + (len(data.history) % 3 > 0), "late": len(data.history) // 3 + (len(data.history) % 3 > 1),
                          "before_shadow": len(data.history) // 3, "not_started": 1})
        r = report(data, rows, START, START + timedelta(days=40), "baseline-v1", load_settings(), now)
        self.assertTrue(r["simulated"])
        self.assertIn("SIMULATED", r["label"])
        self.assertEqual(r["scoredMeals"], len(groups["locked"]))
        # Only the locked rows (1.1 x consumed) are scored: the 50x late / pre-shadow rows would make the leftover huge.
        self.assertLess(r["locked"]["bias"], 0.11)
        self.assertLessEqual(r["lockedMatched"]["stockouts"], r["fss"]["stockouts"])
        self.assertEqual(r["locked"]["meals"], r["fss"]["meals"])

    def test_report_without_locked_rows_says_so(self):
        r = report(synthetic(), [], START, START + timedelta(days=5), "baseline-v1", load_settings(), datetime.now(timezone.utc))
        self.assertEqual(r["scoredMeals"], 0)
        self.assertNotIn("locked", r)
        self.assertEqual(r["label"], "nothing scored (this window's inputs are SIMULATED)")


if __name__ == "__main__":
    unittest.main()
