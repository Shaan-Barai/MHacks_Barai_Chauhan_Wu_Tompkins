"""Shared pieces for the M-Dining importers: mapping files, CSV/XLSX reading,
name normalization and a validation report. Standard library only.

A mapping file (TOML) says which column of the export holds which field, so a
new export layout needs a new mapping file, not new code:

    [columns]
    date = "Business Date"        # header text in the file (case and spacing ignored)
    count = "Swipes"

    [halls]                         # optional: export hall names -> our hall ids
    "East Quad Dining" = "hall-main"
"""

from __future__ import annotations

import csv
import io
import json
import re
import tomllib
import unicodedata
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree as ET


class ImportError_(RuntimeError):
    """A problem with the input or the mapping: stops the import before anything is written."""


def norm_header(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(s).lower()).strip()


def norm_name(s: str) -> str:
    """Same rule as vision/src/productionSheet.ts normalizeName: lower case, accents off, punctuation to spaces."""
    s = unicodedata.normalize("NFKD", str(s).lower())
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def load_mapping(path: Path) -> dict:
    with open(path, "rb") as f:
        m = tomllib.load(f)
    if "columns" not in m:
        raise ImportError_(f"{path}: the mapping needs a [columns] table")
    return m


def read_table(path: Path, sheet: str | None = None) -> list[dict[str, str]]:
    """Rows as {header: text}. CSV (any common delimiter) or XLSX (first sheet, or `sheet`)."""
    suffix = path.suffix.lower()
    if suffix in (".csv", ".txt", ".tsv"):
        text = path.read_text(encoding="utf-8-sig", errors="replace")
        try:
            dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        rows = list(csv.reader(io.StringIO(text), dialect))
    elif suffix in (".xlsx", ".xlsm"):
        rows = _read_xlsx(path, sheet)
    else:
        raise ImportError_(f"{path.name}: unsupported file type {suffix} (send CSV or XLSX)")
    rows = [r for r in rows if any(str(c).strip() for c in r)]
    if not rows:
        return []
    header = [str(h).strip() for h in rows[0]]
    return [{header[i]: (r[i] if i < len(r) else "") for i in range(len(header))} for r in rows[1:]]


_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
       "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}


def _read_xlsx(path: Path, sheet: str | None) -> list[list[str]]:
    """Minimal XLSX reader: shared strings, inline strings, numbers. Dates arrive as Excel serial numbers."""
    with zipfile.ZipFile(path) as z:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", _NS):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{_NS['m']}}}t")))
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        sheets = wb.findall("m:sheets/m:sheet", _NS)
        target = next((s for s in sheets if sheet is None or s.get("name") == sheet), None)
        if target is None:
            raise ImportError_(f"{path.name}: no sheet named {sheet!r}")
        rid = target.get(f"{{{_NS['r']}}}id")
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        href = next(r.get("Target") for r in rels if r.get("Id") == rid)
        ws = ET.fromstring(z.read("xl/" + href.lstrip("/").removeprefix("xl/")))
        out: list[list[str]] = []
        for row in ws.iter(f"{{{_NS['m']}}}row"):
            cells: dict[int, str] = {}
            for c in row.findall("m:c", _NS):
                col = _col_index(re.match(r"[A-Z]+", c.get("r", "A")).group(0))
                t = c.get("t")
                v = c.find("m:v", _NS)
                if t == "s" and v is not None:
                    cells[col] = shared[int(v.text)]
                elif t == "inlineStr":
                    cells[col] = "".join(x.text or "" for x in c.iter(f"{{{_NS['m']}}}t"))
                else:
                    cells[col] = v.text if v is not None and v.text is not None else ""
            if cells:
                out.append([cells.get(i, "") for i in range(max(cells) + 1)])
        return out


def _col_index(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n - 1


def resolve_columns(rows: list[dict[str, str]], mapping: dict, required: list[str], optional: list[str]) -> dict[str, str]:
    """field -> actual header in the file. Missing required columns stop the import."""
    if not rows:
        raise ImportError_("the file has no data rows")
    headers = {norm_header(h): h for h in rows[0].keys()}
    cols: dict[str, str] = {}
    missing = []
    for f in required + optional:
        want = mapping["columns"].get(f)
        if want is None:
            if f in required:
                missing.append(f"{f} (not in the mapping)")
            continue
        actual = headers.get(norm_header(want))
        if actual is None:
            if f in required:
                missing.append(f"{f} = {want!r} (no such column; the file has: {', '.join(rows[0].keys())})")
            continue
        cols[f] = actual
    if missing:
        raise ImportError_("missing columns: " + "; ".join(missing))
    return cols


@dataclass
class Report:
    """What an import did and what a person should look at. Written next to the input as JSON and text."""
    importer: str
    source_file: str
    dry_run: bool
    rows_read: int = 0
    rows_written: int = 0
    errors: list[dict] = field(default_factory=list)     # rows rejected (nothing written for them)
    warnings: list[dict] = field(default_factory=list)   # rows kept but worth a look
    review: list[dict] = field(default_factory=list)     # needs a person (e.g. unmatched dishes)
    summary: dict = field(default_factory=dict)

    def error(self, line: int | None, code: str, message: str, **extra) -> None:
        self.errors.append({"line": line, "code": code, "message": message, **extra})

    def warn(self, line: int | None, code: str, message: str, **extra) -> None:
        self.warnings.append({"line": line, "code": code, "message": message, **extra})

    def counts(self, items: list[dict]) -> dict[str, int]:
        out: dict[str, int] = {}
        for x in items:
            out[x["code"]] = out.get(x["code"], 0) + 1
        return out

    def to_dict(self) -> dict:
        return {"importer": self.importer, "sourceFile": self.source_file, "dryRun": self.dry_run, "rowsRead": self.rows_read,
                "rowsWritten": self.rows_written, "errorCounts": self.counts(self.errors), "warningCounts": self.counts(self.warnings),
                "summary": self.summary, "errors": self.errors, "warnings": self.warnings, "review": self.review}

    def text(self) -> str:
        lines = [f"{self.importer}: {self.source_file}{' (DRY RUN: nothing written)' if self.dry_run else ''}",
                 f"rows read {self.rows_read}, rows {'that would be ' if self.dry_run else ''}written {self.rows_written}"]
        for k, v in self.summary.items():
            lines.append(f"  {k}: {v}")
        for title, items in (("errors (rows rejected)", self.errors), ("warnings", self.warnings)):
            if items:
                lines.append(f"{title}: " + ", ".join(f"{k} × {n}" for k, n in self.counts(items).items()))
                for x in items[:15]:
                    lines.append(f"  line {x['line']}: {x['code']}: {x['message']}")
                if len(items) > 15:
                    lines.append(f"  … {len(items) - 15} more in the JSON report")
        if self.review:
            lines.append(f"needs review: {len(self.review)} (see the JSON report / review CSV)")
        return "\n".join(lines)

    def write(self, out_dir: Path, stem: str) -> Path:
        out_dir.mkdir(parents=True, exist_ok=True)
        p = out_dir / f"{stem}.report.json"
        p.write_text(json.dumps(self.to_dict(), indent=1, default=str))
        (out_dir / f"{stem}.report.txt").write_text(self.text() + "\n")
        return p


def parse_number(s: str) -> float | None:
    s = str(s).strip().replace(",", "")
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


_DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d-%b-%Y", "%b %d %Y", "%Y/%m/%d")
_TIME_FORMATS = ("%H:%M", "%H:%M:%S", "%I:%M %p", "%I:%M:%S %p", "%I:%M%p")


def parse_date(s: str, fmt: str | None = None):
    """A date from common export formats (or the mapping's `date_format`); Excel serial numbers too. None if unreadable."""
    from datetime import date, datetime, timedelta
    s = str(s).strip()
    if not s:
        return None
    if re.fullmatch(r"\d{5}(\.\d+)?", s):  # Excel serial day
        return date(1899, 12, 30) + timedelta(days=int(float(s)))
    for f in ((fmt,) if fmt else ()) + _DATE_FORMATS:
        try:
            return datetime.strptime(s, f).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s).date()
    except ValueError:
        return None


def parse_datetime(s: str, fmt: str | None = None):
    """A naive local datetime (ISO, 'M/D/YYYY H:MM AM', Excel serial). None if unreadable."""
    from datetime import datetime, timedelta
    s = str(s).strip()
    if not s:
        return None
    if re.fullmatch(r"\d{5}\.\d+", s):
        return datetime(1899, 12, 30) + timedelta(days=float(s))
    if fmt:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None) if "T" in s or re.match(r"\d{4}-", s) else _mdY_time(s)
    except ValueError:
        return _mdY_time(s)


def _mdY_time(s: str):
    from datetime import datetime
    for d in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
        for t in _TIME_FORMATS:
            try:
                return datetime.strptime(s, f"{d} {t}")
            except ValueError:
                continue
    return None


def parse_time(s: str):
    """HH:MM, HH:MM:SS, 'h:mm AM', or an Excel day fraction. None if unreadable."""
    from datetime import datetime, time
    s = str(s).strip()
    if not s:
        return None
    if re.fullmatch(r"0?\.\d+", s):
        minutes = round(float(s) * 24 * 60)
        return time(minutes // 60 % 24, minutes % 60)
    for f in _TIME_FORMATS:
        try:
            return datetime.strptime(s.upper(), f).time()
        except ValueError:
            continue
    return None
