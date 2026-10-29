"""Run 5: the scheduled forecast run writes only services that have not started, and its cron
times fall before every lock in both EDT and EST."""

import re
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from forecast.config import load_settings
from forecast.scheduled_run import plan, summary_markdown
from forecast.worker import service_start

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "forecast-schedule.yml"
TZ = "America/Detroit"


def rows(day: str):
    return [{"service_date": day, "meal_label": m, "dish_id": d, "is_simulated": True} for m in ("breakfast", "lunch", "dinner") for d in ("a", "b")]


class Plan(unittest.TestCase):
    def test_never_writes_a_started_service(self):
        meals = load_settings().meals
        lunch = service_start(date(2026, 11, 3), "lunch", TZ, meals)  # EST after the Nov 1 change: 16:00 UTC
        self.assertEqual(lunch, datetime(2026, 11, 3, 16, 0, tzinfo=timezone.utc))
        p = plan(rows("2026-11-03") + rows("2026-11-04"), TZ, meals, lunch - timedelta(minutes=30))
        self.assertEqual(p["servicesSkippedStarted"], ["2026-11-03 breakfast"])  # lunch is still 30 min away
        self.assertNotIn(("2026-11-03", "breakfast"), {(r["service_date"], r["meal_label"]) for r in p["write"]})
        after = plan(rows("2026-11-03"), TZ, meals, lunch + timedelta(minutes=1))
        self.assertEqual(after["servicesSkippedStarted"], ["2026-11-03 breakfast", "2026-11-03 lunch"])
        self.assertEqual({r["meal_label"] for r in after["write"]}, {"dinner"})

    def test_runs_twice_write_the_same_plan(self):
        meals = load_settings().meals
        now = datetime(2026, 10, 30, 14, 5, tzinfo=timezone.utc)
        a = plan(rows("2026-10-30"), TZ, meals, now)
        b = plan(rows("2026-10-30"), TZ, meals, now + timedelta(minutes=1))
        self.assertEqual(a["servicesWritten"], b["servicesWritten"])
        self.assertEqual(a["servicesWritten"], ["2026-10-30 dinner", "2026-10-30 lunch"])
        self.assertEqual(a["nextLock"], "2026-10-30T15:00:00+00:00")  # 11:00 EDT

    def test_summary_labels_simulated_rows(self):
        md = summary_markdown({"ranAt": "t", "hallId": "hall-main", "dryRun": False, "rowsWritten": 4, "simulatedRows": 4,
                               "servicesWritten": ["2026-10-30 dinner"], "servicesSkippedStarted": [], "nextLock": None})
        self.assertIn("4 SIMULATED", md)


class Workflow(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text()

    def test_off_until_the_variable_is_set_and_no_secret_values(self):
        self.assertIn("if: vars.FORECAST_SCHEDULER_ENABLED == 'true'", self.text)
        self.assertIn("${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}", self.text)
        self.assertNotRegex(self.text, r"sb_secret_|eyJ[A-Za-z0-9_-]{10,}")

    def test_every_meal_has_a_run_before_its_lock_in_summer_and_winter(self):
        crons = [(int(h), int(m)) for m, h in re.findall(r"cron: '(\d+) (\d+) \* \* \*'", self.text)]
        self.assertEqual(len(crons), 4)
        meals = load_settings().meals
        for day in (date(2026, 7, 15), date(2027, 1, 15)):  # EDT, EST
            for meal in ("breakfast", "lunch", "dinner"):
                lock = service_start(day, meal, TZ, meals)
                runs = [datetime(day.year, day.month, day.day, h, m, tzinfo=timezone.utc) for h, m in crons]
                runs += [r - timedelta(days=1) for r in runs]
                before = [r for r in runs if lock - timedelta(hours=8) <= r <= lock - timedelta(minutes=45)]
                self.assertTrue(before, f"no run 45 min to 8 h before {meal} on {day} ({lock.astimezone(ZoneInfo(TZ))})")


if __name__ == "__main__":
    unittest.main()
