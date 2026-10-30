"""Image half of the Nutrition5k weight test: food masks, areas, depth volumes, evaluation.

Needs numpy, scipy and Pillow (the repo .venv) and, for `masks`, the SAM 2.1
worker (`.venv/bin/python vision/sam/worker.py`, :8790).

STAND-IN MASKS (Run 6): Gemini was unavailable (HTTP 402, prepaid credits
depleted), so the boxes SAM receives come from a colour + depth heuristic
instead of Gemini. SAM itself runs with the pipeline's default settings
(sam2-box-v1, one box per food piece). Each dish has one dominant food, so no
classification is needed: the whole food mask is that food.

Heuristic boxes, per dish (640 × 480 rgb.png, depth_raw.png in 1e-4 m), described in
docs/weight-accuracy.md → Method → 3:
  1. plate = the raised region (nearer than 39 cm) under the image centre, holes filled;
  2. plate level Z0 = 85th-percentile depth of its inner part;
  3. food candidates: chromaticity far from the plate's, or saturated; plus raised
     (≥ 8 mm) pixels away from the rim that differ slightly in colour (white foods);
  4. drop regions < 150 px, mostly in the rim band, or plate-coloured on average;
  5. one box per region → SAM; union of SAM masks inside the plate. A SAM mask more
     than 2.5× its region (SAM took the plate) is replaced by the region (`sam_rejected`).
"""

from __future__ import annotations

import base64
import io
import json
import urllib.request

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import ConvexHull, Delaunay

from n5k import (CAMERA_HEIGHT_CM, OUT, PAPER_PIXEL_AREA_CM2, ROOT, csv_factors, errors, fit_ratio, focal_px,
                 pixel_area_cm2)

SAM_URL = "http://127.0.0.1:8790"
DEPTH_UNIT_MM = 0.1  # 1e-4 m per unit (Nutrition5k README and paper §3.5)
FOOD_HEIGHT_MM = 8.0
RIM_MARGIN_PX = 25
MIN_REGION_PX = 150
SUPPORT_MAX_MM = 390.0
CHROMA_FOOD = 0.045
CHROMA_RAISED = 0.012
RIM_BAND_PX = 20
RIM_BAND_SHARE = 0.7
REGION_MIN_CHROMA = 0.04


def hsv(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    x = rgb.astype(float) / 255
    mx, mn = x.max(axis=2), x.min(axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    return sat, mx


def convex_fill(mask: np.ndarray) -> np.ndarray:
    ys, xs = np.nonzero(mask)
    if len(xs) < 3:
        return mask
    pts = np.column_stack([xs, ys])
    hull = Delaunay(pts[ConvexHull(pts).vertices])
    gy, gx = np.mgrid[0 : mask.shape[0], 0 : mask.shape[1]]
    return hull.find_simplex(np.column_stack([gx.ravel(), gy.ravel()])).reshape(mask.shape) >= 0


def plate_and_level(rgb: np.ndarray, depth: np.ndarray) -> tuple[np.ndarray, float | None]:
    """The plate (with its food) = the raised region under the image centre: valid depth nearer than
    SUPPORT_MAX_MM (the plate sits on the scale ~36 cm from the camera; the floor around it is ~41 cm).
    Depth holes inside it are filled. Plate level Z0 = the 85th percentile depth of its inner part
    (the plate floor is the farthest common surface; food and rims are nearer)."""
    near = (depth > 0) & (depth * DEPTH_UNIT_MM < SUPPORT_MAX_MM)
    near = ndimage.binary_opening(near, iterations=3)
    lab, n = ndimage.label(near)
    if n == 0:
        return np.zeros_like(near), None
    h, w = near.shape
    centre = lab[h // 2 - 60 : h // 2 + 60, w // 2 - 60 : w // 2 + 60]
    ids, counts = np.unique(centre[centre > 0], return_counts=True)
    if not len(ids):
        return np.zeros_like(near), None
    plate = ndimage.binary_fill_holes(ndimage.binary_closing(lab == int(ids[np.argmax(counts)]), iterations=6))
    inner = ndimage.binary_erosion(plate, iterations=15) & (depth > 0)
    return plate, float(np.percentile(depth[inner], 85)) if inner.sum() > 500 else None


def chroma(rgb: np.ndarray) -> np.ndarray:
    x = rgb.astype(float) + 1
    return x / x.sum(axis=2, keepdims=True)


def candidates(rgb: np.ndarray, depth: np.ndarray, plate: np.ndarray, z0: float | None) -> np.ndarray:
    """Food-coloured pixels on the plate: chromaticity (shading-independent) far from the plate's own
    colour, or saturated; plus raised pixels (≥ 8 mm above Z0) away from the rim whose colour differs
    at least slightly (white foods such as cauliflower)."""
    if z0 is None:
        return np.zeros_like(plate)
    height_mm = np.where(depth > 0, (z0 - depth) * DEPTH_UNIT_MM, 0)
    body = ndimage.binary_erosion(plate, iterations=6)
    floor = body & (np.abs(height_mm) < 3)
    if floor.sum() < 200:
        return np.zeros_like(plate)
    c = chroma(rgb)
    dist = np.linalg.norm(c - np.median(c[floor], axis=0), axis=2)
    sat, _ = hsv(rgb)
    food = body & ((dist > CHROMA_FOOD) | (sat > 0.35))
    inner = ndimage.binary_erosion(plate, iterations=RIM_MARGIN_PX)
    food |= inner & (height_mm >= FOOD_HEIGHT_MM) & (dist > CHROMA_RAISED)
    food = ndimage.binary_opening(food, iterations=2)
    lab, n = ndimage.label(food)
    # Rim shading and glare: drop regions lying mostly in the plate's outer band.
    band = plate & ~ndimage.binary_erosion(plate, iterations=RIM_BAND_PX)
    sizes = ndimage.sum(food, lab, range(1, n + 1))
    in_band = ndimage.sum(band, lab, range(1, n + 1))
    keep = [i + 1 for i in range(n) if sizes[i] >= MIN_REGION_PX and in_band[i] <= RIM_BAND_SHARE * sizes[i]]
    if not keep:
        return np.zeros_like(plate)
    # Rim shading/glare regions are raised but plate-coloured on average (region mean chromaticity
    # within 0.035 of the plate's on the 12 dishes checked; food regions, cauliflower included, ≥ 0.042).
    plate_c = np.median(c[floor], axis=0)
    keep = [i for i in keep if np.linalg.norm(c[lab == i].mean(axis=0) - plate_c) >= REGION_MIN_CHROMA]
    return np.isin(lab, keep)


def sam_masks(rgb: np.ndarray, boxes: list[list[int]]) -> list[np.ndarray]:
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="PNG")
    body = json.dumps({"image_b64": base64.b64encode(buf.getvalue()).decode(), "boxes": boxes}).encode()
    req = urllib.request.Request(f"{SAM_URL}/segment", data=body, method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        res = json.loads(r.read())
    return [np.array(Image.open(io.BytesIO(base64.b64decode(m["maskPngB64"])))) > 0 for m in res["results"]]


def food_mask(rgb: np.ndarray, depth: np.ndarray) -> dict:
    plate, z0 = plate_and_level(rgb, depth)
    cand = candidates(rgb, depth, plate, z0)
    lab, n = ndimage.label(cand)
    regions = ndimage.find_objects(lab)
    h, w = cand.shape
    boxes = [[max(0, s[1].start - 4), max(0, s[0].start - 4), min(w, s[1].stop + 4), min(h, s[0].stop + 4)] for s in regions]
    mask = np.zeros_like(cand)
    flags = []
    if boxes:
        for i, m in enumerate(sam_masks(rgb, boxes)):
            region = lab == i + 1
            if m.sum() > 2.5 * region.sum():
                flags.append("sam_rejected")
                mask |= region
            else:
                mask |= m & plate
    return {"mask": mask, "plate": plate, "z0": z0, "boxes": boxes, "candidates": cand, "flags": sorted(set(flags))}


def depth_volume_cm3(depth: np.ndarray, mask: np.ndarray, z0: float | None, f_px: float) -> float | None:
    """Σ height × per-pixel area at that pixel's own distance, over the mask. Pixels with no depth
    get the median height of the mask's valid pixels."""
    if z0 is None or mask.sum() == 0:
        return None
    valid = mask & (depth > 0)
    if valid.sum() < 0.3 * mask.sum():
        return None
    z_cm = depth * DEPTH_UNIT_MM / 10
    h_cm = np.clip((z0 - depth) * DEPTH_UNIT_MM / 10, 0, None)
    area = (z_cm / f_px) ** 2
    vol = float((h_cm[valid] * area[valid]).sum())
    missing = int(mask.sum() - valid.sum())
    if missing:
        vol += missing * float(np.median(h_cm[valid])) * (z0 * DEPTH_UNIT_MM / 10 / f_px) ** 2
    return vol


def overlay(rgb: np.ndarray, r: dict, path) -> None:
    im = Image.fromarray(rgb).convert("RGBA")
    layer = np.zeros((*rgb.shape[:2], 4), np.uint8)
    layer[r["mask"]] = (0, 255, 0, 110)
    edge = r["plate"] & ~ndimage.binary_erosion(r["plate"], iterations=2)
    layer[edge] = (0, 120, 255, 255)
    im = Image.alpha_composite(im, Image.fromarray(layer))
    d = ImageDraw.Draw(im)
    for b in r["boxes"]:
        d.rectangle(b, outline=(255, 0, 0, 255))
    im.convert("RGB").save(path)


def cmd_masks() -> None:
    sample = json.loads((OUT / "sample.json").read_text())["sample"]
    f = focal_px()
    rows = []
    (OUT / "overlays").mkdir(parents=True, exist_ok=True)
    for s in sample:
        d = ROOT / "imagery" / s["dish_id"]
        rgb = np.array(Image.open(d / "rgb.png").convert("RGB"))
        depth = np.array(Image.open(d / "depth_raw.png")).astype(float)
        r = food_mask(rgb, depth)
        overlay(rgb, r, OUT / "overlays" / f"{s['dish_id']}.png")
        px = int(r["mask"].sum())
        rows.append({
            "dish_id": s["dish_id"], "food_type": s["food_type"], "half": s["half"], "visible_g": s["visible_g"],
            "mask_px": px, "area_cm2": round(px * pixel_area_cm2(CAMERA_HEIGHT_CM, f), 2),
            "plate_level_cm": round(r["z0"] * DEPTH_UNIT_MM / 10, 2) if r["z0"] else None,
            "volume_cm3": _r(depth_volume_cm3(depth, r["mask"], r["z0"], f)), "boxes": len(r["boxes"]), "flags": r["flags"],
        })
        print(rows[-1])
    (OUT / "measurements.json").write_text(json.dumps({"focal_px": f, "pixel_area_cm2": pixel_area_cm2(), "rows": rows}, indent=1))


def _r(x):
    return None if x is None else round(x, 2)


def cmd_evaluate() -> None:
    meas = json.loads((OUT / "measurements.json").read_text())
    sample = {s["dish_id"]: s for s in json.loads((OUT / "sample.json").read_text())["sample"]}
    excluded = json.loads((OUT / "excluded.json").read_text()) if (OUT / "excluded.json").exists() else {}
    rows = [r for r in meas["rows"] if r["dish_id"] not in excluded and r["mask_px"] > 0]
    csvf = csv_factors()
    types = sorted({r["food_type"] for r in rows})
    fit = {r["dish_id"] for r in rows if r["half"] == "fit"}
    measured, density = {}, {}
    for t in types:
        tr = [r for r in rows if r["food_type"] == t and r["dish_id"] in fit]
        measured[t] = fit_ratio([(r["area_cm2"], r["visible_g"]) for r in tr])
        density[t] = fit_ratio([(r["volume_cm3"], r["visible_g"]) for r in tr if r["volume_cm3"] is not None])
    test = [r for r in rows if r["dish_id"] not in fit]
    per_dish, by = [], {}
    for r in test:
        t = r["food_type"]
        cf = csvf.get(sample[r["dish_id"]]["csv_food"])
        est = {
            "csv": r["area_cm2"] * cf if cf else None,
            "measured": r["area_cm2"] * measured[t] if measured[t] else None,
            "depth": r["volume_cm3"] * density[t] if (density[t] and r["volume_cm3"] is not None) else None,
        }
        per_dish.append({**r, "csv_food": sample[r["dish_id"]]["csv_food"], "csv_factor": cf,
                         **{f"est_{k}_g": _r(v) for k, v in est.items()}})
        for k, v in est.items():
            by.setdefault(k, {}).setdefault(t, []).append((v, r["visible_g"]))
    result = {
        "label": "Nutrition5k full plates, not leftovers",
        "masks": "stand-in: colour + depth heuristic boxes → SAM 2.1 (sam2-box-v1); not Gemini",
        "pixel_area_cm2_at_35_9cm": meas["pixel_area_cm2"], "paper_pixel_area_cm2": PAPER_PIXEL_AREA_CM2,
        "focal_px": meas["focal_px"], "excluded": excluded,
        "fit_dishes": len([r for r in rows if r["dish_id"] in fit]), "test_dishes": len(test),
        "factors": {t: {"csv_food": next(sample[r["dish_id"]]["csv_food"] for r in rows if r["food_type"] == t),
                        "csv_g_per_cm2": csvf.get(next(sample[r["dish_id"]]["csv_food"] for r in rows if r["food_type"] == t)),
                        "measured_g_per_cm2": _r3(measured[t]), "measured_density_g_per_cm3": _r3(density[t])} for t in types},
        "errors": {k: {**{t: errors(v) for t, v in sorted(d.items())},
                       "overall": errors([x for v in d.values() for x in v])} for k, d in by.items()},
        "test_dishes_detail": per_dish,
    }
    (OUT / "weight_results.json").write_text(json.dumps(result, indent=1))
    print(json.dumps({k: result[k] for k in ("fit_dishes", "test_dishes", "factors", "errors")}, indent=1))


def _r3(x):
    return None if x is None else round(x, 3)

