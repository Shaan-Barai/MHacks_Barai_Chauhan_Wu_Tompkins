# Arduino Uno Q + Logitech C920s: photos on the laptop

This guide gets a photo from the Logitech C920s connected to the **Arduino Uno Q** onto your laptop. Press Enter on the laptop, wait a few seconds, and receive a JPEG plus a small metadata file. Once those files exist, your laptop can use the project's upload flow.

The guide includes both complete Python programs. Copy them into the paths shown below; this Markdown file itself does not install or start anything.

## 1. What we are building

```text
Logitech C920s
    │ USB-A
    ▼
Powered USB-C hub ◀── USB-C PD power supply
    │ USB-C
    ▼
Arduino Uno Q — Debian Linux, Python, OpenCV
    │ Wi-Fi / local network, SSH
    ▼
Laptop — Python, saves photo.jpg + metadata.json
    │ your subsequent upload flow
    ▼
Cloudflare R2: image bytes
SpacetimeDB: durable image references, metadata, application records
```

The laptop requests each photo over SSH. The Uno Q opens the webcam, lets exposure/focus settle, captures a frame, and caches it before sending it back. A transfer retry uses the same capture ID and retrieves the cached photo. There is no continuously running camera server to configure.

**The camera program runs on the Uno Q's Linux processor. No Arduino sketch, GPIO wiring, serial-image protocol, or MCU Bridge code is required for this task.** The board's microcontroller can remain as configured. Arduino documents this separation between Linux applications and Arduino sketches in its [Debian guide](https://docs.arduino.cc/tutorials/uno-q/debian-guide/).

This guide stops at local files. It does not call Gemini, R2, SpacetimeDB, or the project backend.

## 2. Hardware and software checklist

| Item | Needed for |
| --- | --- |
| Arduino **Uno Q**, either RAM variant | Running the Linux camera program |
| Logitech C920s Pro HD Webcam | Capturing the dish |
| USB-C hub with USB-A data ports and **USB-C Power Delivery input** | Connecting the camera while powering the board |
| Suitable USB-C PD supply and cable | Supplying the board and peripherals |
| Laptop with Python **3.9+**, `ssh`, and `scp` | Triggering captures and receiving files |
| Shared reachable local network | SSH communication between board and laptop |
| Arduino App Lab | Initial board setup and network configuration |

Arduino specifies 5 V / 3 A for USB-C board power. Account for the hub and webcam as well; the hub's advertised charger rating is not necessarily the power it delivers to the board. Use a compatible externally powered PD hub. Arduino's manual excludes Apple dongles from its supported setup. See the [Uno Q manual](https://docs.arduino.cc/tutorials/uno-q/user-manual/) and [power specifications](https://docs.arduino.cc/tutorials/uno-q/power-specification/).

The C920s uses USB-A, and Logitech describes its webcams as standard UVC devices. Arduino supports USB cameras on the Uno Q. That supports this integration approach, but the exact camera/hub/board combination still needs the hardware checks below. [Logitech connection requirements](https://www.logitech.com/en-us/discover/a/setup-webcams-and-headsets), [Logitech UVC information](https://support.logi.com/hc/en-001/articles/360060226873-Capture-requirements).

## 3. Set up the board once

### 3.1 Complete Arduino App Lab setup

1. Install Arduino App Lab on the laptop from the [official Arduino software page](https://www.arduino.cc/en/software/).
2. Follow App Lab's first-run setup for the Uno Q, initially connected directly to the laptop with a USB-C data cable. Complete any required board setup/update before installing the scripts.
3. Give the board a recognizable name and connect it to Wi-Fi. Keep the Linux password you configured.
4. Put the laptop on the same reachable network. A small router or hotspot that permits devices to communicate is often easier at an event than campus/guest Wi-Fi.
5. Note the board's hostname or IP address. Arduino documents SSH after initial App Lab setup in its [SSH tutorial](https://docs.arduino.cc/tutorials/uno-q/ssh/).

The commands below assume the documented Linux account `arduino`. Substitute your actual account if different. `192.168.1.50` is an **example IP**, not the board's fixed address.

### 3.2 Connect the webcam and powered hub

After setup, run `sudo halt` in a board shell. Arduino recommends this command because ordinary power-off commands can cause the Uno Q to restart. For a headless connection, normally allow 10–15 seconds before disconnecting power. Some firmware/power configurations also restart after `halt`; follow Arduino's [shutdown instructions](https://docs.arduino.cc/tutorials/uno-q/debian-guide/) if that happens. Once the board is unpowered:

1. Plug the C920s into a USB-A **data** port on the hub.
2. Plug the PD power supply into the hub's PD input.
3. Plug the hub's host/upstream USB-C lead into the Uno Q's USB-C port.
4. Let the Uno Q boot, and open the camera's privacy shutter.

The laptop communicates over Wi-Fi while the Uno Q's USB-C port is occupied by the hub. Do not connect the laptop to a hub's downstream USB-A port as if it were a second host. An HDMI display and keyboard are optional; this guide runs without a display connected to the board. Arduino documents the hub/peripheral setup in its [single-board computer guide](https://docs.arduino.cc/tutorials/uno-q/single-board-computer/).

### 3.3 Verify SSH from the laptop

**Laptop — macOS/Linux terminal:**

```bash
UNO_TARGET='arduino@192.168.1.50'
ssh "$UNO_TARGET"
```

You can use `arduino@YOUR-BOARD-NAME.local` instead if hostname discovery works. Confirm the first connection's host key after checking that you are connecting to your own board, and enter the board's Linux password.

**Laptop — Windows PowerShell:**

```powershell
$UNO_TARGET = 'arduino@192.168.1.50'
ssh $UNO_TARGET
```

If Windows cannot find `ssh`/`scp`, install the Windows **OpenSSH Client** optional feature following [Microsoft's installation instructions](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse). If `python` is unavailable, install Python 3.9+ and make it available in your terminal. macOS/Linux commands below use `python3`; on Windows use `python` or `py -3`.

Once logged in, these commands run **on the Uno Q**:

```bash
whoami
hostname -I
timedatectl status
```

Check the board's clock. Metadata uses a UTC timestamp from the board when the selected frame is received; it is not a hardware exposure timestamp. Correct a wrong clock/network-time setup before collecting service data.

## 4. Install camera tools and find the device

Run these in the **Uno Q SSH shell**, not on the laptop:

```bash
sudo apt update
sudo apt install -y python3 python3-opencv v4l-utils usbutils
/usr/bin/python3 -c 'import cv2; print(cv2.__version__)'
lsusb
v4l2-ctl --list-devices
```

Find the Logitech camera's video devices. A webcam can expose more than one `/dev/video*` node; some nodes contain metadata rather than usable images. Inspect the candidate:

```bash
v4l2-ctl --device=/dev/video0 --all
v4l2-ctl --device=/dev/video0 --list-formats-ext
```

Choose the node supporting video capture and JPEG/MJPG or another image format. Substitute it everywhere this guide uses `/dev/video0`. If available, a matching `/dev/v4l/by-id/...-video-index0` path provides a more stable name across reboots than a numbered node; verify that it belongs to the C920s.

The scripts request **1920 × 1080, MJPG, 30 fps**, then save one JPEG. Device drivers may negotiate a different size; the saved metadata records the actual frame dimensions. Check supported formats rather than assuming that requested settings were accepted. OpenCV documents device-dependent property behavior in its [VideoCapture reference](https://docs.opencv.org/4.x/d8/dfe/classcv_1_1VideoCapture.html).

If the account cannot access the video device:

```bash
id
ls -l /dev/video0
sudo usermod -aG video arduino
exit
```

Reconnect with SSH after changing group membership. If your account has a different name, substitute it in `usermod`. Use the ordinary account to run the camera program.

An optional visual test, when a display is connected to the board, is `sudo apt install cheese`, then `cheese` from its desktop session. Close Cheese and any App Lab camera example before running our program. Arduino describes both camera discovery and OpenCV in its [USB-camera instructions](https://docs.arduino.cc/tutorials/uno-q/debian-guide/).

## 5. Set up SSH authentication for repeated captures

The laptop program uses noninteractive SSH. Configure a key once so it does not request the board password on every photo.

**Laptop — macOS/Linux:**

```bash
UNO_TARGET='arduino@192.168.1.50'
UNO_KEY="$HOME/.ssh/scrap_unoq"
ssh-keygen -t ed25519 -f "$UNO_KEY" -C 'scrap-uno-q'
ssh "$UNO_TARGET" 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' < "$UNO_KEY.pub"
ssh-add "$UNO_KEY"
ssh -i "$UNO_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$UNO_TARGET" 'printf "SSH ready\n"'
```

Choose a passphrase when creating the key; `ssh-add` unlocks it in the SSH agent. If there is no agent in a Linux terminal, run `eval "$(ssh-agent -s)"` and then `ssh-add` again. Run these setup commands once, and reuse the key. Do not overwrite an existing key when `ssh-keygen` asks.

**Laptop — Windows PowerShell:**

```powershell
$UNO_TARGET = 'arduino@192.168.1.50'
$UNO_KEY = "$HOME/.ssh/scrap_unoq"
ssh-keygen -t ed25519 -f $UNO_KEY -C 'scrap-uno-q'
Get-Content "$UNO_KEY.pub" | ssh $UNO_TARGET 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys'
```

To use a passphrase-protected key, enable the Windows SSH agent once in an **administrator PowerShell**, as described in [Microsoft's key-management guide](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement):

```powershell
Set-Service -Name ssh-agent -StartupType Automatic
Start-Service ssh-agent
```

Then return to an ordinary PowerShell:

```powershell
ssh-add $UNO_KEY
ssh -i $UNO_KEY -o IdentitiesOnly=yes -o BatchMode=yes $UNO_TARGET 'printf "SSH ready\n"'
```

Continue only after the test prints `SSH ready`. Keep the private key on the laptop; only the `.pub` file goes to the board.

## 6. Create the two program files

From the **repository root on the laptop**, create these directories:

```bash
mkdir -p capture/uno-q images/arduino-inbox
```

On PowerShell:

```powershell
New-Item -ItemType Directory -Force capture/uno-q, images/arduino-inbox
```

Save the following two blocks as plain-text `.py` files at their indicated paths. The existing root `.gitignore` ignores `images/`, so local dish photos stay outside version control. The board script will be copied to the board; the laptop script stays on the laptop.

### 6.1 Board program: `capture/uno-q/uno_q_camera.py`

This program runs once per request. It saves a ZIP containing the JPEG and metadata under `~/scrap-camera/captures/`, then writes that ZIP to SSH's binary output. Diagnostics go to stderr. Reusing a completed capture ID returns its saved bytes without reopening the camera.

```python
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
```

OpenCV's [`read()`](https://docs.opencv.org/4.x/d8/dfe/classcv_1_1VideoCapture.html) supplies the frame; [`imencode()`](https://docs.opencv.org/4.x/d4/da8/group__imgcodecs.html) creates JPEG bytes. The laptop wraps the board command with Debian's `timeout` utility to bound a stalled camera operation.

### 6.2 Laptop program: `capture/uno-q/laptop_capture.py`

This uses only Python's standard library and the laptop's SSH client. It checks the bundle's capture ID, file sizes, UTC timestamp, and JPEG checksum, then publishes a complete local directory. A pending ID survives a failed transfer or laptop-program restart.

```python
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
```

Binary stdout must remain binary: the program does not use a text-decoding subprocess mode for image transfer. Python documents these options in its [`subprocess` reference](https://docs.python.org/3/library/subprocess.html).

## 7. Copy the board program to the Uno Q

Run from the **repository root on the laptop**. Use the target from SSH setup.

**macOS/Linux:**

```bash
UNO_TARGET='arduino@192.168.1.50'
UNO_KEY="$HOME/.ssh/scrap_unoq"
ssh -i "$UNO_KEY" "$UNO_TARGET" 'mkdir -p scrap-camera'
scp -i "$UNO_KEY" capture/uno-q/uno_q_camera.py "${UNO_TARGET}:scrap-camera/uno_q_camera.py"
ssh -i "$UNO_KEY" "$UNO_TARGET" '/usr/bin/python3 scrap-camera/uno_q_camera.py --help'
```

**Windows PowerShell:**

```powershell
$UNO_TARGET = 'arduino@192.168.1.50'
$UNO_KEY = "$HOME/.ssh/scrap_unoq"
ssh -i $UNO_KEY $UNO_TARGET 'mkdir -p scrap-camera'
scp -i $UNO_KEY capture/uno-q/uno_q_camera.py "${UNO_TARGET}:scrap-camera/uno_q_camera.py"
ssh -i $UNO_KEY $UNO_TARGET '/usr/bin/python3 scrap-camera/uno_q_camera.py --help'
```

The help output confirms that the file was deployed and Python can parse it. It does not confirm camera operation yet. The remote path is relative to the SSH account's home directory.

## 8. Take the first photo

Place one dish in view. Keep it still until the laptop prints `Saved`. The default includes about two seconds of focus/exposure warmup plus camera and network overhead.

**Laptop — macOS/Linux, repository root:**

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@192.168.1.50 --once
```

**Laptop — Windows PowerShell, repository root:**

```powershell
python capture/uno-q/laptop_capture.py --target arduino@192.168.1.50 --once
```

Expected output looks like:

```text
Requesting 81d4497e-4b7e-4be6-984a-f34ca214f4e1 ...
Saved: /YOUR/PROJECT/images/arduino-inbox/81d4497e-4b7e-4be6-984a-f34ca214f4e1/photo.jpg
Metadata: /YOUR/PROJECT/images/arduino-inbox/81d4497e-4b7e-4be6-984a-f34ca214f4e1/metadata.json
Actual image: 1920 x 1080 pixels
```

Open the printed `photo.jpg` path in Finder/File Explorer. Confirm that it is the current dish, the shutter is open, and the image is usable. A checksum verifies transfer integrity; it does not prove correct focus, exposure, plate detection, or food-mask quality.

For repeated manual captures, omit `--once`:

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@192.168.1.50
```

Press Enter once for each new dish and wait for success before replacing it. Type `q` to quit. On Windows, use `python` instead of `python3`.

If your device is different or you need a smaller supported mode:

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@192.168.1.50 --device /dev/video2 --width 1280 --height 720 --once
```

Custom key and destination example:

```bash
python3 capture/uno-q/laptop_capture.py --target arduino@192.168.1.50 --identity "$HOME/.ssh/scrap_unoq" --out images/arduino-inbox --once
```

Use the same target, device, dimensions, warmup, remote script, and output folder while retrying a pending request. Run one laptop capture program at a time for that folder. A fresh successful Enter press represents a new dish; the program does not automatically track dishes moving through the scene.

## 9. Output files and project handoff

Each successfully received capture has its own directory:

```text
images/arduino-inbox/
└── 81d4497e-4b7e-4be6-984a-f34ca214f4e1/
    ├── photo.jpg
    └── metadata.json
```

The metadata contains a transport capture UUID, UTC timestamp, actual width/height, camera device, raw-image status, byte length, and SHA-256. It is **local transport metadata**, not a SpacetimeDB row or a project `CaptureEvent` payload. The transport UUID is not the existing adapter's canonical event ID.

When connecting this to your subsequent upload work:

| Local value | Use in the existing capture flow |
| --- | --- |
| Full path to `photo.jpg` | `ReplayCaptureAdapter.ingestFile()` → `imagePath` |
| `metadata.captureId` | Stable `entryId` for that dish across upload retries |
| `metadata.capturedAt` | `capturedAt` |
| Hall/service selected on the laptop | `hallId` and `serviceId`; these are not inferred from the camera |
| Raw width/height | Provenance; do not claim the raw photo is already normalized |

The existing adapter accepts a manual image file, creates the project's event ID, normalizes the image, and uses the backend upload/finalization flow. See [`capture/src/adapter.ts`](capture/src/adapter.ts), [`capture/src/normalize.ts`](capture/src/normalize.ts), and [`capture/README.md`](capture/README.md). Its `ingestFile()` path currently labels the event `manual_upload`; this guide does not add a new canonical hardware source enum.

**Keep the photo raw here.** The project's current normalization is a centered square crop resized to **1024 × 1024**. Fit the entire plate inside the centered square portion of the camera view so that this crop does not cut off leftovers. Keep camera height, angle, and framing consistent; resizing alone does not make differently scaled/perspective captures comparable.

The next stage should upload image bytes to **R2**, confirm the object upload, and then register its durable object reference and metadata in **SpacetimeDB**. Image bytes, base64, or ZIP bundles do not belong in SpacetimeDB. Use the backend's existing storage flow; do not put R2 or SpacetimeDB credentials into either camera-transfer script.

## 10. Retry behavior and retained photos

The laptop creates `.pending.json` before requesting a photo. The board saves `<captureId>.zip` before sending it. The laptop removes the pending record only after it has validated and saved the complete local result.

- If the board completed capture but the network transfer failed, retrying retrieves the same saved JPEG and timestamp.
- If the board never completed capture, retrying takes the first successful photo for that pending ID. **Keep the dish in place until success.**
- Quitting or restarting the laptop program preserves a pending request. Run it again with the same settings to resume.
- Repeatedly photographing a stationary dish after successful saves creates additional captures. The manual trigger is the dish-identity boundary for this prototype.
- A saved local photo is ready for upload; receiving it does not mean R2 or SpacetimeDB has been updated.

The board cache is under `~/scrap-camera/captures/` and is not automatically deleted. It is a temporary local capture cache, separate from the project's durable R2 storage. Check its size on the board with:

```bash
du -sh ~/scrap-camera/captures
df -h ~
```

After verifying the laptop copy and resolving any pending request, you may remove a **specific** transferred ZIP using its printed capture ID:

```bash
rm ~/scrap-camera/captures/81d4497e-4b7e-4be6-984a-f34ca214f4e1.zip
```

Do not delete cached pending photos; doing so removes the ability to retrieve the original frame. If intentionally abandoning a failed request, inspect the board cache first, decide whether to recover the photo, then remove only `images/arduino-inbox/.pending.json` on the laptop. The next trigger will mint a new capture ID. Retention automation is outside this guide.

## 11. Troubleshooting

| Symptom | What to check |
| --- | --- |
| Board does not boot, or camera is absent from `lsusb` | Hub is externally powered, PD input is connected, hub upstream lead reaches the board, camera is in a data port, and supply/cable meet the board/hub requirements. |
| SSH connection times out | Correct board IP, both devices on a reachable network, no guest/client isolation or VPN routing issue. Try the IP instead of `.local`; use App Lab/board shell to inspect `hostname -I`. |
| `Permission denied (publickey,...)` | Run the batch-mode SSH readiness test. Verify the public key was installed for the right account, the chosen private key matches, and its passphrase is unlocked with `ssh-add`. |
| `Host key verification failed` | Connect manually and verify the board identity. If the board was reflashed, confirm that fact before replacing its old known-host entry. |
| `No module named cv2` | Install `python3-opencv` on the **board** and use `/usr/bin/python3`, as the code does. The laptop does not need OpenCV. |
| Cannot open camera, black frame, or empty frame | Open shutter, choose the video-capture node, check membership in `video`, and close other camera applications. |
| SSH/camera exits with code `124`, or laptop times out | The bounded camera command stalled. Check camera/hub, close competing processes, then retry the pending ID. Lower the requested mode only after resolving/abandoning the pending request. |
| `Another capture is using the camera` | Wait for the current request or its 20-second timeout, then retry. Use one operator and capture program. |
| Different settings error | `.pending.json` records the previous settings. Resume using them; inspect/recover a cached photo before deliberately abandoning the request. |
| ZIP parse or JPEG checksum failure | Retry the same pending ID. Keep all board logs on stderr; do not add stdout banners to the board script or noninteractive shell startup files. Inspect the cached ZIP if repeated retries fail. |
| Image is smaller than requested | The driver negotiated another mode. Inspect `--list-formats-ext`; actual dimensions are printed and saved. |
| Image is blurry/dark or plate is clipped | Improve lighting/framing, hold the dish still, and allow warmup. Inspect the center-square framing used by project normalization. |
| Disk fills up | Check board cache and laptop inbox sizes. Remove only verified, transferred captures under an agreed retention policy. |

If event Wi-Fi prevents device-to-device access, use a hotspot/router that allows it, or connect the board through the hub's Ethernet port to the same reachable LAN as the laptop. SSH needs local connectivity; it does not require a cloud service to transfer photos. Initial software installation still needs package access.

## 12. Acceptance checks and verification status

Before using this in the demonstration:

1. The board is reachable over SSH with its webcam connected through the powered hub.
2. One `--once` command produces a JPEG that opens on the laptop and shows the current dish.
3. Three successful triggers produce three directories with different capture IDs.
4. During a capture, temporarily interrupt network connectivity, restore it, and rerun with the same settings. If the board completed the first capture, verify that its cached JPEG is reused and that only one completed laptop directory exists for that ID.
5. Disconnect the camera before a new trigger. Confirm an explicit error and pending ID rather than an empty successful photo. Reconnect, keep the intended dish present, and retry.
6. Confirm that the files remain after restarting the laptop program and that no R2/SpacetimeDB operation occurred just from receiving them.

**Verification at authoring — passed:** Both embedded Python programs parse successfully. Local checks with a simulated OpenCV camera and SSH command covered single and repeated captures, an interrupted transfer after board caching, restart/retry without recapturing, actual negotiated dimensions, a missing camera and reconnection, protected pending settings, interactive capture/quit, malformed bundles, checksum/ID/size/timestamp/geometry validation, and conflicting local results. A real synthetic JPEG was transferred unchanged and decoded successfully. These checks did not exercise a Uno Q, C920s, powered hub, live SSH/Wi-Fi connection, or database upload. Hardware acceptance remains the team's next step.

Assumptions: Uno Q Debian image with SSH and GNU `timeout`, a reachable local network, a supported webcam video mode, sufficient local storage, one manual operator, and existing project normalization/upload integration after receipt. The scripts deliberately record raw photos and local provenance; they do not implement plate detection, conveyor triggering, automatic dish tracking, or image analysis.
