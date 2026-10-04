"""Depth Anything V2 metric-depth worker (IT_4 I4).

A small local HTTP service, modelled on vision/sam/worker.py. It loads
`depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf` (Apache-2.0) through
Hugging Face `transformers` once, on MPS, then CUDA, then CPU. It runs one
inference per image, upsamples the prediction bicubically to the exact input
size, and returns float32 metres. Requests are serialized (one lock).

    .venv/bin/python vision/depth/worker.py          # http://127.0.0.1:8791

POST /depth   {"image_b64": "<jpeg/png bytes>"}
  -> {"widthPx", "heightPx", "model", "checkpoint", "device", "settingsVersion",
      "elapsedMs", "depthF32B64", "minM", "maxM"}
     depthF32B64 = little-endian float32 metres, row-major, widthPx x heightPx.
GET  /health  -> model/device/settings info (no token needed; no image data)

Settings "dav2-metric-small-v1": processor defaults (resize so the short side
is 518, multiple of 14, keep aspect, ImageNet normalization), fp32,
`predicted_depth` upsampled to (heightPx, widthPx) with bicubic interpolation
(align_corners=False), negative values from bicubic overshoot clamped to 0.
The image is decoded without EXIF rotation, exactly like the SAM worker, so
the depth map aligns pixel-for-pixel with the SAM masks of the same bytes.

Only the Small checkpoint is allowed: Base and Large are CC-BY-NC-4.0
(non-commercial) and must not be used for this project.

Env: DEPTH_MODEL_ID, DEPTH_DEVICE, DEPTH_PORT (8791), WORKER_HOST (127.0.0.1;
DEPTH_HOST also accepted), WORKER_TOKEN (optional; when set, POST requests
must send a matching X-Worker-Token header or get 401).
"""

from __future__ import annotations

import base64
import hmac
import io
import json
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForDepthEstimation

MODEL_ID = os.environ.get("DEPTH_MODEL_ID", "depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf")
HOST = os.environ.get("WORKER_HOST") or os.environ.get("DEPTH_HOST") or "127.0.0.1"
PORT = int(os.environ.get("DEPTH_PORT", "8791"))
TOKEN = os.environ.get("WORKER_TOKEN") or ""
SETTINGS_VERSION = "dav2-metric-small-v1"
MAX_BODY_BYTES = 25 * 1024 * 1024
MAX_PIXELS = 4096 * 4096

if "Small" not in MODEL_ID.split("/")[-1]:
    # Base/Large are CC-BY-NC-4.0: refuse rather than silently serve a non-commercial model.
    sys.exit(f"[depth] refusing {MODEL_ID}: only the Apache-2.0 Small checkpoint is allowed")


def pick_devices() -> list[str]:
    forced = os.environ.get("DEPTH_DEVICE")
    if forced:
        return [forced] if forced == "cpu" else [forced, "cpu"]
    out = []
    if torch.backends.mps.is_available():
        out.append("mps")
    if torch.cuda.is_available():
        out.append("cuda")
    out.append("cpu")
    return out


class DepthEstimator:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.processor = AutoImageProcessor.from_pretrained(MODEL_ID)
        devices = pick_devices()
        last_err: Exception | None = None
        for device in devices:
            try:
                self.model = self._load(device)
                self.device = device
                break
            except Exception as err:  # MPS/CUDA can fail on unsupported ops; try the next device.
                last_err = err
                print(f"[depth] {device} failed ({type(err).__name__}: {err}); trying the next device", file=sys.stderr)
        else:
            raise RuntimeError(f"no usable device: {last_err}")

    def _load(self, device: str):
        model = AutoModelForDepthEstimation.from_pretrained(MODEL_ID).to(device).eval()
        # Warm-up surfaces device op errors at startup, not mid-request.
        warm = np.zeros((96, 128, 3), dtype=np.uint8)
        self._infer(model, device, warm)
        return model

    def _infer(self, model, device: str, image: np.ndarray) -> np.ndarray:
        h, w = image.shape[:2]
        inputs = self.processor(images=Image.fromarray(image), return_tensors="pt")
        inputs = {k: v.to(device) for k, v in inputs.items()}
        with torch.inference_mode():
            pred = model(**inputs).predicted_depth  # (1, h', w') metres
            up = torch.nn.functional.interpolate(pred.unsqueeze(1), size=(h, w), mode="bicubic", align_corners=False)
            depth = up[0, 0].clamp_(min=0.0).to("cpu", torch.float32).numpy()
        return depth

    def info(self) -> dict:
        return {
            "model": MODEL_ID.split("/")[-1],
            "checkpoint": MODEL_ID,
            "device": self.device,
            "settingsVersion": SETTINGS_VERSION,
        }

    def estimate(self, image: np.ndarray) -> np.ndarray:
        with self.lock:
            return self._infer(self.model, self.device, image)


class BadRequest(Exception):
    pass


def parse_request(body: bytes) -> np.ndarray:
    try:
        payload = json.loads(body)
        raw = base64.b64decode(payload["image_b64"], validate=True)
    except (ValueError, KeyError, TypeError) as err:
        raise BadRequest(f"expected JSON with image_b64 ({type(err).__name__})") from err
    try:
        image = Image.open(io.BytesIO(raw))
        if image.width * image.height > MAX_PIXELS:
            raise BadRequest(f"image larger than {MAX_PIXELS} pixels")
        return np.array(image.convert("RGB"))
    except BadRequest:
        raise
    except Exception as err:
        raise BadRequest("image could not be decoded") from err


def token_ok(header: str | None) -> bool:
    return not TOKEN or (header is not None and hmac.compare_digest(header.encode(), TOKEN.encode()))


def make_handler(estimator: DepthEstimator):
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
                self._send(200, {"ok": True, **estimator.info(), "tokenRequired": bool(TOKEN)})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/depth":
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
                image = parse_request(self.rfile.read(length))
                started = time.perf_counter()
                depth = estimator.estimate(image)
                h, w = image.shape[:2]
                if depth.shape != (h, w) or not np.isfinite(depth).all():
                    raise RuntimeError("depth output misaligned or non-finite")
                self._send(
                    200,
                    {
                        **estimator.info(),
                        "widthPx": w,
                        "heightPx": h,
                        "elapsedMs": round((time.perf_counter() - started) * 1000),
                        "depthF32B64": base64.b64encode(depth.astype("<f4").tobytes()).decode("ascii"),
                        "minM": float(depth.min()),
                        "maxM": float(depth.max()),
                    },
                )
            except BadRequest as err:
                self._send(400, {"error": str(err)})
            except Exception as err:  # model/runtime failure: report, keep serving
                self._send(500, {"error": f"depth failed: {type(err).__name__}"})

        def log_message(self, fmt: str, *args) -> None:  # one short line, never image data or tokens
            sys.stderr.write(f"[depth] {self.command} {self.path} {args[1] if len(args) > 1 else ''}\n")

    return Handler


def make_server(host: str, port: int, handler) -> ThreadingHTTPServer:
    class Server(ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ":" in host else socket.AF_INET

    return Server((host, port), handler)


def main() -> None:
    started = time.perf_counter()
    estimator = DepthEstimator()
    info = estimator.info()
    print(
        f"[depth] {info['checkpoint']} on {info['device']} ({SETTINGS_VERSION}) loaded in "
        f"{time.perf_counter() - started:.1f}s; listening on http://{HOST}:{PORT}"
        f"{' (X-Worker-Token required)' if TOKEN else ''}",
        flush=True,
    )
    make_server(HOST, PORT, make_handler(estimator)).serve_forever()


if __name__ == "__main__":
    main()
