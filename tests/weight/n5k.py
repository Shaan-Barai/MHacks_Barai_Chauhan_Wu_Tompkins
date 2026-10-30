"""Nutrition5k weight test (Run 6): does area × grams-per-cm² predict scale grams?

Data: Nutrition5k (Thames et al., CVPR 2021; Google, CC BY 4.0,
https://github.com/google-research-datasets/Nutrition5k). Only metadata/,
dish_ids/ and a sample of imagery/realsense_overhead/ are downloaded, into the
gitignored images/nutrition5k/. Everything here is "Nutrition5k full plates,
not leftovers".

    .venv/bin/python tests/weight/n5k.py select      # pick dishes, write the sample + split
    .venv/bin/python tests/weight/n5k.py download    # rgb.png + depth_raw.png per sampled dish
    .venv/bin/python tests/weight/n5k.py masks       # stand-in food masks (colour + depth), overlays
    .venv/bin/python tests/weight/n5k.py evaluate    # factors on the fit half, errors on the test half

The pure functions (selection, split, pixel area, fitting, error metrics) use
only the standard library and are unit-tested in test_n5k.py. Image work
(masks, depth volume) needs numpy + Pillow (the repo .venv).
"""

from __future__ import annotations

import csv
import json
import math
import random
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ROOT = REPO / "images" / "nutrition5k"
OUT = ROOT / "out"
BUCKET = "https://storage.googleapis.com/nutrition5k_dataset/nutrition5k_dataset"
FACTORS_CSV = REPO / "factors" / "menu_waste_factors_EastQuad.csv"
SEED = 42
PER_TYPE = 10

# Camera geometry. Sources:
#  * 35.9 cm camera-to-capture-plane distance: Nutrition5k paper §4.4
#    (https://arxiv.org/abs/2103.03375, read via https://ar5iv.arxiv.org/html/2103.03375).
#  * Intel RealSense D435 RGB sensor FOV 69.4° × 42.5° (± 3°) at 16:9 (1920 × 1080):
#    https://www.intel.com/content/www/us/en/support/articles/000030385.html
#    rgb.png is 640 × 480 (4:3), i.e. the 1440 × 1080 centre of the 16:9 sensor scaled by 4/9,
#    so f = (1080 / 2) / tan(42.5° / 2) × 4/9 in 640 × 480 pixels.
CAMERA_HEIGHT_CM = 35.9
RGB_VFOV_DEG = 42.5
IMAGE_H = 480
# The paper's own per-pixel area at 35.9 cm (§4.4). Not used for the estimates; reported beside ours.
PAPER_PIXEL_AREA_CM2 = 5.957e-3

# Sauces/oils/dressings etc. under 10 g are skipped (not reliably visible from above).
SKIP_WORDS = ("oil", "dressing", "sauce", "vinegar", "salt", "pepper", "butter", "gravy", "mayo", "ketchup",
              "mustard", "syrup", "honey", "salsa", "spice", "garlic", "herbs", "parsley", "juice", "vinaigrette",
              "soy", "hummus", "jam", "sugar", "cilantro", "seasoning")
SKIP_UNDER_G = 10.0
DOMINANT_SHARE = 0.85

# Nutrition5k ingredient name → (food type, the factors CSV food it is compared with).
# Only clear matches; everything else is left out of the sample (logged by `select`).
FOOD_TYPES = {
    "cauliflower": ("cauliflower", "Roasted Cauliflower"),
    "cheese pizza": ("pizza", "Cheese Pizza"),
    "pepperoni pizza": ("pizza", "Pepperoni Pizza"),
    "cherry tomatoes": ("tomatoes", "Tomatoes"),
    "sweet potato": ("sweet potato", "Baked Sweet Potatoes"),
    "yam": ("sweet potato", "Baked Sweet Potatoes"),
    "brussels sprouts": ("brussels sprouts", "Shaved Brussel Sprouts"),
    "mixed greens": ("greens", "Lettuce"),
    "potatoes": ("potatoes", "Oven Roasted Garlic Potatoes"),
    "roasted potatoes": ("potatoes", "Oven Roasted Garlic Potatoes"),
}
# Dish IDs are dish_<unix seconds>. Scans this close together are the same plate scanned
# incrementally, so they share one group and never land on both sides of the split.
SAME_PLATE_GAP_S = 300


def focal_px(vfov_deg: float = RGB_VFOV_DEG, image_h: int = IMAGE_H) -> float:
    return (image_h / 2) / math.tan(math.radians(vfov_deg / 2))


def pixel_area_cm2(distance_cm: float = CAMERA_HEIGHT_CM, f_px: float | None = None) -> float:
    """Area of one pixel on a plane `distance_cm` from a pinhole camera with focal length f (px)."""
    f = f_px or focal_px()
    return (distance_cm / f) ** 2


def parse_dishes(path: Path) -> dict[str, dict]:
    """dish_metadata_cafe*.csv: dish_id, cal, mass, fat, carb, protein, then 7 fields per ingredient."""
    out = {}
    with open(path, newline="") as f:
        for row in csv.reader(f):
            if not row or not row[0].startswith("dish_"):
                continue
            n = (len(row) - 6) // 7
            ings = [{"id": row[6 + 7 * i], "name": row[7 + 7 * i], "grams": float(row[8 + 7 * i])} for i in range(n)]
            out[row[0]] = {"dish_id": row[0], "total_g": float(row[2]), "ingredients": ings}
    return out


def is_skipped(ing: dict) -> bool:
    return ing["grams"] < SKIP_UNDER_G and any(w in ing["name"] for w in SKIP_WORDS)


def classify(dish: dict) -> dict | None:
    """The dish's dominant visible food, if one ingredient is ≥ 85% of the visible grams."""
    visible = [i for i in dish["ingredients"] if not is_skipped(i)]
    skipped = [i for i in dish["ingredients"] if is_skipped(i)]
    vg = sum(i["grams"] for i in visible)
    if vg <= 0:
        return None
    top = max(visible, key=lambda i: i["grams"])
    if top["grams"] < DOMINANT_SHARE * vg or top["name"] not in FOOD_TYPES:
        return None
    food_type, csv_food = FOOD_TYPES[top["name"]]
    return {
        "dish_id": dish["dish_id"], "ingredient": top["name"], "food_type": food_type, "csv_food": csv_food,
        "visible_g": round(vg, 2), "dominant_g": round(top["grams"], 2), "total_g": dish["total_g"],
        "other_visible": [f'{i["name"]} {i["grams"]:.1f} g' for i in visible if i is not top],
        "skipped": [f'{i["name"]} {i["grams"]:.1f} g' for i in skipped],
    }


def plate_groups(all_ids: list[str]) -> dict[str, str]:
    """dish id → group id (first dish of a run of scans less than SAME_PLATE_GAP_S apart)."""
    ts = sorted((int(d.split("_")[1]), d) for d in all_ids)
    groups, head, prev = {}, None, None
    for t, d in ts:
        if prev is None or t - prev >= SAME_PLATE_GAP_S:
            head = d
        groups[d] = head
        prev = t
    return groups


def select_sample(candidates: list[dict], groups: dict[str, str], per_type: int = PER_TYPE, seed: int = SEED) -> list[dict]:
    """Up to `per_type` dishes per food type, one per plate group, chosen with a fixed seed;
    then split 50/50 by dish id within each food type (fixed seed): 'fit' and 'test'."""
    rng = random.Random(seed)
    by_type: dict[str, list[dict]] = {}
    for c in sorted(candidates, key=lambda c: c["dish_id"]):
        by_type.setdefault(c["food_type"], []).append(c)
    sample = []
    for ft in sorted(by_type):
        pool = by_type[ft][:]
        rng.shuffle(pool)
        seen, chosen = set(), []
        for c in pool:
            g = groups.get(c["dish_id"], c["dish_id"])
            if g in seen:
                continue
            seen.add(g)
            chosen.append(c)
            if len(chosen) == per_type:
                break
        ids = sorted(c["dish_id"] for c in chosen)
        rng.shuffle(ids)
        fit = set(ids[: len(ids) // 2])
        for c in sorted(chosen, key=lambda c: c["dish_id"]):
            sample.append({**c, "half": "fit" if c["dish_id"] in fit else "test", "plate_group": groups.get(c["dish_id"])})
    return sample


def fit_ratio(pairs: list[tuple[float, float]]) -> float | None:
    """Least-squares factor k through the origin for y ≈ k·x: Σxy / Σx²."""
    sxx = sum(x * x for x, _ in pairs)
    return sum(x * y for x, y in pairs) / sxx if sxx > 0 else None


def errors(rows: list[tuple[float, float]]) -> dict:
    """rows of (estimated g, scale g) → n, mean absolute error (g), mean absolute % error, bias (g and %)."""
    rows = [(e, t) for e, t in rows if e is not None and t > 0]
    if not rows:
        return {"n": 0, "mae_g": None, "mape_pct": None, "bias_g": None, "bias_pct": None}
    n = len(rows)
    return {
        "n": n,
        "mae_g": round(sum(abs(e - t) for e, t in rows) / n, 1),
        "mape_pct": round(100 * sum(abs(e - t) / t for e, t in rows) / n, 1),
        "bias_g": round(sum(e - t for e, t in rows) / n, 1),
        "bias_pct": round(100 * sum((e - t) / t for e, t in rows) / n, 1),
    }


def csv_factors(path: Path = FACTORS_CSV) -> dict[str, float]:
    with open(path, newline="") as f:
        return {r["food"]: float(r["weight_g_per_cm2"]) for r in csv.DictReader(f) if r.get("weight_g_per_cm2")}


# ---------------------------------------------------------------- commands

def cmd_select() -> None:
    meta = ROOT / "metadata"
    dishes = parse_dishes(meta / "dish_metadata_cafe1.csv")
    depth_ids = set()
    for f in ("depth_train_ids.txt", "depth_test_ids.txt"):
        depth_ids |= {l.strip() for l in open(ROOT / "dish_ids" / "splits" / f) if l.strip()}
    groups = plate_groups(list(dishes))
    candidates, unmapped = [], {}
    for d in sorted(depth_ids & set(dishes)):
        c = classify(dishes[d])
        if c:
            candidates.append(c)
        else:
            dish = dishes[d]
            vis = [i for i in dish["ingredients"] if not is_skipped(i)]
            if vis:
                top = max(vis, key=lambda i: i["grams"])
                if top["grams"] >= DOMINANT_SHARE * sum(i["grams"] for i in vis):
                    unmapped[top["name"]] = unmapped.get(top["name"], 0) + 1
    sample = select_sample(candidates, groups)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "sample.json").write_text(json.dumps({
        "seed": SEED, "per_type": PER_TYPE, "dominant_share": DOMINANT_SHARE, "skip_under_g": SKIP_UNDER_G,
        "food_types": FOOD_TYPES, "candidates_per_type": _count(candidates, "food_type"),
        "dominant_but_unmapped": dict(sorted(unmapped.items(), key=lambda kv: -kv[1])), "sample": sample,
    }, indent=1))
    print(f"{len(candidates)} candidate dishes, {len(sample)} sampled "
          f"({sum(s['half'] == 'fit' for s in sample)} fit / {sum(s['half'] == 'test' for s in sample)} test)")
    for ft, n in _count(sample, "food_type").items():
        print(f"  {ft}: {n}")


def _count(rows: list[dict], key: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in rows:
        out[r[key]] = out.get(r[key], 0) + 1
    return dict(sorted(out.items()))


def _ssl_context():
    """Verified TLS; python.org macOS builds may lack CA certificates, so fall back to the system bundle."""
    import ssl

    ctx = ssl.create_default_context()
    if ctx.cert_store_stats().get("x509_ca", 0) == 0 and Path("/etc/ssl/cert.pem").exists():
        ctx.load_verify_locations("/etc/ssl/cert.pem")
    return ctx


def cmd_download() -> None:
    sample = json.loads((OUT / "sample.json").read_text())["sample"]
    for s in sample:
        d = ROOT / "imagery" / s["dish_id"]
        d.mkdir(parents=True, exist_ok=True)
        for f in ("rgb.png", "depth_raw.png"):
            p = d / f
            if p.exists() and p.stat().st_size > 0:
                continue
            url = f"{BUCKET}/imagery/realsense_overhead/{s['dish_id']}/{f}"
            with urllib.request.urlopen(url, timeout=60, context=_ssl_context()) as r:
                p.write_bytes(r.read())
    print(f"{len(sample)} dishes present under {ROOT / 'imagery'}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "select":
        cmd_select()
    elif cmd == "download":
        cmd_download()
    elif cmd in ("masks", "evaluate"):
        from n5k_image import cmd_evaluate, cmd_masks  # numpy + Pillow

        (cmd_masks if cmd == "masks" else cmd_evaluate)()
    else:
        print(__doc__)
        raise SystemExit(2)
