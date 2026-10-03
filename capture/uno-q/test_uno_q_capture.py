#!/usr/bin/env python3
"""Simulated checks for the Uno Q capture scripts (no board, camera, or network).

A fake `cv2` module stands in for the C920s and a fake `ssh` executable runs the
board script locally in a temporary "board home". Run from the repository root:

    python3 -m unittest discover -s capture/uno-q -v
"""

import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
import uuid
import zipfile

HERE = Path(__file__).resolve().parent
BOARD_SCRIPT = HERE / "uno_q_camera.py"
LAPTOP_SCRIPT = HERE / "laptop_capture.py"
FIXTURE_JPEG = HERE.parent / "fixtures" / "replay" / "images" / "dinner-1003-salmon-rice.jpg"
TARGET = "arduino@192.168.1.50"

FAKE_CV2 = '''
import os

CAP_V4L2 = 200
CAP_PROP_FRAME_WIDTH = 3
CAP_PROP_FRAME_HEIGHT = 4
CAP_PROP_FPS = 5
CAP_PROP_FOURCC = 6
IMWRITE_JPEG_QUALITY = 1


def VideoWriter_fourcc(*code):
    return sum(ord(c) << (8 * i) for i, c in enumerate(code))


class _Frame:
    def __init__(self, width, height):
        self.shape = (height, width, 3)
        self.size = width * height * 3


class _Encoded:
    def __init__(self, data):
        self._data = data

    def tobytes(self):
        return self._data


class VideoCapture:
    def __init__(self, device, api):
        with open(os.environ["FAKE_CAMERA_OPEN_LOG"], "a") as log:
            log.write(device + "\\n")
        self._opened = os.environ.get("FAKE_CAMERA_MISSING") != "1"
        self._props = {}

    def isOpened(self):
        return self._opened

    def set(self, prop, value):
        self._props[prop] = value
        return True

    def read(self):
        negotiated = os.environ.get("FAKE_CAMERA_SIZE")
        if negotiated:
            width, height = (int(v) for v in negotiated.split("x"))
        else:
            width = int(self._props[CAP_PROP_FRAME_WIDTH])
            height = int(self._props[CAP_PROP_FRAME_HEIGHT])
        return True, _Frame(width, height)

    def release(self):
        pass


def imencode(ext, frame, params):
    with open(os.environ["FAKE_CV2_JPEG"], "rb") as file:
        return True, _Encoded(file.read())
'''

FAKE_SSH = '''#!{python}
import json, os, shlex, subprocess, sys

args = sys.argv[1:]
with open(os.environ["FAKE_SSH_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
i = 0
while args[i].startswith("-"):
    i += 2 if args[i] in ("-i", "-o") else 1
remote = shlex.split(args[i + 1])
prefix = ["timeout", "--signal=TERM", "--kill-after=2s", "20s", "/usr/bin/python3"]
if remote[:5] != prefix:
    sys.exit("fake ssh: unexpected remote command " + args[i + 1])
home = os.environ["FAKE_BOARD_HOME"]
result = subprocess.run(
    [sys.executable] + remote[5:], cwd=home,
    env=dict(os.environ, HOME=home), stdout=subprocess.PIPE,
)
if os.environ.get("FAKE_SSH_DROP") == "1":
    sys.stderr.write("Connection to board closed by remote host.\\n")
    sys.exit(255)
data = result.stdout
if os.environ.get("FAKE_SSH_CORRUPT") == "1" and len(data) > 200:
    data = data[:100] + bytes([data[100] ^ 0xFF]) + data[101:]
sys.stdout.buffer.write(data)
sys.exit(result.returncode)
'''


def load_laptop_module():
    spec = importlib.util.spec_from_file_location("laptop_capture", LAPTOP_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


laptop = load_laptop_module()


class SimulatedRig(unittest.TestCase):
    """Laptop script → fake ssh → board script → fake cv2."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="unoq-test-"))
        self.addCleanup(shutil.rmtree, self.root)
        self.board_home = self.root / "board-home"
        (self.board_home / "scrap-camera").mkdir(parents=True)
        shutil.copy(BOARD_SCRIPT, self.board_home / "scrap-camera" / "uno_q_camera.py")
        self.cache = self.board_home / "scrap-camera" / "captures"
        fake_lib = self.root / "fake-lib"
        fake_lib.mkdir()
        (fake_lib / "cv2.py").write_text(FAKE_CV2)
        fake_bin = self.root / "bin"
        fake_bin.mkdir()
        ssh = fake_bin / "ssh"
        ssh.write_text(FAKE_SSH.format(python=sys.executable))
        ssh.chmod(0o755)
        self.out = self.root / "laptop" / "images" / "arduino-inbox"
        self.open_log = self.root / "camera-opens.log"
        self.open_log.touch()
        self.ssh_log = self.root / "ssh.log"
        self.env = dict(
            os.environ,
            PATH=f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
            PYTHONPATH=str(fake_lib),
            FAKE_BOARD_HOME=str(self.board_home),
            FAKE_CAMERA_OPEN_LOG=str(self.open_log),
            FAKE_SSH_LOG=str(self.ssh_log),
            FAKE_CV2_JPEG=str(FIXTURE_JPEG),
        )

    def run_laptop(self, *extra, stdin=None, **env):
        command = [
            sys.executable, str(LAPTOP_SCRIPT), "--target", TARGET,
            "--identity", str(self.root / "fake_key"), "--out", str(self.out),
            "--warmup", "0", *extra,
        ]
        return subprocess.run(
            command, input=stdin, capture_output=True, text=True, timeout=60,
            env=dict(self.env, **env),
        )

    def camera_opens(self):
        return len(self.open_log.read_text().splitlines())

    def capture_dirs(self):
        return sorted(p for p in self.out.iterdir() if p.is_dir() and not p.name.startswith("."))

    def pending_id(self):
        return json.loads((self.out / ".pending.json").read_text())["captureId"]

    def assert_saved(self, directory):
        photo = (directory / "photo.jpg").read_bytes()
        metadata = json.loads((directory / "metadata.json").read_text())
        self.assertEqual(photo, FIXTURE_JPEG.read_bytes())
        self.assertEqual(metadata["captureId"], directory.name)
        self.assertEqual(metadata["sha256"], hashlib.sha256(photo).hexdigest())
        self.assertEqual(metadata["byteLength"], len(photo))
        self.assertTrue(metadata["capturedAt"].endswith("Z"))
        self.assertIs(metadata["normalized"], False)
        return metadata

    def test_single_capture(self):
        result = self.run_laptop("--once")
        self.assertEqual(result.returncode, 0, result.stderr)
        [directory] = self.capture_dirs()
        metadata = self.assert_saved(directory)
        self.assertEqual((metadata["widthPx"], metadata["heightPx"]), (1920, 1080))
        self.assertEqual(metadata["device"], "/dev/video0")
        self.assertFalse((self.out / ".pending.json").exists())
        self.assertIn("Actual image: 1920 x 1080 pixels", result.stdout)
        self.assertTrue((self.cache / f"{directory.name}.zip").exists())
        invocation = json.loads(self.ssh_log.read_text().splitlines()[0])
        self.assertIn("BatchMode=yes", invocation)
        self.assertIn(TARGET, invocation)

    def test_real_jpeg_decodes_after_transfer(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow not installed")
        self.assertEqual(self.run_laptop("--once").returncode, 0)
        [directory] = self.capture_dirs()
        with Image.open(directory / "photo.jpg") as image:
            image.load()
            self.assertEqual(image.format, "JPEG")

    def test_three_triggers_make_three_captures(self):
        for _ in range(3):
            self.assertEqual(self.run_laptop("--once").returncode, 0)
        self.assertEqual(len({d.name for d in self.capture_dirs()}), 3)
        self.assertEqual(self.camera_opens(), 3)

    def test_negotiated_dimensions_are_recorded(self):
        result = self.run_laptop("--once", FAKE_CAMERA_SIZE="1280x720")
        self.assertEqual(result.returncode, 0, result.stderr)
        [directory] = self.capture_dirs()
        metadata = self.assert_saved(directory)
        self.assertEqual((metadata["widthPx"], metadata["heightPx"]), (1280, 720))
        self.assertEqual((metadata["requestedWidthPx"], metadata["requestedHeightPx"]), (1920, 1080))

    def test_interrupted_transfer_reuses_board_cache(self):
        failed = self.run_laptop("--once", FAKE_SSH_DROP="1")
        self.assertEqual(failed.returncode, 1)
        self.assertIn("Pending ID retained", failed.stderr)
        capture_id = self.pending_id()
        self.assertTrue((self.cache / f"{capture_id}.zip").exists())
        self.assertEqual(self.capture_dirs(), [])

        retried = self.run_laptop("--once")
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertIn(capture_id, retried.stdout)
        self.assertEqual([d.name for d in self.capture_dirs()], [capture_id])
        self.assertEqual(self.camera_opens(), 1, "retry must not reopen the camera")
        self.assertFalse((self.out / ".pending.json").exists())

    def test_corrupted_transfer_is_rejected_then_recovered(self):
        failed = self.run_laptop("--once", FAKE_SSH_CORRUPT="1")
        self.assertEqual(failed.returncode, 1)
        self.assertIn("Capture failed", failed.stderr)
        capture_id = self.pending_id()
        self.assertEqual(self.capture_dirs(), [])
        retried = self.run_laptop("--once")
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertEqual([d.name for d in self.capture_dirs()], [capture_id])
        self.assertEqual(self.camera_opens(), 1)

    def test_missing_camera_then_reconnect(self):
        failed = self.run_laptop("--once", FAKE_CAMERA_MISSING="1")
        self.assertEqual(failed.returncode, 1)
        self.assertIn("Cannot open /dev/video0", failed.stderr)
        capture_id = self.pending_id()
        self.assertEqual(list(self.cache.glob("*.zip")), [])
        self.assertEqual(self.capture_dirs(), [])

        retried = self.run_laptop("--once")
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertEqual([d.name for d in self.capture_dirs()], [capture_id])

    def test_pending_settings_are_protected(self):
        self.run_laptop("--once", FAKE_CAMERA_MISSING="1")
        changed = self.run_laptop("--once", "--width", "1280", "--height", "720")
        self.assertEqual(changed.returncode, 1)
        self.assertIn("different settings", changed.stderr)
        self.assertTrue((self.out / ".pending.json").exists())
        self.assertEqual(self.capture_dirs(), [])

    def test_camera_lock_rejects_concurrent_capture(self):
        self.cache.mkdir(parents=True)
        with (self.cache / ".camera.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            failed = self.run_laptop("--once")
        self.assertEqual(failed.returncode, 1)
        self.assertIn("Another capture is using the camera", failed.stderr)
        self.assertEqual(self.camera_opens(), 0)
        self.assertEqual(self.run_laptop("--once").returncode, 0)

    def test_interactive_capture_and_quit(self):
        result = self.run_laptop(stdin="\nignored\nq\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.capture_dirs()), 1)
        self.assertEqual(result.stdout.count("Saved:"), 1)

    def test_interactive_eof_preserves_pending(self):
        result = self.run_laptop(stdin="", FAKE_CAMERA_MISSING="1")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Stopped", result.stdout)

    def test_board_rejects_non_canonical_capture_id(self):
        result = subprocess.run(
            [sys.executable, str(BOARD_SCRIPT), "--capture-id", "not-a-uuid",
             "--cache-dir", str(self.cache)],
            capture_output=True, env=self.env, timeout=30,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(self.camera_opens(), 0)

    def test_laptop_rejects_bad_target(self):
        result = subprocess.run(
            [sys.executable, str(LAPTOP_SCRIPT), "--target", "arduino@board; rm -rf ~", "--once"],
            capture_output=True, text=True, env=self.env, timeout=30,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("SSH target", result.stderr)


def make_bundle(photo=None, compress=zipfile.ZIP_STORED, extra=None, **overrides):
    photo = FIXTURE_JPEG.read_bytes() if photo is None else photo
    capture_id = overrides.pop("captureId", "81d4497e-4b7e-4be6-984a-f34ca214f4e1")
    metadata = {
        "protocolVersion": 1, "captureId": capture_id,
        "capturedAt": "2026-10-03T17:00:00.123456Z",
        "timestampBasis": "board_frame_received", "captureSource": "uno_q_usb_camera",
        "device": "/dev/video0", "mimeType": "image/jpeg",
        "widthPx": 1920, "heightPx": 1080,
        "requestedWidthPx": 1920, "requestedHeightPx": 1080,
        "normalized": False, "byteLength": len(photo),
        "sha256": hashlib.sha256(photo).hexdigest(),
    }
    metadata.update(overrides)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=compress) as bundle:
        bundle.writestr("photo.jpg", photo)
        bundle.writestr("metadata.json", json.dumps(metadata))
        for name, content in (extra or {}).items():
            bundle.writestr(name, content)
    return stream.getvalue()


class ValidateBundle(unittest.TestCase):
    capture_id = "81d4497e-4b7e-4be6-984a-f34ca214f4e1"

    def assert_rejected(self, data, message=None):
        with self.assertRaises(Exception) as caught:
            laptop.validate_bundle(data, self.capture_id)
        if message:
            self.assertIn(message, str(caught.exception))

    def test_accepts_valid_bundle(self):
        photo, metadata = laptop.validate_bundle(make_bundle(), self.capture_id)
        self.assertEqual(photo, FIXTURE_JPEG.read_bytes())
        self.assertEqual(metadata["captureId"], self.capture_id)

    def test_rejects_empty_and_garbage(self):
        self.assert_rejected(b"", "empty or too large")
        self.assert_rejected(b"Welcome to the Uno Q!\n" * 100)

    def test_prepended_banner_still_yields_verified_photo(self):
        # zipfile tolerates leading bytes; the checksum still guards the content.
        photo, _ = laptop.validate_bundle(b"Welcome!\n" + make_bundle(), self.capture_id)
        self.assertEqual(photo, FIXTURE_JPEG.read_bytes())

    def test_rejects_other_capture_id(self):
        self.assert_rejected(make_bundle(captureId=str(uuid.uuid4())), "different capture ID")

    def test_rejects_wrong_protocol(self):
        self.assert_rejected(make_bundle(protocolVersion=2), "protocol")

    def test_rejects_extra_files_and_compression(self):
        self.assert_rejected(make_bundle(extra={"../evil": "x"}), "Unexpected files")
        self.assert_rejected(make_bundle(compress=zipfile.ZIP_DEFLATED), "compression")

    def test_rejects_bad_geometry_and_format(self):
        self.assert_rejected(make_bundle(widthPx=0), "widthPx")
        self.assert_rejected(make_bundle(heightPx=1080.0), "heightPx")
        self.assert_rejected(make_bundle(normalized=True), "geometry")
        self.assert_rejected(make_bundle(mimeType="image/png"), "format")

    def test_rejects_non_utc_timestamp(self):
        self.assert_rejected(make_bundle(capturedAt="2026-10-03T13:00:00-04:00"), "UTC")
        self.assert_rejected(make_bundle(capturedAt="2026-10-03T17:00:00"), "UTC")

    def test_rejects_incomplete_jpeg_and_bad_checksum(self):
        truncated = FIXTURE_JPEG.read_bytes()[:-10]
        self.assert_rejected(make_bundle(photo=truncated), "complete JPEG")
        self.assert_rejected(make_bundle(sha256="0" * 64), "checksum")
        self.assert_rejected(make_bundle(byteLength=1), "byte count")


class SaveCapture(unittest.TestCase):
    def setUp(self):
        self.out = Path(tempfile.mkdtemp(prefix="unoq-save-"))
        self.addCleanup(shutil.rmtree, self.out)
        self.photo, self.metadata = laptop.validate_bundle(
            make_bundle(), "81d4497e-4b7e-4be6-984a-f34ca214f4e1"
        )

    def test_identical_resave_is_idempotent(self):
        first = laptop.save_capture(self.out, self.photo, self.metadata)
        second = laptop.save_capture(self.out, self.photo, self.metadata)
        self.assertEqual(first, second)
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), [self.metadata["captureId"]])

    def test_conflicting_local_result_is_refused(self):
        laptop.save_capture(self.out, self.photo, self.metadata)
        other = dict(self.metadata, capturedAt="2026-10-03T18:00:00Z")
        with self.assertRaisesRegex(ValueError, "different local photo"):
            laptop.save_capture(self.out, self.photo, other)


if __name__ == "__main__":
    unittest.main()
