"""SAM 2.1 segmentation worker (MVP_AI.md "Runtime and contract proposal").

A small local HTTP service the TypeScript vision adapter calls after Gemini
classification. It loads the model once, serializes predictions (one shared
predictor => one image embedding at a time, so concurrent captures can never
reuse each other's embeddings), and returns one full-canvas binary PNG mask
per box prompt.

    .venv/bin/python vision/sam/worker.py          # http://127.0.0.1:8790

POST /segment  {"image_b64": "<jpeg/png bytes>", "boxes": [[x0, y0, x1, y1], ...]}
  -> {"widthPx", "heightPx", "model", "checkpoint", "codeRevision", "device",
      "settingsVersion", "results": [{"maskPngB64", "score", "foregroundPx"}]}
GET  /health   -> model/device/settings info (no token needed; no image data)

Env: SAM_MODEL_ID, SAM_DEVICE, SAM_PORT (8790), WORKER_HOST (127.0.0.1;
SAM_HOST also accepted), WORKER_TOKEN (optional; when set, POST requests must
send a matching X-Worker-Token header or get 401).

Boxes are pixel XYXY on the supplied image (the caller converts Gemini's
[ymin, xmin, ymax, xmax] 0-1000 boxes). Masks are lossless 8-bit PNGs at the
image's exact dimensions, foreground 255 and background 0.

Settings "sam2-box-v1": multimask_output=False, binary threshold at logit
0.0 (the predictor's mask_threshold), no hole filling, no small-component
removal. No CUDA autocast: MPS/CPU run in float32.
"""

from __future__ import annotations

import base64
import hmac
import io
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import torch
from PIL import Image

import sam2
from sam2.sam2_image_predictor import SAM2ImagePredictor

MODEL_ID = os.environ.get("SAM_MODEL_ID", "facebook/sam2.1-hiera-small")
HOST = os.environ.get("WORKER_HOST") or os.environ.get("SAM_HOST") or "127.0.0.1"
PORT = int(os.environ.get("SAM_PORT", "8790"))
TOKEN = os.environ.get("WORKER_TOKEN") or ""
SETTINGS_VERSION = "sam2-box-v1"
MAX_BODY_BYTES = 25 * 1024 * 1024
MAX_PIXELS = 4096 * 4096
MAX_BOXES = 128


def code_revision() -> str:
    repo = Path(sam2.__file__).resolve().parent.parent
    try:
        rev = subprocess.run(["git", "-C", str(repo), "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=5)
        if rev.returncode == 0 and rev.stdout.strip():
            return f"sam2@{rev.stdout.strip()}"
    except (OSError, subprocess.SubprocessError):
        pass
    return f"sam2@{getattr(sam2, '__version__', 'unknown')}"


class Segmenter:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.revision = code_revision()
        self.device = os.environ.get("SAM_DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")
        try:
            self.predictor = self._load(self.device)
        except Exception as err:  # MPS can fail on unsupported ops; fall back to CPU.
            if self.device == "cpu":
                raise
            print(f"[sam] {self.device} failed ({type(err).__name__}: {err}); falling back to CPU", file=sys.stderr)
            self.device = "cpu"
            self.predictor = self._load("cpu")

    def _load(self, device: str) -> SAM2ImagePredictor:
        predictor = SAM2ImagePredictor.from_pretrained(MODEL_ID, device=device)
        # Warm-up surfaces device op errors at startup, not mid-request.
        warm = np.zeros((64, 64, 3), dtype=np.uint8)
        with torch.inference_mode():
            predictor.set_image(warm)
            predictor.predict(box=np.array([8, 8, 56, 56]), multimask_output=False)
        return predictor

    def info(self) -> dict:
        return {
            "model": MODEL_ID.split("/")[-1],
            "checkpoint": MODEL_ID,
            "codeRevision": self.revision,
            "device": self.device,
            "settingsVersion": SETTINGS_VERSION,
        }

    def segment(self, image: np.ndarray, boxes: np.ndarray) -> list[dict]:
        with self.lock, torch.inference_mode():
            self.predictor.set_image(image)
            results = []
            for box in boxes:
                masks, scores, _ = self.predictor.predict(box=box, multimask_output=False, return_logits=False)
                mask = masks[0] > 0.5  # already thresholded at logit 0.0 by the predictor
                png = io.BytesIO()
                Image.fromarray(mask.astype(np.uint8) * 255, mode="L").save(png, format="PNG")
                results.append(
                    {
                        "maskPngB64": base64.b64encode(png.getvalue()).decode("ascii"),
                        "score": float(scores[0]),
                        "foregroundPx": int(mask.sum()),
                    }
                )
            self.predictor.reset_predictor()
            return results


class BadRequest(Exception):
    pass


def parse_request(body: bytes) -> tuple[np.ndarray, np.ndarray]:
    try:
        payload = json.loads(body)
        raw = base64.b64decode(payload["image_b64"], validate=True)
        boxes = payload["boxes"]
    except (ValueError, KeyError, TypeError) as err:
        raise BadRequest(f"expected JSON with image_b64 and boxes ({type(err).__name__})") from err
    try:
        image = Image.open(io.BytesIO(raw))
        if image.width * image.height > MAX_PIXELS:
            raise BadRequest(f"image larger than {MAX_PIXELS} pixels")
        array = np.array(image.convert("RGB"))
    except BadRequest:
        raise
    except Exception as err:
        raise BadRequest("image could not be decoded") from err
    if not isinstance(boxes, list) or not 1 <= len(boxes) <= MAX_BOXES:
        raise BadRequest(f"boxes must be a list of 1-{MAX_BOXES} [x0, y0, x1, y1] boxes")
    h, w = array.shape[:2]
    out = []
    for box in boxes:
        if not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box)):
            raise BadRequest("each box must be [x0, y0, x1, y1] numbers")
        x0, y0, x1, y1 = box
        if not (0 <= x0 < x1 <= w and 0 <= y0 < y1 <= h):
            raise BadRequest(f"box {box} is reversed, empty, or outside the {w}x{h} image")
        out.append([x0, y0, x1, y1])
    return array, np.array(out, dtype=np.float32)


def token_ok(header: str | None) -> bool:
    return not TOKEN or (header is not None and hmac.compare_digest(header.encode(), TOKEN.encode()))


def make_handler(segmenter: Segmenter):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                self._send(200, {"ok": True, **segmenter.info(), "tokenRequired": bool(TOKEN)})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/segment":
                self._send(404, {"error": "not found"})
                return
            if not token_ok(self.headers.get("X-Worker-Token")):
                self._send(401, {"error": "missing or wrong X-Worker-Token"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                self._send(413, {"error": f"body must be 1-{MAX_BODY_BYTES} bytes"})
                return
            try:
                image, boxes = parse_request(self.rfile.read(length))
                started = time.perf_counter()
                results = segmenter.segment(image, boxes)
                h, w = image.shape[:2]
                self._send(
                    200,
                    {
                        **segmenter.info(),
                        "widthPx": w,
                        "heightPx": h,
                        "elapsedMs": round((time.perf_counter() - started) * 1000),
                        "results": results,
                    },
                )
            except BadRequest as err:
                self._send(400, {"error": str(err)})
            except Exception as err:  # model/runtime failure: report, keep serving
                self._send(500, {"error": f"segmentation failed: {type(err).__name__}"})

        def log_message(self, fmt: str, *args) -> None:  # one short line, never image data
            sys.stderr.write(f"[sam] {self.command} {self.path} {args[1] if len(args) > 1 else ''}\n")

    return Handler


def make_server(host: str, port: int, handler) -> ThreadingHTTPServer:
    class Server(ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ":" in host else socket.AF_INET

    return Server((host, port), handler)


def main() -> None:
    started = time.perf_counter()
    segmenter = Segmenter()
    info = segmenter.info()
    print(
        f"[sam] {info['checkpoint']} on {info['device']} ({info['codeRevision']}, {SETTINGS_VERSION}) "
        f"loaded in {time.perf_counter() - started:.1f}s; listening on http://{HOST}:{PORT}"
        f"{' (X-Worker-Token required)' if TOKEN else ''}",
        flush=True,
    )
    make_server(HOST, PORT, make_handler(segmenter)).serve_forever()


if __name__ == "__main__":
    main()
