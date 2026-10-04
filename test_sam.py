"""Smoke test: SAM 2.1 (hiera-tiny) on Apple Silicon.

Run with the project venv:  .venv/bin/python test_sam.py [--margin 0.25] [image or folder ...]
(default: images/; --margin is the box's inset from each edge as a fraction,
0.25 = the center half of the image; --point also adds a positive click at the
image center, which stops a loose box from selecting the background)

Loads SAM2ImagePredictor once on MPS (falls back to CPU if MPS fails at load
or inference), prompts each image with a box over its center, prints the
mask's pixel count and confidence, and saves the mask tinted red over the
image to images/masks/<name>_mask.jpg. No CUDA autocast: MPS/CPU run in
float32.
"""

import sys
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from sam2.sam2_image_predictor import SAM2ImagePredictor

MODEL_ID = "facebook/sam2.1-hiera-tiny"
OUT_DIR = Path("images/masks")
EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def image_paths(args: list[str]) -> list[Path]:
    paths: list[Path] = []
    for arg in args or ["images"]:
        p = Path(arg)
        paths += sorted(f for f in p.iterdir() if f.suffix.lower() in EXTS) if p.is_dir() else [p]
    return paths


MARGIN = 0.25
CENTER_POINT = False


def segment(predictor: SAM2ImagePredictor, image: np.ndarray):
    h, w = image.shape[:2]
    # Box prompt over the center of the image: [x0, y0, x1, y1] in pixels.
    box = np.array([w * MARGIN, h * MARGIN, w * (1 - MARGIN), h * (1 - MARGIN)])
    with torch.inference_mode():
        predictor.set_image(image)
        point = dict(point_coords=np.array([[w / 2, h / 2]]), point_labels=np.array([1])) if CENTER_POINT else {}
        masks, scores, _ = predictor.predict(box=box, multimask_output=False, **point)
    return masks[0].astype(bool), float(scores[0]), box


def load_and_check(device: str, image: np.ndarray) -> SAM2ImagePredictor:
    predictor = SAM2ImagePredictor.from_pretrained(MODEL_ID, device=device)
    segment(predictor, image)  # surface MPS op errors now, not mid-run
    return predictor


def main() -> None:
    global MARGIN, CENTER_POINT
    args = sys.argv[1:]
    while args[:1] in (["--margin"], ["--point"]):
        if args[0] == "--point":
            CENTER_POINT, args = True, args[1:]
        else:
            MARGIN, args = float(args[1]), args[2:]
    paths = image_paths(args)
    if not paths:
        sys.exit("No images found.")
    first = np.array(Image.open(paths[0]).convert("RGB"))

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    started = time.perf_counter()
    try:
        predictor = load_and_check(device, first)
    except Exception as err:  # MPS can fail on unsupported ops; retry on CPU.
        if device == "cpu":
            raise
        print(f"MPS failed ({type(err).__name__}: {err}); falling back to CPU")
        device = "cpu"
        predictor = load_and_check(device, first)
    print(f"device: {device} (model load + warm-up {time.perf_counter() - started:.1f}s)\n")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for path in paths:
        image = np.array(Image.open(path).convert("RGB"))
        t0 = time.perf_counter()
        mask, score, box = segment(predictor, image)
        elapsed = time.perf_counter() - t0
        h, w = image.shape[:2]
        pixels = int(mask.sum())

        tinted = image.astype(np.float32)
        tinted[mask] = 0.5 * tinted[mask] + 0.5 * np.array([255, 0, 0])
        suffix = ("" if MARGIN == 0.25 else f"_margin{MARGIN:g}") + ("_point" if CENTER_POINT else "")
        out = OUT_DIR / f"{path.stem}_mask{suffix}.jpg"
        Image.fromarray(tinted.astype(np.uint8)).save(out, quality=92)

        print(
            f"{path.name:16} {w}x{h}  box {[round(v) for v in box]}  "
            f"mask {pixels:,} px ({100 * pixels / (w * h):.1f}%)  confidence {score:.4f}  "
            f"{elapsed:.2f}s  -> {out}"
        )


if __name__ == "__main__":
    main()
