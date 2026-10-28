"""M-Dining importers on the SIMULATED sample files: a fake database, a mocked sheet reader, 0 Gemini calls."""

import json
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from forecast.evaluate import REAL_FSS_LABEL, SIMULATED_FSS_LABEL, comparison_label
from forecast.importers import fss, sheets_batch, swipes
from forecast.importers.common import ImportError_, parse_date, parse_time, read_table

HERE = Path(__file__).resolve().parent.parent / "importers"
SAMPLES = HERE / "samples"
MAPPINGS = HERE / "mappings"


class FakeDB:
    """Just enough of forecast.db.Supabase: select with eq/in filters, upsert-insert."""

    def __init__(self, tables):
        self.tables = {k: [dict(r) for r in v] for k, v in tables.items()}
        self.inserts = []

    def select(self, table, filters=None, columns="*", order=None):
        rows = self.tables.get(table, [])
        for k, v in (filters or {}).items():
            if k == "and":
                continue
            op, _, val = v.partition(".")
            if op == "eq":
                rows = [r for r in rows if str(r.get(k)).lower() == val.lower()]
            elif op == "in":
                vals = val.strip("()").split(",")
                rows = [r for r in rows if r.get(k) in vals]
            elif op == "not" and val == "is.null":
                rows = [r for r in rows if r.get(k) is not None]
        return [dict(r) for r in rows]

    def insert(self, table, rows, on_conflict=None, upsert=False):
        self.inserts.append((table, rows, on_conflict, upsert))


def swipe_db(simulated_interval=None):
    att = []
    if simulated_interval:
        att.append({"hall_id": "hall-sample", "interval_start": simulated_interval, "service_date": "2026-10-14", "is_simulated": True})
    return FakeDB({"hall": [{"hall_id": "hall-sample", "timezone": "America/Detroit"}], "attendance": att})


class Parsing(unittest.TestCase):
    def test_dates_and_times(self):
        self.assertEqual(parse_date("10/14/2026").isoformat(), "2026-10-14")
        self.assertEqual(parse_date("2026-10-14").isoformat(), "2026-10-14")
        self.assertEqual(parse_date("46309").isoformat(), "2026-10-14")  # Excel serial
        self.assertIsNone(parse_date("13/40/2026"))
        self.assertEqual(parse_time("5:15 PM").isoformat(), "17:15:00")
        self.assertEqual(parse_time("0.5").isoformat(), "12:00:00")

    def test_xlsx(self):
        import zipfile
        tmp = Path(tempfile.mkdtemp())
        p = tmp / "t.xlsx"
        with zipfile.ZipFile(p, "w") as z:
            z.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>')
            z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
            z.writestr("xl/sharedStrings.xml", '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Date</t></si><si><t>Swipes</t></si></sst>')
            z.writestr("xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>46309</v></c><c r="B2"><v>12</v></c></row></sheetData></worksheet>')
        self.assertEqual(read_table(p), [{"Date": "46309", "Swipes": "12"}])
        shutil.rmtree(tmp)


class Swipes(unittest.TestCase):
    def run_sample(self, db, dry_run=False):
        return swipes.run(SAMPLES / "sample_SIMULATED_swipes.csv", MAPPINGS / "swipes.example.toml", db=db, dry_run=dry_run)

    def test_validation_report(self):
        r = self.run_sample(swipe_db(), dry_run=True)
        e = r.counts(r.errors)
        self.assertEqual(e, {"negative_count": 1, "impossible_count": 1, "bad_count": 1, "outside_meal_hours": 1, "unknown_hall": 1})
        w = r.counts(r.warnings)
        self.assertEqual(w["duplicate_row"], 1)
        self.assertGreaterEqual(w["gap"], 1)
        self.assertEqual(r.summary["swipes"], 42 + 77 + 91 + 120 + 64)
        self.assertEqual(r.rows_written, 5)  # dry run reports what it would write

    def test_dry_run_writes_nothing(self):
        db = swipe_db()
        self.run_sample(db, dry_run=True)
        self.assertEqual(db.inserts, [])

    def test_rows_are_real_15_minute_utc(self):
        db = swipe_db()
        self.run_sample(db)
        (table, rows, conflict, upsert), = db.inserts
        self.assertEqual((table, conflict, upsert), ("attendance", "hall_id,interval_start", True))
        first = rows[0]
        self.assertEqual(first["interval_start"], "2026-10-14T15:00:00+00:00")  # 11:00 EDT
        self.assertEqual(first["meal_label"], "lunch")
        self.assertTrue(all(r["is_simulated"] is False and r["source"] == "swipes" for r in rows))
        self.assertIn("dinner", {r["meal_label"] for r in rows})

    def test_simulated_rows_are_not_overwritten(self):
        db = swipe_db(simulated_interval="2026-10-14T15:00:00+00:00")
        r = self.run_sample(db)
        self.assertIn("simulated_rows_present", r.counts(r.warnings))
        written = db.inserts[0][1]
        self.assertNotIn("2026-10-14T15:00:00+00:00", {x["interval_start"] for x in written})

    def test_missing_column_stops_import(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "m.toml").write_text('[columns]\ndate = "Nope"\ntime = "Time"\n')
        with self.assertRaises(ImportError_):
            swipes.run(SAMPLES / "sample_SIMULATED_swipes.csv", tmp / "m.toml", db=swipe_db(), hall="hall-sample", dry_run=True)
        shutil.rmtree(tmp)

    def test_per_swipe_rows_count_one_each(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "s.csv").write_text("When,Card\n2026-10-14 17:01,a\n2026-10-14 17:02,b\n2026-10-14 17:02,b\n2026-10-14 17:20,c\n")
        (tmp / "m.toml").write_text('[columns]\ntimestamp = "When"\nswipe_id = "Card"\n')
        db = swipe_db()
        r = swipes.run(tmp / "s.csv", tmp / "m.toml", db=db, hall="hall-sample")
        rows = db.inserts[0][1]
        self.assertEqual([(x["interval_start"], x["swipe_count"]) for x in rows], [("2026-10-14T21:00:00+00:00", 2), ("2026-10-14T21:15:00+00:00", 1)])
        self.assertEqual(r.counts(r.warnings)["duplicate_swipe"], 1)
        shutil.rmtree(tmp)


def fss_db(simulated=False):
    return FakeDB({
        "hall": [{"hall_id": "hall-sample"}],
        "dish": [{"dish_id": "dish-mac-cheese", "display_name": "Mac and Cheese", "portion_lb": None},
                 {"dish_id": "dish-broccoli", "display_name": "Roasted Broccoli", "portion_lb": 0.25},
                 {"dish_id": "dish-chicken", "display_name": "Grilled Chicken", "portion_lb": 0.33}],
        "menu_item": [{"display_name": "Grilled Chicken Breast", "dish_id": "dish-chicken"}],
        "forecast": [{"hall_id": "hall-sample", "service_date": "2026-10-14", "meal_label": "dinner", "dish_id": "dish-broccoli",
                      "model_version": "fss", "is_simulated": True}] if simulated else [],
    })


class Fss(unittest.TestCase):
    def test_matching_units_and_review(self):
        db = fss_db()
        tmp = Path(tempfile.mkdtemp())
        r = fss.run(SAMPLES / "sample_SIMULATED_fss.csv", MAPPINGS / "fss.example.toml", db=db, out_dir=tmp)
        rows = {(x["meal_label"], x["dish_id"]): x for x in db.inserts[0][1]}
        self.assertEqual(rows[("lunch", "dish-broccoli")]["fss_forecast_lb"], 20.0)        # 320 oz
        self.assertEqual(rows[("dinner", "dish-chicken")]["fss_forecast_lb"], 49.5)        # 150 portions × 0.33 (menu item name)
        self.assertEqual(rows[("dinner", "dish-broccoli")]["fss_forecast_lb"], 19.84)      # 9 kg
        self.assertEqual(rows[("lunch", "dish-mac-cheese")]["fss_forecast_lb"], 2.0)       # alias row, later duplicate wins
        self.assertTrue(all(x["model_version"] == "fss" and x["is_simulated"] is False for x in rows.values()))
        self.assertEqual([u["fss_name"] for u in r.review], ["Chef Special Curry"])         # never created
        self.assertNotIn("dish", [t for t, *_ in db.inserts])
        self.assertEqual(r.counts(r.errors), {"bad_date": 1})
        self.assertEqual(r.counts(r.warnings), {"duplicate_row": 1})
        self.assertIn("Chef Special Curry", (tmp / "sample_SIMULATED_fss.fss_unmatched.csv").read_text())
        shutil.rmtree(tmp)

    def test_simulated_fss_rows_are_not_replaced(self):
        db = fss_db(simulated=True)
        r = fss.run(SAMPLES / "sample_SIMULATED_fss.csv", MAPPINGS / "fss.example.toml", db=db)
        self.assertIn("simulated_rows_present", r.counts(r.warnings))
        self.assertNotIn(("dinner", "dish-broccoli"), {(x["meal_label"], x["dish_id"]) for x in db.inserts[0][1]})

    def test_label_switches_to_plain_fss_once_rows_are_real(self):
        from forecast.data import HallData

        def data(sim):
            return HallData("h", "America/Detroit", None, 6, {}, [], {}, False, {}, False, {}, sim, {}, {}, [])
        self.assertEqual(comparison_label(data(True)), SIMULATED_FSS_LABEL)
        self.assertEqual(comparison_label(data(False)), REAL_FSS_LABEL)
        self.assertEqual(REAL_FSS_LABEL, "FSS")
        # What the importer writes is what flips the flag: every imported row has is_simulated = false.
        db = fss_db()
        fss.run(SAMPLES / "sample_SIMULATED_fss.csv", MAPPINGS / "fss.example.toml", db=db)
        self.assertFalse(any(r["is_simulated"] for r in db.inserts[0][1]))


class MockBackend(BaseHTTPRequestHandler):
    """The four endpoints the batch uses. The 'sheet reader' is canned: no Gemini."""
    extracts = 0
    fail_names: set = set()

    def log_message(self, *a):
        pass

    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/images/uploads":
            oid = "img_" + body["associationId"][-8:]
            return self._send(201, {"objectId": oid, "uploadUrl": f"/upload/{oid}"})
        if self.path.endswith("/finalize"):
            return self._send(200, {"ok": True})
        if self.path == "/api/production-sheets/extract":
            type(self).extracts += 1
            if body["objectId"] in type(self).fail_names:
                return self._send(502, {"error": {"code": "GEMINI_TIMEOUT"}})
            return self._send(200, {"readable": True, "model": "mock", "rows": [{"status": "unconfirmed", "reviewFlags": []},
                                                                               {"status": "unconfirmed", "reviewFlags": ["low_confidence"]}]})
        self._send(404, {})

    def do_PUT(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.send_response(204)
        self.end_headers()


class SheetsBatch(unittest.TestCase):
    def setUp(self):
        MockBackend.extracts = 0
        MockBackend.fail_names = set()
        self.server = HTTPServer(("127.0.0.1", 0), MockBackend)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.http = sheets_batch.Http(f"http://127.0.0.1:{self.server.server_port}", None)
        self.tmp = Path(tempfile.mkdtemp())
        self.log = self.tmp / "log.jsonl"
        self.quiet = lambda *a: None

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.tmp)

    def run_batch(self, **kw):
        return sheets_batch.run(SAMPLES / "sample_SIMULATED_sheets", http=self.http, hall="hall-sample", log=self.log, echo=self.quiet, **kw)

    def test_cap_resume_and_log(self):
        s1 = self.run_batch(max_gemini=2)
        self.assertEqual((s1["read"], s1["not_sent_cap"], s1["rows"]), (2, 1, 4))
        s2 = self.run_batch(max_gemini=5)
        self.assertEqual((s2["skipped_already_read"], s2["read"]), (2, 1))
        self.assertEqual(MockBackend.extracts, 3)  # no photo read twice
        entries = [json.loads(x) for x in self.log.read_text().splitlines()]
        self.assertEqual(len(entries), 3)
        self.assertTrue(all(e["status"] == "unconfirmed" for e in entries))
        dated = next(e for e in entries if e["file"].startswith("2026-10-14_lunch"))
        self.assertEqual((dated["date"], dated["meal"]), ("2026-10-14", "lunch"))

    def test_failures_are_retried_next_run(self):
        import hashlib
        p = sorted((SAMPLES / "sample_SIMULATED_sheets").iterdir())[0]
        MockBackend.fail_names = {"img_" + ("sheet_batch_" + hashlib.sha256(p.read_bytes()).hexdigest()[:16])[-8:]}
        s1 = self.run_batch(max_gemini=10)
        self.assertEqual((s1["read"], s1["failed"]), (2, 1))
        MockBackend.fail_names = set()
        s2 = self.run_batch(max_gemini=10)
        self.assertEqual((s2["read"], s2["skipped_already_read"]), (1, 2))

    def test_dry_run_sends_nothing(self):
        s = self.run_batch(max_gemini=10, dry_run=True)
        self.assertEqual(MockBackend.extracts, 0)
        self.assertFalse(self.log.exists())
        self.assertEqual(s["gemini_requests"], 3)


if __name__ == "__main__":
    unittest.main()
