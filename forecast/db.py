"""Minimal Supabase (PostgREST) client for the forecast worker: stdlib only.

Uses the service role key from the environment (or the repo-root .env), on
the server only. The key is never printed or logged. PostgREST filter syntax:
{"hall_id": "eq.hall-main", "service_date": "gte.2026-10-01"}.
"""

from __future__ import annotations

import json
import os
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PAGE = 1000


def load_env(path: Path = REPO / ".env") -> None:
    """KEY=value lines from .env into os.environ, never overriding values already set."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
        if m and m.group(1) not in os.environ:
            os.environ[m.group(1)] = m.group(2).strip("'\"")


class SupabaseError(RuntimeError):
    pass


def _ssl_context() -> ssl.SSLContext:
    """Verified TLS. python.org builds on macOS ship without CA certificates until
    'Install Certificates' is run; fall back to the system bundle then (still verifying)."""
    ctx = ssl.create_default_context()
    if ctx.cert_store_stats().get("x509_ca", 0) == 0 and not os.environ.get("SSL_CERT_FILE"):
        for bundle in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
            if Path(bundle).exists():
                ctx.load_verify_locations(bundle)
                break
    return ctx


class Supabase:
    def __init__(self, url: str, service_key: str, timeout: float = 30.0):
        if not re.match(r"^https://[a-z0-9-]+\.supabase\.co/?$", url or ""):
            raise SupabaseError("SUPABASE_URL must be the project API address, https://<project-ref>.supabase.co")
        if not service_key:
            raise SupabaseError("SUPABASE_SERVICE_ROLE_KEY is not set")
        self.base = url.rstrip("/") + "/rest/v1"
        self._key = service_key
        self.timeout = timeout
        self._ssl = _ssl_context()

    @classmethod
    def from_env(cls) -> "Supabase":
        load_env()
        return cls(os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""))

    def _request(self, method: str, table: str, params: dict[str, str] | None = None, body=None, headers: dict[str, str] | None = None):
        query = urllib.parse.urlencode(params or {}, safe=",.()*:")
        url = f"{self.base}/{table}" + (f"?{query}" if query else "")
        data = None if body is None else json.dumps(body, default=str).encode()
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("apikey", self._key)
        req.add_header("Authorization", f"Bearer {self._key}")
        req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=self._ssl) as res:
                text = res.read().decode()
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            raise SupabaseError(f"{method} {table} failed ({e.code}): {detail}") from None
        except urllib.error.URLError as e:
            raise SupabaseError(f"{method} {table} failed: {e.reason}") from None

    def select(self, table: str, filters: dict[str, str] | None = None, columns: str = "*", order: str | None = None) -> list[dict]:
        rows: list[dict] = []
        offset = 0
        while True:
            params = {"select": columns, **(filters or {}), "limit": str(PAGE), "offset": str(offset)}
            if order:
                params["order"] = order
            page = self._request("GET", table, params) or []
            rows.extend(page)
            if len(page) < PAGE:
                return rows
            offset += PAGE

    def insert(self, table: str, rows: list[dict], on_conflict: str | None = None, upsert: bool = False) -> None:
        prefer = "return=minimal"
        if upsert:
            prefer += ",resolution=merge-duplicates"
        params = {"on_conflict": on_conflict} if on_conflict else None
        for i in range(0, len(rows), 500):
            self._request("POST", table, params, rows[i : i + 500], {"Prefer": prefer})

    def update(self, table: str, filters: dict[str, str], patch: dict) -> None:
        if not filters:
            raise SupabaseError("refusing an UPDATE without a filter")
        self._request("PATCH", table, filters, patch, {"Prefer": "return=minimal"})

    def delete(self, table: str, filters: dict[str, str]) -> int:
        """Delete matching rows; returns how many. A filter is required (no accidental full wipes)."""
        if not filters:
            raise SupabaseError("refusing a DELETE without a filter")
        deleted = self._request("DELETE", table, {**filters, "select": "*"}, None, {"Prefer": "return=representation"}) or []
        return len(deleted)
