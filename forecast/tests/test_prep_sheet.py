"""Prep sheet rendering (no database)."""

import unittest
from datetime import date

from forecast.prep_sheet import render_sheet


def sheet(simulated: bool):
    return {
        "meal": "lunch", "station": "Signature Maize", "simulated": simulated, "diners": 640, "generated_at": "2026-10-25T02:04:00+00:00",
        "rows": [{"dish": "Mac <b>& Cheese</b>", "prep_lb": 54.1, "portions": 142, "low_lb": 36.1, "high_lb": 60.5, "why": "x < y", "simulated": simulated}],
    }


class PrepSheet(unittest.TestCase):
    def test_lines_have_amount_portions_range_and_why(self):
        html = render_sheet("hall-main", date(2026, 10, 25), sheet(False))
        for text in ["Prep sheet: Signature Maize, Lunch", "54.1", "142", "36.1–60.5", "about 640 diners", "Sunday, October 25, 2026"]:
            self.assertIn(text, html)
        self.assertNotIn("Simulated data", html)

    def test_simulated_sheets_say_so_and_text_is_escaped(self):
        html = render_sheet("hall-main", date(2026, 10, 25), sheet(True))
        self.assertIn("Simulated data", html)
        self.assertIn("Do not prep from this sheet", html)
        self.assertIn("Mac &lt;b&gt;&amp; Cheese&lt;/b&gt;", html)
        self.assertIn("x &lt; y", html)
        self.assertNotIn("<b>& Cheese</b>", html)


if __name__ == "__main__":
    unittest.main()
