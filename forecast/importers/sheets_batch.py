"""A folder of production-sheet photos -> the existing sheet reader -> UNCONFIRMED production_log rows.

    python3 -m forecast.importers.sheets_batch FOLDER --hall hall-main --max-gemini 20 [--api http://127.0.0.1:8787] [--dry-run]

Each photo goes through the backend's normal flow (upload as a
`production_sheet` image, finalize, POST /api/production-sheets/extract), so
the rows land UNCONFIRMED and a person confirms them on the Production sheets
page. Nothing is ever confirmed by this command.

- Resumable: a per-photo log (`<FOLDER>/.sheets_batch_log.jsonl`, or --log)
  keyed by the photo's SHA-256. Photos already read successfully are skipped.
  Failed photos are tried again on the next run.
- --max-gemini N: stop before sending more than N photos. Each read is one
  Gemini request on the server; its own retries can add more, so leave room.
- Date and meal: from the file name when it starts with YYYY-MM-DD and names a
  meal (e.g. 2026-10-14_lunch_grill.jpg), else --date/--meal, else the server
  reads them from the sheet (and flags it if they disagree).
- Auth: SCRAP_INGEST_TOKEN from the environment / .env, sent as a bearer token.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PHOTO_TYPES = {".jpg", ".jpeg", ".png", ".webp", ".heic"}
NAME_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[_\- ]+.*?(breakfast|lunch|dinner)", re.I)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_log(log: Path) -> dict[str, dict]:
    """sha256 -> the latest entry for that photo."""
    done: dict[str, dict] = {}
    if log.exists():
        for line in log.read_text().splitlines():
            if line.strip():
                e = json.loads(line)
                done[e["sha256"]] = e
    return done


def date_meal_from_name(name: str) -> tuple[str | None, str | None]:
    m = NAME_RE.match(name)
    return (m.group(1), m.group(2).lower()) if m else (None, None)


class Http:
    """Tiny JSON client for the backend (injectable in tests)."""

    def __init__(self, base: str, token: str | None):
        self.base = base.rstrip("/")
        self.token = token

    def _open(self, method: str, url: str, data: bytes | None, headers: dict) -> tuple[int, bytes]:
        if not url.startswith("http"):
            url = self.base + url
        req = urllib.request.Request(url, data=data, method=method)
        for k, v in headers.items():
            req.add_header(k, v)
        if self.token and url.startswith(self.base):
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.read()

    def json(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        status, raw = self._open(method, path, None if body is None else json.dumps(body).encode(), {"Content-Type": "application/json"})
        try:
            return status, json.loads(raw.decode() or "{}")
        except ValueError:
            return status, {"raw": raw.decode(errors="replace")[:300]}

    def put(self, url: str, data: bytes, headers: dict) -> int:
        return self._open("PUT", url, data, headers)[0]


def read_one(http: Http, photo: Path, hall: str, date: str | None, meal: str | None) -> dict:
    data = photo.read_bytes()
    mime = mimetypes.guess_type(photo.name)[0] or "image/jpeg"
    sheet_id = "sheet_batch_" + hashlib.sha256(data).hexdigest()[:16]
    st, grant = http.json("POST", "/api/images/uploads", {"associationKind": "production_sheet", "associationId": sheet_id, "mimeType": mime, "sizeBytes": len(data)})
    if st >= 300:
        return {"ok": False, "stage": "upload_grant", "status": st, "error": grant.get("error") or grant}
    st = http.put(grant["uploadUrl"], data, grant.get("uploadHeaders") or {"Content-Type": mime})
    if st >= 300:
        return {"ok": False, "stage": "upload", "status": st}
    st, fin = http.json("POST", f"/api/images/{grant['objectId']}/finalize")
    if st >= 300:
        return {"ok": False, "stage": "finalize", "status": st, "error": fin.get("error") or fin}
    body = {"objectId": grant["objectId"], "hallId": hall, **({"serviceDate": date} if date else {}), **({"mealLabel": meal} if meal else {})}
    st, res = http.json("POST", "/api/production-sheets/extract", body)
    if st >= 300:
        return {"ok": False, "stage": "extract", "status": st, "error": res.get("error") or res, "objectId": grant["objectId"]}
    rows = res.get("rows") or []
    return {"ok": True, "objectId": grant["objectId"], "readable": res.get("readable"), "model": res.get("model"),
            "rows": len(rows), "flagged": sum(1 for r in rows if r.get("reviewFlags")), "status": "unconfirmed"}


def run(folder: Path, *, http: Http, hall: str, max_gemini: int, date: str | None = None, meal: str | None = None,
        log: Path | None = None, dry_run: bool = False, echo=print) -> dict:
    log = log or folder / ".sheets_batch_log.jsonl"
    done = read_log(log)
    photos = sorted(p for p in folder.iterdir() if p.suffix.lower() in PHOTO_TYPES and not p.name.startswith("."))
    summary = {"photos": len(photos), "skipped_already_read": 0, "read": 0, "failed": 0, "not_sent_cap": 0, "gemini_requests": 0, "rows": 0}
    for p in photos:
        digest = sha256(p)
        if done.get(digest, {}).get("ok"):
            summary["skipped_already_read"] += 1
            continue
        if summary["gemini_requests"] >= max_gemini:
            summary["not_sent_cap"] += 1
            continue
        d, m = date_meal_from_name(p.name)
        d, m = d or date, m or meal
        if dry_run:
            echo(f"would read {p.name} (date {d or 'from sheet'}, meal {m or 'from sheet'})")
            summary["gemini_requests"] += 1
            continue
        summary["gemini_requests"] += 1
        result = read_one(http, p, hall, d, m)
        entry = {"sha256": digest, "file": p.name, "at": datetime.now(timezone.utc).isoformat(), "hall": hall, "date": d, "meal": m, **result}
        with open(log, "a") as f:
            f.write(json.dumps(entry) + "\n")
        if result["ok"]:
            summary["read"] += 1
            summary["rows"] += result["rows"]
            echo(f"read {p.name}: {result['rows']} rows ({result['flagged']} flagged), UNCONFIRMED")
        else:
            summary["failed"] += 1
            echo(f"FAILED {p.name} at {result['stage']} (HTTP {result.get('status')}): {result.get('error')}")
    if summary["not_sent_cap"]:
        echo(f"--max-gemini {max_gemini} reached: {summary['not_sent_cap']} photo(s) left for the next run")
    summary["log"] = str(log)
    return summary


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m forecast.importers.sheets_batch", description=__doc__.split("\n\n")[0])
    p.add_argument("folder", type=Path)
    p.add_argument("--hall", required=True)
    p.add_argument("--max-gemini", type=int, required=True, help="most photos to send to the sheet reader in this run")
    p.add_argument("--api", default=os.environ.get("SCRAP_API_URL", "http://127.0.0.1:8787"))
    p.add_argument("--date")
    p.add_argument("--meal", choices=["breakfast", "lunch", "dinner"])
    p.add_argument("--log", type=Path)
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    from ..db import load_env
    load_env()
    s = run(a.folder, http=Http(a.api, os.environ.get("SCRAP_INGEST_TOKEN") or None), hall=a.hall, max_gemini=a.max_gemini,
            date=a.date, meal=a.meal, log=a.log, dry_run=a.dry_run)
    print(json.dumps(s, indent=1))
    return 1 if s["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
