#!/usr/bin/env python3
"""Laptop: request Uno Q photos over SSH and save them for later upload."""

import argparse
from datetime import datetime
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile

MAX_JPEG_BYTES = 16 * 1024 * 1024
MAX_BUNDLE_BYTES = MAX_JPEG_BYTES + 64 * 1024


def validate_bundle(data, capture_id):
    if not 0 < len(data) <= MAX_BUNDLE_BYTES:
        raise ValueError("The received bundle is empty or too large.")
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        entries = bundle.infolist()
        if len(entries) != 2 or {e.filename for e in entries} != {
            "photo.jpg", "metadata.json"
        }:
            raise ValueError("Unexpected files in the camera bundle.")
        for entry in entries:
            limit = MAX_JPEG_BYTES if entry.filename == "photo.jpg" else 8192
            if not 0 < entry.file_size <= limit:
                raise ValueError("A camera bundle file exceeds its size limit.")
            if entry.compress_type != zipfile.ZIP_STORED:
                raise ValueError("Unexpected camera bundle compression.")
        # Read fixed names; do not extract archive paths onto the laptop.
        photo = bundle.read("photo.jpg")
        metadata = json.loads(bundle.read("metadata.json"))

    if not isinstance(metadata, dict):
        raise ValueError("Camera metadata must be an object.")
    if metadata.get("protocolVersion") != 1 or metadata.get("captureId") != capture_id:
        raise ValueError("The camera returned a different capture ID or protocol.")
    if metadata.get("mimeType") != "image/jpeg" or metadata.get("normalized") is not False:
        raise ValueError("Unexpected camera image format/geometry metadata.")
    for key in ("widthPx", "heightPx"):
        value = metadata.get(key)
        if type(value) is not int or not 1 <= value <= 8192:
            raise ValueError(f"Invalid {key} in camera metadata.")
    timestamp = datetime.fromisoformat(metadata["capturedAt"].replace("Z", "+00:00"))
    if timestamp.utcoffset() is None or timestamp.utcoffset().total_seconds() != 0:
        raise ValueError("The camera timestamp must include UTC timezone information.")
    if not (photo.startswith(b"\xff\xd8") and photo.endswith(b"\xff\xd9")):
        raise ValueError("The received photo is not a complete JPEG.")
    if type(metadata.get("byteLength")) is not int or metadata["byteLength"] != len(photo):
        raise ValueError("The JPEG byte count does not match its metadata.")
    if hashlib.sha256(photo).hexdigest() != metadata.get("sha256"):
        raise ValueError("The JPEG checksum does not match. Retry the same capture.")
    return photo, metadata


def save_capture(out, photo, metadata):
    destination = out / metadata["captureId"]
    if destination.exists():
        existing_metadata = json.loads((destination / "metadata.json").read_text())
        existing_photo = (destination / "photo.jpg").read_bytes()
        if existing_metadata != metadata or existing_photo != photo:
            raise ValueError("A different local photo already uses this capture ID.")
        return destination

    temporary = Path(tempfile.mkdtemp(prefix=".receive-", dir=out))
    try:
        for name, content in (
            ("photo.jpg", photo),
            ("metadata.json", (json.dumps(metadata, indent=2) + "\n").encode()),
        ):
            with (temporary / name).open("wb") as file:
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
        temporary.rename(destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return destination


def receive_capture(args):
    out = args.out.expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    pending_path = out / ".pending.json"
    configuration = {
        "target": args.target,
        "remoteScript": args.remote_script,
        "device": args.device,
        "width": args.width,
        "height": args.height,
        "warmup": args.warmup,
    }
    if pending_path.exists():
        request = json.loads(pending_path.read_text())
        if request["configuration"] != configuration:
            raise ValueError("A pending capture uses different settings. Retry with its original settings.")
        capture_id = request["captureId"]
        if str(uuid.UUID(capture_id)) != capture_id:
            raise ValueError("Invalid pending capture ID.")
    else:
        capture_id = str(uuid.uuid4())
        request = {"captureId": capture_id, "configuration": configuration}
        temporary = out / ".pending.tmp"
        with temporary.open("w") as file:
            json.dump(request, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, pending_path)

    print(f"Requesting {capture_id} ...", flush=True)
    remote_command = shlex.join([
        "timeout", "--signal=TERM", "--kill-after=2s", "20s",
        "/usr/bin/python3", args.remote_script,
        "--capture-id", capture_id,
        "--device", args.device,
        "--width", str(args.width), "--height", str(args.height),
        "--warmup", str(args.warmup),
    ])
    command = [
        "ssh", "-T", "-i", str(args.identity.expanduser()),
        "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5",
        "-o", "ServerAliveCountMax=2", args.target, remote_command,
    ]
    result = subprocess.run(
        command, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=45, check=True,
    )
    photo, metadata = validate_bundle(result.stdout, capture_id)
    destination = save_capture(out, photo, metadata)
    pending_path.unlink()
    print(f"Saved: {destination / 'photo.jpg'}")
    print(f"Metadata: {destination / 'metadata.json'}")
    print(f"Actual image: {metadata['widthPx']} x {metadata['heightPx']} pixels")
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, help="arduino@board-IP-or-hostname")
    parser.add_argument("--device", default="/dev/video0")
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--warmup", type=float, default=2.0)
    parser.add_argument("--remote-script", default="scrap-camera/uno_q_camera.py")
    parser.add_argument("--identity", type=Path, default=Path.home() / ".ssh" / "scrap_unoq")
    parser.add_argument("--out", type=Path, default=Path("images/arduino-inbox"))
    parser.add_argument("--once", action="store_true", help="Capture/retry once and exit")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+", args.target):
        parser.error("Use an SSH target such as arduino@192.168.1.50 or arduino@board.local.")
    if not (1 <= args.width <= 8192 and 1 <= args.height <= 8192):
        parser.error("Width and height must be between 1 and 8192.")
    if not math.isfinite(args.warmup) or not 0 <= args.warmup <= 10:
        parser.error("Warmup must be between 0 and 10 seconds.")

    print("One operator/program per output folder. Place one dish before each capture.")
    while True:
        if not args.once:
            if (args.out.expanduser() / ".pending.json").exists():
                print("A previous request is pending; Enter retries that same capture.")
            choice = input("Enter = capture/retry; q = quit: ").strip().lower()
            if choice == "q":
                return 0
            if choice:
                continue
        try:
            receive_capture(args)
        except Exception as error:
            if isinstance(error, subprocess.CalledProcessError):
                detail = (error.stderr or b"").decode("utf-8", errors="replace").strip()
                print(f"SSH/camera failed ({error.returncode}): {detail[-2000:]}", file=sys.stderr)
            else:
                print(f"Capture failed: {error}", file=sys.stderr)
            print("Pending ID retained. Keep the dish in place and retry with the same settings.", file=sys.stderr)
            if args.once:
                return 1
        else:
            if args.once:
                return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyboardInterrupt, EOFError):
        print("\nStopped. Any pending capture remains available for retry.")
        sys.exit(0)
