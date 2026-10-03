#!/usr/bin/env python3
"""Uno Q: capture/cache one webcam photo and send its bundle over stdout."""

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid
import zipfile

MAX_JPEG_BYTES = 16 * 1024 * 1024


def capture_image(args):
    # Import only when capturing; cached transfers do not need the camera.
    import cv2

    camera = cv2.VideoCapture(args.device, cv2.CAP_V4L2)
    try:
        if not camera.isOpened():
            raise RuntimeError(
                f"Cannot open {args.device}. Check the hub, video node, "
                "permissions, and other camera applications."
            )
        camera.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        camera.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
        camera.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
        camera.set(cv2.CAP_PROP_FPS, 30)

        # Keep consuming frames while automatic exposure/focus settles.
        deadline = time.monotonic() + args.warmup
        frame = None
        while frame is None or time.monotonic() < deadline:
            ok, frame = camera.read()
            if not ok or frame is None or frame.size == 0:
                raise RuntimeError("The camera returned no usable frame.")

        ok, frame = camera.read()
        captured_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        if not ok or frame is None or frame.size == 0:
            raise RuntimeError("The final camera frame was empty.")
        height, width = frame.shape[:2]
        ok, encoded = cv2.imencode(
            ".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95]
        )
        if not ok:
            raise RuntimeError("JPEG encoding failed.")
        photo = encoded.tobytes()
        if not 0 < len(photo) <= MAX_JPEG_BYTES:
            raise RuntimeError("The JPEG is empty or exceeds the 16 MiB limit.")

        metadata = {
            "protocolVersion": 1,
            "captureId": args.capture_id,
            "capturedAt": captured_at,
            "timestampBasis": "board_frame_received",
            "captureSource": "uno_q_usb_camera",
            "device": args.device,
            "mimeType": "image/jpeg",
            "widthPx": int(width),
            "heightPx": int(height),
            "requestedWidthPx": args.width,
            "requestedHeightPx": args.height,
            "normalized": False,
            "byteLength": len(photo),
            "sha256": hashlib.sha256(photo).hexdigest(),
        }
        return photo, metadata
    finally:
        camera.release()


def make_bundle(photo, metadata):
    stream = io.BytesIO()
    # JPEG is already compressed. STORE also permits simple size validation.
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as bundle:
        bundle.writestr("photo.jpg", photo)
        bundle.writestr("metadata.json", json.dumps(metadata) + "\n")
    return stream.getvalue()


def atomic_write(destination, data):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=destination.parent, prefix=".capture-", delete=False
        ) as file:
            temporary = Path(file.name)
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, destination)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-id", required=True)
    parser.add_argument("--device", default="/dev/video0")
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--warmup", type=float, default=2.0)
    parser.add_argument(
        "--cache-dir", type=Path,
        default=Path.home() / "scrap-camera" / "captures",
    )
    args = parser.parse_args()
    if str(uuid.UUID(args.capture_id)) != args.capture_id:
        parser.error("--capture-id must be a canonical UUID.")
    if not (1 <= args.width <= 8192 and 1 <= args.height <= 8192):
        parser.error("Width and height must be between 1 and 8192.")
    if not math.isfinite(args.warmup) or not 0 <= args.warmup <= 10:
        parser.error("Warmup must be between 0 and 10 seconds.")

    os.umask(0o077)
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    cached = args.cache_dir / (args.capture_id + ".zip")
    if not cached.exists():
        with (args.cache_dir / ".camera.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("Another capture is using the camera. Retry shortly.")
            # Another request may have completed before we acquired the lock.
            if not cached.exists():
                photo, metadata = capture_image(args)
                atomic_write(cached, make_bundle(photo, metadata))
                print(
                    f"Captured {args.capture_id}: "
                    f"{metadata['widthPx']}x{metadata['heightPx']}",
                    file=sys.stderr,
                )

    # Never print logs to stdout: the laptop expects a binary ZIP stream.
    sys.stdout.buffer.write(cached.read_bytes())
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Camera error: {error}", file=sys.stderr)
        sys.exit(1)
