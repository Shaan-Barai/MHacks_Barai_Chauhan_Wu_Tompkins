"""An FSS (Food Service Suite) forecast export (CSV or XLSX) -> forecast rows with model_version = 'fss'.

    python3 -m forecast.importers.fss FILE --mapping MAPPING.toml [--hall hall-main] [--dry-run] [--out DIR]

Dishes are matched ONLY by exact normalized name: the dish's display name, the
menu item names linked to it, or an alias in the mapping's [aliases] table
("FSS recipe name" = "dish_id"). A dish that doesn't match goes to a review list
(`<file>.fss_unmatched.csv`, with up to 3 suggestions) and is not imported.
Dishes are never created. Amounts convert to pounds (`unit` column or
options.unit: lb, oz, kg, g, or portions × the dish's portion_lb).

Rows are written with is_simulated = false. Re-importing replaces the same
(hall, date, meal, dish) row. A row that would replace a SIMULATED FSS row is
skipped and reported. Once real FSS rows are all a hall's comparison has, the
Forecast page and `forecast.evaluate` call it plain "FSS".
"""

from __future__ import annotations

import argparse
import csv
import difflib
from datetime import datetime, timezone
from pathlib import Path

from .common import ImportError_, Report, load_mapping, norm_name, parse_date, parse_number, read_table, resolve_columns
from .swipes import parse_meal

UNIT_TO_LB = {"lb": 1.0, "lbs": 1.0, "pound": 1.0, "pounds": 1.0, "oz": 1 / 16, "ounce": 1 / 16, "ounces": 1 / 16,
              "kg": 2.20462262, "g": 0.00220462262, "gram": 0.00220462262, "grams": 0.00220462262}
PORTION_UNITS = {"portion", "portions", "serving", "servings", "each", "ea", "pc", "pcs"}


def dish_index(db, mapping: dict) -> tuple[dict[str, set[str]], dict[str, dict]]:
    """normalized name -> dish ids (several = ambiguous), and dish rows by id."""
    dishes = {d["dish_id"]: d for d in db.select("dish", columns="dish_id,display_name,portion_lb,is_simulated")}
    index: dict[str, set[str]] = {}

    def add(name, dish_id):
        if name and dish_id in dishes:
            index.setdefault(norm_name(name), set()).add(dish_id)

    for d in dishes.values():
        add(d["display_name"], d["dish_id"])
    for m in db.select("menu_item", {"dish_id": "not.is.null"}, "display_name,dish_id"):
        add(m["display_name"], m["dish_id"])
    for alias, dish_id in (mapping.get("aliases") or {}).items():
        if dish_id not in dishes:
            raise ImportError_(f"[aliases] {alias!r} points at unknown dish {dish_id!r}")
        add(alias, dish_id)
    return index, dishes


def run(path: Path, mapping_path: Path, *, db, hall: str | None = None, dry_run: bool = False, out_dir: Path | None = None) -> Report:
    mapping = load_mapping(mapping_path)
    opts = mapping.get("options") or {}
    report = Report("fss", str(path), dry_run)
    rows = read_table(path, opts.get("sheet"))
    cols = resolve_columns(rows, mapping, ["date", "meal", "dish", "amount"], ["hall", "unit"])
    if "hall" not in cols and not hall:
        raise ImportError_("no `hall` column in the mapping: pass --hall")
    known_halls = {h["hall_id"] for h in db.select("hall", columns="hall_id")}
    if hall and hall not in known_halls:
        raise ImportError_(f"--hall {hall} is not a known hall")
    hall_map = {norm_name(k): v for k, v in (mapping.get("halls") or {}).items()}
    index, dishes = dish_index(db, mapping)
    report.rows_read = len(rows)
    out: dict[tuple, dict] = {}
    unmatched: dict[str, dict] = {}
    now = datetime.now(timezone.utc).isoformat()
    for i, r in enumerate(rows, start=2):
        h = hall
        if "hall" in cols:
            raw = r[cols["hall"]].strip()
            h = hall_map.get(norm_name(raw)) or (raw if raw in known_halls else None)
            if h is None:
                report.error(i, "unknown_hall", f"hall {raw!r} is not known; add it under [halls]", value=raw)
                continue
        d = parse_date(r[cols["date"]], opts.get("date_format"))
        if d is None:
            report.error(i, "bad_date", f"could not read date {r[cols['date']]!r}")
            continue
        meal = parse_meal(r[cols["meal"]], mapping)
        if meal is None:
            report.error(i, "bad_meal", f"meal {r[cols['meal']]!r} is not breakfast/lunch/dinner; map it under [meals]")
            continue
        raw_dish = r[cols["dish"]].strip()
        hits = index.get(norm_name(raw_dish), set())
        if len(hits) != 1:
            u = unmatched.setdefault(norm_name(raw_dish), {"fss_name": raw_dish, "rows": 0, "first_line": i,
                                                           "reason": "ambiguous" if hits else "no match",
                                                           "candidates": sorted(hits),
                                                           "suggestions": difflib.get_close_matches(norm_name(raw_dish), list(index), n=3, cutoff=0.6)})
            u["rows"] += 1
            continue
        dish_id = next(iter(hits))
        amount = parse_number(r[cols["amount"]])
        if amount is None or amount < 0:
            report.error(i, "bad_amount", f"amount {r[cols['amount']]!r} is not a non-negative number")
            continue
        unit = norm_name(r[cols["unit"]]) if "unit" in cols else norm_name(opts.get("unit", "lb"))
        if unit in UNIT_TO_LB:
            lb = amount * UNIT_TO_LB[unit]
        elif unit in PORTION_UNITS:
            portion = dishes[dish_id].get("portion_lb")
            if portion is None:
                report.error(i, "no_portion_weight", f"{raw_dish}: amount is in portions but the dish has no portion_lb")
                continue
            lb = amount * float(portion)
        else:
            report.error(i, "bad_unit", f"unit {unit!r} is not lb, oz, kg, g or portions")
            continue
        if lb > 5000:
            report.error(i, "impossible_amount", f"{lb:.0f} lb for one dish and meal")
            continue
        key = (h, d.isoformat(), meal, dish_id)
        if key in out:
            report.warn(i, "duplicate_row", f"{raw_dish} {d} {meal} appears twice; the later row is kept")
        out[key] = {"hall_id": h, "service_date": d.isoformat(), "meal_label": meal, "dish_id": dish_id,
                    "fss_forecast_lb": round(lb, 2), "model_version": "fss", "basis": "fss", "is_simulated": False,
                    "why": f"Imported FSS forecast ({Path(path).name}: {raw_dish})", "generated_at": now}
    report.review = sorted(unmatched.values(), key=lambda u: -u["rows"])
    rows_out = list(out.values())
    if rows_out:
        halls = sorted({r["hall_id"] for r in rows_out})
        sim = {(x["hall_id"], x["service_date"][:10], x["meal_label"], x["dish_id"]) for x in db.select(
            "forecast", {"hall_id": f"in.({','.join(halls)})", "model_version": "eq.fss", "is_simulated": "eq.true"},
            "hall_id,service_date,meal_label,dish_id")}
        clash = [r for r in rows_out if (r["hall_id"], r["service_date"], r["meal_label"], r["dish_id"]) in sim]
        if clash:
            report.warn(None, "simulated_rows_present", f"{len(clash)} rows would replace SIMULATED FSS rows and were skipped "
                        f"(remove the simulated data first: python3 -m forecast.simulate remove --hall {clash[0]['hall_id']})")
            rows_out = [r for r in rows_out if r not in clash]
    report.summary = {"forecast rows": len(rows_out), "dishes matched": len({r["dish_id"] for r in rows_out}),
                      "unmatched dish names (review)": len(report.review), "total lb": round(sum(r["fss_forecast_lb"] for r in rows_out), 1),
                      "is_simulated": False}
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
        with open(out_dir / f"{Path(path).stem}.fss_unmatched.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["fss_name", "rows", "first_line", "reason", "candidates", "suggestions", "dish_id_to_use"])
            for u in report.review:
                w.writerow([u["fss_name"], u["rows"], u["first_line"], u["reason"], " | ".join(u["candidates"]), " | ".join(u["suggestions"]), ""])
        report.write(out_dir, Path(path).stem + ".fss")
    if not dry_run and rows_out:
        db.insert("forecast", rows_out, on_conflict="hall_id,service_date,meal_label,dish_id,model_version", upsert=True)
    report.rows_written = len(rows_out)
    return report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m forecast.importers.fss", description=__doc__.split("\n\n")[0])
    p.add_argument("file", type=Path)
    p.add_argument("--mapping", type=Path, required=True)
    p.add_argument("--hall")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--out", type=Path, default=Path("forecast/out/imports"))
    a = p.parse_args(argv)
    from ..db import Supabase
    try:
        report = run(a.file, a.mapping, db=Supabase.from_env(), hall=a.hall, dry_run=a.dry_run, out_dir=a.out)
    except ImportError_ as e:
        print(f"not imported: {e}")
        return 2
    print(report.text())
    return 1 if report.errors or report.review else 0


if __name__ == "__main__":
    raise SystemExit(main())
