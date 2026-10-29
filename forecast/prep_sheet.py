"""Printable prep sheets: one HTML page per station per meal, from the stored forecasts.

    python3 -m forecast.prep_sheet --hall hall-main --date 2026-10-25 [--out forecast/out]

Each line: dish, recommended pounds, portions, low-high range, and one line of
"why" built from the forecast's inputs. A SIMULATED DATA banner prints on any
sheet whose forecasts came from simulated data. Open index.html and print.
"""

from __future__ import annotations

import argparse
import html
import json
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

from .db import Supabase
from .model import MODEL_VERSION

REPO = Path(__file__).resolve().parent.parent
MEAL_ORDER = {"breakfast": 0, "lunch": 1, "dinner": 2}

CSS = """
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 13pt/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: #000; background: #fff; margin: 24px; }
  h1 { font-size: 20pt; margin: 0 0 2px; }
  .meta { margin: 0 0 12px; font-size: 11pt; }
  .sim { border: 3px solid #000; padding: 6px 10px; font-weight: 700; letter-spacing: .02em; margin: 0 0 12px; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #000; padding: 7px 6px; text-align: left; vertical-align: top; }
  th { font-size: 10.5pt; text-transform: uppercase; letter-spacing: .03em; border-bottom: 2px solid #000; }
  td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.big { font-size: 16pt; font-weight: 700; }
  td.why { font-size: 10.5pt; width: 42%; }
  td.check { width: 70px; }
  .box { display: inline-block; width: 18px; height: 18px; border: 2px solid #000; }
  footer { margin-top: 14px; font-size: 9.5pt; }
  .sheet { page-break-after: always; }
  .sheet:last-child { page-break-after: auto; }
  @media print { body { margin: 0.4in; } a { color: #000; text-decoration: none; } nav { display: none; } }
  @page { size: letter portrait; margin: 0.4in; }
"""


def _fmt_lb(x: float | None) -> str:
    return "–" if x is None else f"{x:,.1f}"


def build_sheets(db: Supabase, hall_id: str, day: date) -> list[dict]:
    """[{meal, station, simulated, rows:[...]}] for one date."""
    forecasts = db.select(
        "forecast",
        {"hall_id": f"eq.{hall_id}", "service_date": f"eq.{day.isoformat()}", "model_version": f"eq.{MODEL_VERSION}"},
        "meal_label,dish_id,recommended_prep_lb,low_lb,high_lb,expected_diners,why,is_simulated,generated_at",
    )
    if not forecasts:
        return []
    dishes = {r["dish_id"]: r for r in db.select("dish", None, "dish_id,display_name,category,portion_lb,is_simulated")}
    stations: dict[tuple[str, str], str] = {}
    for r in db.select("menu_cycle", {"hall_id": f"eq.{hall_id}"}, "meal_label,dish_id,station"):
        if r.get("station"):
            stations[(r["meal_label"], r["dish_id"])] = r["station"]
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for f in forecasts:
        d = dishes.get(f["dish_id"], {})
        station = stations.get((f["meal_label"], f["dish_id"])) or d.get("category") or "Kitchen"
        prep = float(f["recommended_prep_lb"])
        portion = float(d["portion_lb"]) if d.get("portion_lb") else None
        groups[(f["meal_label"], station)].append({
            "dish": d.get("display_name") or f["dish_id"],
            "prep_lb": prep,
            "portions": round(prep / portion) if portion else None,
            "low_lb": float(f["low_lb"]) if f.get("low_lb") is not None else None,
            "high_lb": float(f["high_lb"]) if f.get("high_lb") is not None else None,
            "why": f.get("why") or "",
            "simulated": bool(f.get("is_simulated")) or bool(d.get("is_simulated")),
            "diners": f.get("expected_diners"),
            "generated_at": f.get("generated_at"),
        })
    sheets = []
    for (meal, station), rows in sorted(groups.items(), key=lambda kv: (MEAL_ORDER.get(kv[0][0], 9), kv[0][1])):
        rows.sort(key=lambda r: -r["prep_lb"])
        sheets.append({"meal": meal, "station": station, "simulated": any(r["simulated"] for r in rows), "rows": rows,
                       "diners": next((r["diners"] for r in rows if r["diners"]), None),
                       "generated_at": max((r["generated_at"] or "" for r in rows), default="")})
    return sheets


def render_sheet(hall_id: str, day: date, sheet: dict) -> str:
    e = html.escape
    sim = (
        '<p class="sim">Simulated data: these amounts come from made-up test data, not this kitchen. Do not prep from this sheet.</p>'
        if sheet["simulated"] else ""
    )
    lines = "\n".join(
        f"<tr><td>{e(r['dish'])}</td><td class='num big'>{_fmt_lb(r['prep_lb'])}</td>"
        f"<td class='num'>{r['portions'] if r['portions'] is not None else '–'}</td>"
        f"<td class='num'>{_fmt_lb(r['low_lb'])}–{_fmt_lb(r['high_lb'])}</td>"
        f"<td class='why'>{e(r['why'])}</td><td class='check'><span class='box' aria-label='made'></span></td></tr>"
        for r in sheet["rows"]
    )
    diners = f" · about {sheet['diners']:,} diners expected" if sheet.get("diners") else ""
    generated = sheet["generated_at"][:16].replace("T", " ") + " UTC" if sheet.get("generated_at") else ""
    return f"""<section class="sheet">
  <h1>Prep sheet: {e(sheet['station'])}, {e(sheet['meal'].title())}</h1>
  <p class="meta">{e(hall_id)} · {day.strftime('%A, %B %-d, %Y')}{diners}</p>
  {sim}
  <table>
    <thead><tr><th>Dish</th><th class="num">Prep (lb)</th><th class="num">Portions</th><th class="num">Likely range (lb)</th><th>Why</th><th>Made</th></tr></thead>
    <tbody>
{lines}
    </tbody>
  </table>
  <footer>Forecast {e(MODEL_VERSION)}{', generated ' + e(generated) if generated else ''}. Prep is set so each dish lasts the meal most of the time;
  the range is where demand usually lands. Write the actual pan leftover on the production sheet so the next forecast learns.</footer>
</section>"""


def write_sheets(hall_id: str, day: date, out_dir: Path, db: Supabase | None = None) -> dict:
    db = db or Supabase.from_env()
    sheets = build_sheets(db, hall_id, day)
    folder = out_dir / day.isoformat()
    folder.mkdir(parents=True, exist_ok=True)
    files = []
    for s in sheets:
        name = f"{s['meal']}-{''.join(c if c.isalnum() else '-' for c in s['station'].lower()).strip('-')}.html"
        page = f"<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><title>Prep sheet {html.escape(s['station'])} {s['meal']} {day}</title><style>{CSS}</style></head><body>{render_sheet(hall_id, day, s)}</body></html>"
        (folder / name).write_text(page)
        files.append(name)
    all_sheets = "\n".join(render_sheet(hall_id, day, s) for s in sheets) or "<p>No forecasts for this date. Run the forecast worker first.</p>"
    nav = "".join(f"<li><a href='{html.escape(f)}'>{html.escape(f)}</a></li>" for f in files)
    (folder / "index.html").write_text(
        f"<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><title>Prep sheets {day}</title><style>{CSS}</style></head>"
        f"<body><nav><p>Print this page for every station, or open one:</p><ul>{nav}</ul></nav>{all_sheets}</body></html>"
    )
    return {"hallId": hall_id, "date": day.isoformat(), "folder": str(folder), "sheets": len(sheets), "files": files,
            "simulated": any(s["simulated"] for s in sheets)}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m forecast.prep_sheet", description=__doc__.split("\n\n")[0])
    p.add_argument("--hall", default="hall-main")
    p.add_argument("--date", required=True, type=date.fromisoformat)
    p.add_argument("--out", type=Path, default=REPO / "forecast" / "out")
    a = p.parse_args(argv)
    print(json.dumps(write_sheets(a.hall, a.date, a.out), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
