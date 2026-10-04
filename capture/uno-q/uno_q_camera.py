#!/usr/bin/env python3
"""Uno Q: capture one photo, or stream timed photos using FFmpeg."""

import argparse
from contextlib import closing
from datetime import datetime, timezone
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile

MAX_JPEG_BYTES = 16 * 1024 * 1024
MAX_JPEG_PADDING_BYTES = 32
MAX_EMPTY_FRAMES = 90


class CameraPipe:
    """Bounded reads from FFmpeg, including a timeout for a stalled camera."""

    def __init__(self, stream):
        self.stream = stream
        self.buffer = bytearray()

    def fill(self, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([self.stream], [], [], remaining)[0]:
            raise TimeoutError("The camera stopped sending frames for 15 seconds.")
        data = os.read(self.stream.fileno(), 64 * 1024)
        if not data:
            raise RuntimeError("FFmpeg stopped. Check the camera, video mode, and permissions.")
        self.buffer.extend(data)

    def readline(self):
        deadline = time.monotonic() + 15
        while b"\n" not in self.buffer:
            if len(self.buffer) > 4096:
                raise ValueError("FFmpeg returned an oversized camera header.")
            self.fill(deadline)
        end = self.buffer.index(b"\n") + 1
        if end > 4096:
            raise ValueError("FFmpeg returned an oversized camera header.")
        line = bytes(self.buffer[:end])
        del self.buffer[:end]
        return line

    def read(self, size):
        deadline = time.monotonic() + 15
        while len(self.buffer) < size:
            self.fill(deadline)
        data = bytes(self.buffer[:size])
        del self.buffer[:size]
        return data


def read_mjpeg_frame(stream):
    # FFmpeg's multipart muxer provides explicit lengths; JPEG bytes may contain
    # marker-like data, so do not split the image on arbitrary byte sequences.
    line = stream.readline()
    if line == b"\r\n":
        line = stream.readline()
    if line != b"--ffmpeg\r\n":
        raise ValueError("Unexpected FFmpeg camera boundary.")
    headers = {}
    for _ in range(16):
        line = stream.readline()
        if line == b"\r\n":
            break
        key, separator, value = line.partition(b":")
        if not separator or key.lower() in headers:
            raise ValueError("Invalid FFmpeg camera header.")
        headers[key.lower()] = value.strip()
    else:
        raise ValueError("Too many FFmpeg camera headers.")
    content_type = headers.get(b"content-type", b"")
    if content_type != b"image/jpeg":
        raise ValueError(f"Unexpected camera content type: {content_type[:80]!r}; expected image/jpeg.")
    content_length = headers.get(b"content-length", b"")
    if not content_length.isdigit():
        raise ValueError(f"Invalid camera Content-length header: {content_length[:80]!r}.")
    size = int(content_length)
    if size > MAX_JPEG_BYTES:
        raise ValueError(f"The camera JPEG is {size} bytes; the limit is {MAX_JPEG_BYTES} bytes.")
    # V4L2 can deliver empty/error buffers, and FFmpeg preserves their zero
    # length in multipart output. No image bytes follow this packet's headers.
    if size == 0:
        return None
    photo = stream.read(size)
    if len(photo) != size:
        raise ValueError("The camera returned an incomplete JPEG.")
    return camera_jpeg(photo)


def camera_jpeg(photo):
    """Keep the encoded image, excluding bounded USB-camera buffer padding."""
    if not photo.startswith(b"\xff\xd8"):
        raise ValueError("The camera returned an incomplete JPEG.")
    position = 2
    in_scan = False
    saw_scan = False
    while position < len(photo):
        if in_scan:
            position = photo.find(b"\xff", position)
            if position < 0:
                break
        elif photo[position] != 0xFF:
            break
        while position < len(photo) and photo[position] == 0xFF:
            position += 1
        if position >= len(photo):
            break
        marker = photo[position]
        position += 1
        if in_scan and (marker == 0x00 or 0xD0 <= marker <= 0xD7):
            continue
        if marker == 0xD9:
            if not saw_scan:
                break
            if len(photo) - position > MAX_JPEG_PADDING_BYTES:
                raise ValueError("The camera JPEG has excessive trailing data after its end marker.")
            return photo[:position]
        if marker in (0x00, 0xD8) or 0xD0 <= marker <= 0xD7:
            break
        if marker == 0x01:
            continue
        if position + 2 > len(photo):
            break
        size = int.from_bytes(photo[position:position + 2], "big")
        if size < 2 or position + size > len(photo):
            break
        position += size
        # Segment lengths protect embedded marker bytes in EXIF/other headers.
        # Scan data uses FF00 stuffing; only an actual EOI marker ends the JPEG.
        in_scan = marker == 0xDA or (in_scan and marker == 0xDC)
        saw_scan = saw_scan or marker == 0xDA
    raise ValueError("The camera returned an incomplete JPEG.")


def jpeg_dimensions(photo):
    position = 2
    while position < len(photo):
        if photo[position] != 0xFF:
            break
        while position < len(photo) and photo[position] == 0xFF:
            position += 1
        if position >= len(photo):
            break
        marker = photo[position]
        position += 1
        if marker in (0xDA, 0xD9):
            break
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            continue
        if position + 2 > len(photo):
            break
        size = int.from_bytes(photo[position:position + 2], "big")
        if size < 2 or position + size > len(photo):
            break
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                      0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF) and size >= 8:
            height = int.from_bytes(photo[position + 3:position + 5], "big")
            width = int.from_bytes(photo[position + 5:position + 7], "big")
            if 1 <= width <= 8192 and 1 <= height <= 8192:
                return width, height
            break
        position += size
    raise ValueError("The camera JPEG has no valid image dimensions.")


def v4l2_set(device, controls):
    """Run v4l2-ctl -c for each control; return (ok, stderr text)."""
    command = ["v4l2-ctl", "-d", device]
    for control in controls:
        command += ["-c", control]
    try:
        done = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
    except subprocess.TimeoutExpired:
        return False, "v4l2-ctl timed out"
    return done.returncode == 0, (done.stderr or done.stdout or "").strip()


def v4l2_get(device, control):
    """Read one integer control back (``focus_absolute: 0``), or None."""
    try:
        done = subprocess.run(["v4l2-ctl", "-d", device, "-C", control], stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, timeout=5)
    except subprocess.TimeoutExpired:
        return None
    if done.returncode != 0:
        return None
    value = done.stdout.strip().rpartition(":")[2].strip()
    return int(value) if value.lstrip("-").isdigit() else None


def lock_focus(args):
    """Best-effort Logitech C920s focus lock (IT_4 I3); never fails the capture.

    Autofocus changes the focal length, so calibration and every later capture
    use the same fixed focus. Newer kernels name the control
    focus_automatic_continuous, older ones focus_auto. The result is recorded in
    the capture metadata so calibration and dish frames can be compared.
    """
    requested = getattr(args, "focus_absolute", 0)
    if getattr(args, "no_focus_lock", False):
        print("Focus lock disabled (--no-focus-lock): the camera may refocus between captures.", file=sys.stderr)
        return {"lock": "disabled", "control": None, "absolute": None}
    device = getattr(args, "device", "/dev/video0")
    if shutil.which("v4l2-ctl") is None:
        print("Warning: v4l2-ctl is not installed, so focus is NOT locked "
              "(sudo apt install v4l-utils). Capturing anyway.", file=sys.stderr)
        return {"lock": "unavailable", "control": None, "absolute": None,
                "detail": "v4l2-ctl not installed"}
    errors = []
    for control in ("focus_automatic_continuous", "focus_auto"):
        # Two calls: while autofocus is on, focus_absolute is inactive and the C920 answers
        # "Permission denied", which fails a combined (atomic) set.
        ok, detail = v4l2_set(device, [f"{control}=0"])
        if ok:
            ok, detail = v4l2_set(device, [f"focus_absolute={requested}"])
            if not ok:
                time.sleep(0.2)
                ok, detail = v4l2_set(device, [f"focus_absolute={requested}"])
        if ok:
            actual = v4l2_get(device, "focus_absolute")
            absolute = requested if actual is None else actual
            print(f"Focus locked: {control}=0, focus_absolute={absolute} on {device}.", file=sys.stderr)
            if actual is not None and actual != requested:
                print(f"Warning: requested focus_absolute={requested}, camera reports {actual}.", file=sys.stderr)
            return {"lock": "locked", "control": control, "absolute": absolute}
        errors.append(f"{control}: {detail[-200:]}")
    print("Warning: could not lock focus with v4l2-ctl; capturing with the camera's own focus. "
          + " | ".join(errors), file=sys.stderr)
    return {"lock": "failed", "control": None, "absolute": None, "detail": " | ".join(errors)[-400:]}


def camera_frames(args):
    """Yield validated native JPEGs; close FFmpeg when the caller is done."""
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "v4l2", "-input_format", "mjpeg", "-framerate", "30",
        "-video_size", f"{args.width}x{args.height}", "-i", args.device,
        "-map", "0:v:0", "-an", "-c:v", "copy", "-f", "mpjpeg",
        "-boundary_tag", "ffmpeg", "-flush_packets", "1", "pipe:1",
    ]
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, bufsize=0)
    except FileNotFoundError as error:
        raise RuntimeError("FFmpeg is not installed on the Uno Q. Run sudo apt install ffmpeg on the board.") from error
    try:
        stream = CameraPipe(process.stdout)
        empty_frames = 0
        while True:
            photo = read_mjpeg_frame(stream)
            if photo is None:
                empty_frames += 1
                if empty_frames >= MAX_EMPTY_FRAMES:
                    raise RuntimeError(
                        f"The camera sent {MAX_EMPTY_FRAMES} consecutive empty frames from {args.device}. "
                        "Check the powered hub, camera, and capture node with v4l2-ctl --list-devices."
                    )
                if empty_frames == 1:
                    print("Skipping an empty camera packet; waiting for a usable JPEG.", file=sys.stderr)
                continue
            empty_frames = 0
            yield photo
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdout.close()


def stream_captures(args):
    with (args.cache_dir / ".camera.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another capture is using the camera. Stop it first.")
        focus = lock_focus(args)
        with closing(camera_frames(args)) as frames:
            next_capture = None
            count = 0
            for photo in frames:
                received = time.monotonic()
                if next_capture is None:
                    next_capture = received + args.warmup
                if received < next_capture:
                    continue
                captured_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                width, height = jpeg_dimensions(photo)
                capture_id = uuid.uuid4()
                metadata = {
                    "protocolVersion": 1, "captureId": str(capture_id),
                    "capturedAt": captured_at, "timestampBasis": "board_frame_received",
                    "captureSource": "uno_q_usb_camera", "device": args.device,
                    "mimeType": "image/jpeg", "widthPx": width, "heightPx": height,
                    "requestedWidthPx": args.width, "requestedHeightPx": args.height,
                    "normalized": False, "byteLength": len(photo),
                    "sha256": hashlib.sha256(photo).hexdigest(),
                    "triggerSource": "interval", "intervalSeconds": args.interval,
                    "dishIdentity": "unresolved",
                    "focus": focus,
                }
                warn_resolution(args, width, height)
                bundle = make_bundle(photo, metadata)
                sys.stdout.buffer.write(struct.pack("!I", len(bundle)) + capture_id.bytes + bundle)
                sys.stdout.buffer.flush()
                count += 1
                if args.count and count >= args.count:
                    return
                # Skip missed slots after a slow transfer; never burst to catch up.
                next_capture = received + args.interval
                now = time.monotonic()
                if now >= next_capture:
                    missed = math.floor((now - next_capture) / args.interval) + 1
                    next_capture += missed * args.interval


def capture_image(args):
    focus = lock_focus(args)
    # Keep consuming native MJPEG frames while exposure/focus settles.
    with closing(camera_frames(args)) as frames:
        deadline = None
        for photo in frames:
            received = time.monotonic()
            if deadline is None:
                deadline = received + args.warmup
            if received >= deadline:
                break
        captured_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        width, height = jpeg_dimensions(photo)
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
            "focus": focus,
        }
        warn_resolution(args, width, height)
        return photo, metadata


def warn_resolution(args, width, height):
    # A calibration holds for one resolution only (IT_4 I2); say so when the camera picked another.
    if (width, height) != (args.width, args.height):
        print(f"Warning: asked for {args.width}x{args.height}, the camera sent {width}x{height}. "
              "Calibrate at the resolution you capture with.", file=sys.stderr)


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
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--capture-id")
    mode.add_argument("--stream", action="store_true", help="Stream timed photos with FFmpeg")
    parser.add_argument("--interval", type=float, default=1.0, help="Seconds between streamed photos")
    parser.add_argument("--count", type=int, default=0, help="Stop after this many streamed photos; 0 = continuous")
    parser.add_argument("--device", default="/dev/video0")
    # Fixed C920s native mode. A calibration holds for one resolution only (IT_4 I2).
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--warmup", type=float, default=2.0)
    parser.add_argument("--focus-absolute", type=int, default=0,
                        help="Locked C920s focus_absolute (0-255; default 0). Same value for calibration and captures")
    parser.add_argument("--no-focus-lock", action="store_true",
                        help="Leave autofocus alone (physical estimates become unreliable)")
    parser.add_argument(
        "--cache-dir", type=Path,
        default=Path.home() / "scrap-camera" / "captures",
    )
    args = parser.parse_args()
    if not 0 <= args.focus_absolute <= 255:
        parser.error("--focus-absolute must be between 0 and 255.")
    if args.capture_id and str(uuid.UUID(args.capture_id)) != args.capture_id:
        parser.error("--capture-id must be a canonical UUID.")
    if not (1 <= args.width <= 8192 and 1 <= args.height <= 8192):
        parser.error("Width and height must be between 1 and 8192.")
    if not math.isfinite(args.warmup) or not 0 <= args.warmup <= 10:
        parser.error("Warmup must be between 0 and 10 seconds.")
    if not math.isfinite(args.interval) or not 0.1 <= args.interval <= 60:
        parser.error("Interval must be between 0.1 and 60 seconds.")
    if args.count < 0:
        parser.error("Count must be nonnegative.")

    os.umask(0o077)
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    if args.stream:
        stream_captures(args)
        return
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
    def stop_stream(signum, frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop_stream)
    signal.signal(signal.SIGHUP, stop_stream)
    try:
        main()
    except (KeyboardInterrupt, BrokenPipeError):
        sys.exit(0)
    except Exception as error:
        print(f"Camera error: {error}", file=sys.stderr)
        sys.exit(1)
