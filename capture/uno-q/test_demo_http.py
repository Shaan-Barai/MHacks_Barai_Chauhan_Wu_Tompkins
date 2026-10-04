#!/usr/bin/env python3
"""demo.py HTTP helper: the ingest-token hint must not appear for expected refusals (no network)."""

import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock
import urllib.error
from contextlib import redirect_stdout

spec = importlib.util.spec_from_file_location("demo", Path(__file__).resolve().parents[2] / "demo.py")
demo_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo_mod)


def make_demo(token="secret"):
    with mock.patch.object(demo_mod, "resolve_token", return_value=(token, "env X")):
        return demo_mod.Demo(SimpleNamespace(api="http://x", token_env="SCRAP_INGEST_TOKEN", out=None,
                                             date="2026-10-04", service=None))


def refuse(req, timeout=None, context=None):
    raise urllib.error.HTTPError(req.full_url, 401, "no", {}, io.BytesIO(b'{"error":"x"}'))


class TokenHint(unittest.TestCase):
    def call(self, **kw):
        d, out = make_demo(), io.StringIO()
        with mock.patch("urllib.request.urlopen", side_effect=refuse) as m, redirect_stdout(out):
            status, _ = d.get("/api/admin/captures", **kw)
        return status, out.getvalue(), m

    def test_unexpected_401_prints_hint(self):
        status, out, _ = self.call()
        self.assertEqual(status, 401)
        self.assertIn("SCRAP_INGEST_TOKEN", out)

    def test_anonymous_401_is_silent_and_sends_no_token(self):
        status, out, m = self.call(anonymous=True)
        self.assertEqual(status, 401)
        self.assertEqual(out, "")
        self.assertIsNone(m.call_args[0][0].get_header("Authorization"))


if __name__ == "__main__":
    unittest.main()
