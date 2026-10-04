#!/usr/bin/env python3
"""Simulated checks for the Uno Q capture scripts (no board, camera, or network).

A fake FFmpeg streams fixture JPEGs and a fake `ssh` executable runs the board
script locally in a temporary "board home". OpenCV imports are deliberately
blocked. Run from the repository root:

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
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid
import zipfile

HERE = Path(__file__).resolve().parent
BOARD_SCRIPT = HERE / "uno_q_camera.py"
LAPTOP_SCRIPT = HERE / "laptop_capture.py"
FIXTURE_JPEG = HERE.parent / "fixtures" / "replay" / "images" / "dinner-1003-salmon-rice.jpg"
TARGET = "arduino@192.168.1.50"

FAKE_SSH = '''#!{python}
import json, os, shlex, signal, subprocess, sys

args = sys.argv[1:]
with open(os.environ["FAKE_SSH_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
i = 0
while args[i].startswith("-"):
    i += 2 if args[i] in ("-i", "-o") else 1
remote = shlex.split(args[i + 1])
prefix = ["timeout", "--signal=TERM", "--kill-after=2s", "20s", "/usr/bin/python3"]
if remote[:5] == prefix:
    script_args = remote[5:]
elif remote[:1] == ["/usr/bin/python3"] and "--stream" in remote:
    script_args = remote[1:]
else:
    sys.exit("fake ssh: unexpected remote command " + args[i + 1])
home = os.environ["FAKE_BOARD_HOME"]
if "--stream" in remote:
    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))
    process = subprocess.Popen(
        [sys.executable] + script_args, cwd=home,
        env=dict(os.environ, HOME=home), stdout=subprocess.PIPE,
    )
    try:
        while True:
            data = os.read(process.stdout.fileno(), 64 * 1024)
            if not data:
                sys.exit(process.wait())
            if os.environ.get("FAKE_SSH_DROP") == "1":
                sys.stdout.buffer.write(data[:10])
                sys.stdout.buffer.flush()
                sys.exit(255)
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    finally:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=5)
result = subprocess.run(
    [sys.executable] + script_args, cwd=home,
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

FAKE_FFMPEG = '''#!{python}
import json, os, signal, sys, time

with open(os.environ["FAKE_FFMPEG_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
if os.environ.get("FAKE_CAMERA_MISSING") == "1":
    sys.stderr.write("Cannot open /dev/video0: camera disconnected\\n")
    sys.exit(1)
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
with open(os.environ["FAKE_CAMERA_JPEG"], "rb") as file:
    photo = file.read()
photo += bytes.fromhex(os.environ.get("FAKE_JPEG_PADDING", ""))
headers = b"--ffmpeg\\r\\nContent-type: image/jpeg\\r\\nContent-length: " + str(len(photo)).encode() + b"\\r\\n\\r\\n"
empty = b"--ffmpeg\\r\\nContent-type: image/jpeg\\r\\nContent-length: 0\\r\\n\\r\\n\\r\\n"
for _ in range(int(os.environ.get("FAKE_EMPTY_FRAMES", "0"))):
    sys.stdout.buffer.write(empty)
    sys.stdout.buffer.flush()
while True:
    sys.stdout.buffer.write(headers + photo + b"\\r\\n")
    sys.stdout.buffer.flush()
    time.sleep(0.025)
'''


FAKE_V4L2 = '''#!{python}
import json, os, sys

args = sys.argv[1:]
with open(os.environ["FAKE_V4L2_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
state = os.environ["FAKE_V4L2_STATE"]
if "-C" in args:
    value = open(state).read() if os.path.exists(state) else "250"
    print("focus_absolute: " + value)
    sys.exit(0)
controls = [args[i + 1] for i, a in enumerate(args) if a == "-c"]
if os.environ.get("FAKE_V4L2_OLD_KERNEL") == "1" and any(c.startswith("focus_automatic_continuous") for c in controls):
    sys.stderr.write("unknown control 'focus_automatic_continuous'\\n")
    sys.exit(1)
if os.environ.get("FAKE_V4L2_BROKEN") == "1":
    sys.stderr.write("VIDIOC_S_EXT_CTRLS: failed: Input/output error\\n")
    sys.exit(1)
# Like the real C920 (live 2026-10-04): focus_absolute is inactive while autofocus is on, and a
# combined set is atomic, so "-c focus_automatic_continuous=0 -c focus_absolute=0" fails as a whole.
auto_file = state + ".auto"
auto_on = not os.path.exists(auto_file) or open(auto_file).read() != "0"
if auto_on and any(c.startswith("focus_absolute=") for c in controls):
    sys.stderr.write("VIDIOC_S_EXT_CTRLS: failed: Permission denied\\n")
    sys.exit(1)
for control in controls:
    if control.startswith("focus_absolute="):
        open(state, "w").write(control.split("=", 1)[1])
    if control.split("=")[0] in ("focus_automatic_continuous", "focus_auto"):
        open(auto_file, "w").write(control.split("=", 1)[1])
'''


def load_laptop_module():
    spec = importlib.util.spec_from_file_location("laptop_capture", LAPTOP_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


laptop = load_laptop_module()
board_spec = importlib.util.spec_from_file_location("uno_q_camera", BOARD_SCRIPT)
board = importlib.util.module_from_spec(board_spec)
board_spec.loader.exec_module(board)


class SimulatedRig(unittest.TestCase):
    """Laptop script → fake ssh → board script → fake FFmpeg."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="unoq-test-"))
        self.addCleanup(shutil.rmtree, self.root)
        self.board_home = self.root / "board-home"
        (self.board_home / "scrap-camera").mkdir(parents=True)
        shutil.copy(BOARD_SCRIPT, self.board_home / "scrap-camera" / "uno_q_camera.py")
        self.cache = self.board_home / "scrap-camera" / "captures"
        fake_lib = self.root / "fake-lib"
        fake_lib.mkdir()
        (fake_lib / "cv2.py").write_text('raise ImportError("OpenCV is intentionally unavailable in this rig")\n')
        fake_bin = self.root / "bin"
        fake_bin.mkdir()
        ssh = fake_bin / "ssh"
        ssh.write_text(FAKE_SSH.format(python=sys.executable))
        ssh.chmod(0o755)
        ffmpeg = fake_bin / "ffmpeg"
        ffmpeg.write_text(FAKE_FFMPEG.format(python=sys.executable))
        ffmpeg.chmod(0o755)
        self.out = self.root / "laptop" / "images" / "arduino-inbox"
        self.open_log = self.root / "ffmpeg.log"
        self.open_log.touch()
        self.ssh_log = self.root / "ssh.log"
        (self.root / "fake_key").touch()
        self.env = dict(
            os.environ,
            PATH=f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
            PYTHONPATH=str(fake_lib),
            FAKE_BOARD_HOME=str(self.board_home),
            FAKE_SSH_LOG=str(self.ssh_log),
            FAKE_CAMERA_JPEG=str(FIXTURE_JPEG),
            FAKE_FFMPEG_LOG=str(self.open_log),
        )

    def laptop_command(self, *extra):
        return [
            sys.executable, str(LAPTOP_SCRIPT), "--target", TARGET,
            "--identity", str(self.root / "fake_key"), "--out", str(self.out),
            "--warmup", "0", *extra,
        ]

    def run_laptop(self, *extra, stdin=None, **env):
        return subprocess.run(
            self.laptop_command(*extra), input=stdin, capture_output=True, text=True, timeout=60,
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
        dimensions = board.jpeg_dimensions(FIXTURE_JPEG.read_bytes())
        self.assertEqual((metadata["widthPx"], metadata["heightPx"]), dimensions)
        self.assertEqual((metadata["requestedWidthPx"], metadata["requestedHeightPx"]), (1920, 1080))
        self.assertEqual(metadata["device"], "/dev/video0")
        self.assertFalse((self.out / ".pending.json").exists())
        self.assertIn(f"Actual image: {dimensions[0]} x {dimensions[1]} pixels", result.stdout)
        self.assertTrue((self.cache / f"{directory.name}.zip").exists())
        invocation = json.loads(self.ssh_log.read_text().splitlines()[0])
        self.assertIn("BatchMode=yes", invocation)
        self.assertIn(TARGET, invocation)
        [camera_args] = [json.loads(line) for line in self.open_log.read_text().splitlines()]
        self.assertEqual(camera_args[camera_args.index("-c:v") + 1], "copy")
        self.assertEqual(camera_args[camera_args.index("-input_format") + 1], "mjpeg")

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
        result = self.run_laptop("--once", "--width", "1280", "--height", "720")
        self.assertEqual(result.returncode, 0, result.stderr)
        [directory] = self.capture_dirs()
        metadata = self.assert_saved(directory)
        self.assertEqual((metadata["widthPx"], metadata["heightPx"]), board.jpeg_dimensions(FIXTURE_JPEG.read_bytes()))
        self.assertEqual((metadata["requestedWidthPx"], metadata["requestedHeightPx"]), (1280, 720))

    def test_interrupted_transfer_reuses_board_cache(self):
        failed = self.run_laptop("--once", FAKE_SSH_DROP="1")
        self.assertEqual(failed.returncode, 1)
        self.assertIn("Pending ID retained", failed.stderr)
        capture_id = self.pending_id()
        self.assertTrue((self.cache / f"{capture_id}.zip").exists())
        self.assertEqual(self.capture_dirs(), [])

        retried = self.run_laptop("--once", FAKE_CAMERA_MISSING="1")
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

    def test_manual_warmup_and_repeated_capture_release_camera(self):
        from datetime import datetime
        result = self.run_laptop("--warmup", "0.1", stdin="\n\nq\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        directories = self.capture_dirs()
        self.assertEqual(len(directories), 2)
        timestamps = sorted(
            datetime.fromisoformat(self.assert_saved(directory)["capturedAt"].replace("Z", "+00:00"))
            for directory in directories
        )
        self.assertGreaterEqual((timestamps[1] - timestamps[0]).total_seconds(), 0.1)
        self.assertEqual(self.camera_opens(), 2)

    def test_manual_recovers_from_empty_packets_and_camera_padding(self):
        result = self.run_laptop("--once", FAKE_EMPTY_FRAMES="3", FAKE_JPEG_PADDING=(b"x" * 31).hex())
        self.assertEqual(result.returncode, 0, result.stderr)
        [directory] = self.capture_dirs()
        self.assert_saved(directory)

    def test_manual_invalid_or_empty_frames_are_unavailable(self):
        invalid_photo = self.root / "truncated.jpg"
        invalid_photo.write_bytes(FIXTURE_JPEG.read_bytes()[:-2])
        for settings, message in (({"FAKE_EMPTY_FRAMES": "90"}, "90 consecutive empty frames"),
                                  ({"FAKE_CAMERA_JPEG": str(invalid_photo)}, "incomplete JPEG"),
                                  ({"FAKE_JPEG_PADDING": (b"x" * 33).hex()}, "excessive trailing data")):
            with self.subTest(settings=settings):
                result = self.run_laptop("--once", **settings)
                self.assertEqual(result.returncode, 1)
                self.assertIn(message, result.stderr)
                self.assertEqual(self.capture_dirs(), [])
                self.assertEqual(list(self.cache.glob("*.zip")), [])
        self.assertEqual(self.run_laptop("--once").returncode, 0)

    def test_manual_missing_ffmpeg_has_actionable_error(self):
        (self.root / "bin" / "ffmpeg").unlink()
        result = self.run_laptop("--once", PATH=str(self.root / "bin"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("sudo apt install ffmpeg on the board", result.stderr)
        self.assertTrue((self.out / ".pending.json").exists())
        self.assertEqual(self.capture_dirs(), [])
        self.assertEqual(list(self.cache.glob("*.zip")), [])

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

    def test_automatic_photos_every_second_without_opencv(self):
        result = self.run_laptop("--auto", "--count", "3")
        self.assertEqual(result.returncode, 0, result.stderr)
        directories = self.capture_dirs()
        self.assertEqual(len(directories), 3)
        timestamps = []
        from datetime import datetime
        for directory in directories:
            metadata = self.assert_saved(directory)
            self.assertEqual(metadata["triggerSource"], "interval")
            self.assertEqual(metadata["dishIdentity"], "unresolved")
            self.assertEqual(metadata["intervalSeconds"], 1)
            self.assertEqual((metadata["widthPx"], metadata["heightPx"]), board.jpeg_dimensions(FIXTURE_JPEG.read_bytes()))
            timestamps.append(datetime.fromisoformat(metadata["capturedAt"].replace("Z", "+00:00")))
        timestamps.sort()
        for before, after in zip(timestamps, timestamps[1:]):
            self.assertGreater((after - before).total_seconds(), 0.85)
            self.assertLess((after - before).total_seconds(), 1.5)
        self.assertEqual(self.camera_opens(), 1, "automatic capture must keep one FFmpeg session")
        self.assertEqual(len(self.ssh_log.read_text().splitlines()), 1)
        [invocation] = (self.root / "ffmpeg.log").read_text().splitlines()
        args = json.loads(invocation)
        self.assertEqual(args[args.index("-c:v") + 1], "copy")
        self.assertEqual(args[args.index("-f", args.index("-c:v")) + 1], "mpjpeg")
        self.assertFalse((self.out / ".pending.json").exists())
        self.assertEqual(list(self.cache.glob("*.zip")), [])

    def test_automatic_stream_releases_camera_lock(self):
        for _ in range(2):
            result = self.run_laptop("--auto", "--interval", "0.1", "--count", "2")
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.capture_dirs()), 4)

    def test_automatic_recovers_from_empty_startup_packets(self):
        result = self.run_laptop("--auto", "--count", "2", "--interval", "0.1", FAKE_EMPTY_FRAMES="3")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.capture_dirs()), 2)
        for directory in self.capture_dirs():
            self.assert_saved(directory)

    def test_automatic_persistent_empty_packets_are_unavailable(self):
        result = self.run_laptop("--auto", "--count", "1", FAKE_EMPTY_FRAMES="90")
        self.assertEqual(result.returncode, 1)
        self.assertIn("90 consecutive empty frames from /dev/video0", result.stderr)
        self.assertEqual(self.capture_dirs(), [])

    def test_password_capture_works_without_an_identity_file(self):
        result = subprocess.run(
            [sys.executable, str(LAPTOP_SCRIPT), "--target", TARGET,
             "--out", str(self.out), "--warmup", "0", "--auto", "--password",
             "--interval", "0.1", "--count", "2"],
            capture_output=True, text=True, timeout=15, env=self.env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.capture_dirs()), 2)
        invocation = json.loads(self.ssh_log.read_text().splitlines()[0])
        self.assertNotIn("-i", invocation)
        self.assertIn("BatchMode=no", invocation)
        self.assertIn("Arduino/App Lab board password", result.stdout)

    def test_continuous_automatic_capture_stops_on_ctrl_c(self):
        process = subprocess.Popen(
            self.laptop_command("--auto", "--interval", "0.1"),
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=self.env,
        )
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if self.out.exists() and len(self.capture_dirs()) >= 2:
                    break
                if process.poll() is not None:
                    self.fail("Automatic capture stopped before two photos arrived.")
                time.sleep(0.025)
            else:
                self.fail("Automatic photos did not arrive within 10 seconds.")
            process.send_signal(signal.SIGINT)
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertIn("Stopped", stdout)
            for directory in self.capture_dirs():
                self.assert_saved(directory)
            result = self.run_laptop("--auto", "--count", "1")
            self.assertEqual(result.returncode, 0, result.stderr)
        finally:
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=10)

    def test_automatic_missing_camera_is_an_explicit_failure(self):
        result = self.run_laptop("--auto", "--count", "2", FAKE_CAMERA_MISSING="1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("camera disconnected", result.stderr)
        self.assertEqual(self.capture_dirs(), [])

    def test_automatic_camera_padding_is_removed_before_transfer(self):
        padding = b"x" * 29 + b"\xff\xd9"
        result = self.run_laptop(
            "--auto", "--interval", "0.1", "--count", "2",
            FAKE_JPEG_PADDING=padding.hex(),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.capture_dirs()), 2)
        for directory in self.capture_dirs():
            self.assert_saved(directory)

    def test_automatic_truncated_transfer_saves_no_incomplete_photo(self):
        result = self.run_laptop("--auto", "--count", "2", FAKE_SSH_DROP="1")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.capture_dirs(), [])
        self.assertIn("Complete saved photos are retained", result.stderr)

    def test_automatic_respects_pending_manual_capture(self):
        self.run_laptop("--once", FAKE_CAMERA_MISSING="1")
        pending = self.pending_id()
        result = self.run_laptop("--auto", "--count", "1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("manual capture is pending", result.stderr)
        self.assertEqual(self.pending_id(), pending)

    def test_automatic_rejects_invalid_interval_and_mode(self):
        for options in (("--auto", "--interval", "0"), ("--auto", "--interval", "nan"),
                        ("--auto", "--count", "-1"), ("--auto", "--once")):
            self.assertEqual(self.run_laptop(*options).returncode, 2)


class FocusLock(unittest.TestCase):
    """C920s focus lock through a fake v4l2-ctl (IT_4 I3). Reuses the rig without rerunning its tests."""

    laptop_command = SimulatedRig.laptop_command
    run_laptop = SimulatedRig.run_laptop
    capture_dirs = SimulatedRig.capture_dirs
    assert_saved = SimulatedRig.assert_saved

    def setUp(self):
        SimulatedRig.setUp(self)
        v4l2 = self.root / "bin" / "v4l2-ctl"
        v4l2.write_text(FAKE_V4L2.format(python=sys.executable))
        v4l2.chmod(0o755)
        self.v4l2_log = self.root / "v4l2.log"
        self.v4l2_log.touch()
        self.env.update(FAKE_V4L2_LOG=str(self.v4l2_log), FAKE_V4L2_STATE=str(self.root / "v4l2.state"))

    def v4l2_calls(self):
        return [json.loads(line) for line in self.v4l2_log.read_text().splitlines()]

    def test_focus_is_locked_before_capture_and_recorded(self):
        result = self.run_laptop("--once")
        self.assertEqual(result.returncode, 0, result.stderr)
        [directory] = self.capture_dirs()
        metadata = self.assert_saved(directory)
        self.assertEqual(metadata["focus"], {"lock": "locked", "control": "focus_automatic_continuous", "absolute": 0})
        calls = self.v4l2_calls()
        self.assertEqual(calls[0], ["-d", "/dev/video0", "-c", "focus_automatic_continuous=0"])
        self.assertEqual(calls[1], ["-d", "/dev/video0", "-c", "focus_absolute=0"])
        self.assertIn("-C", calls[2])
        self.assertIn("Focus: locked (focus_automatic_continuous=0, focus_absolute=0)", result.stdout)

    def test_older_kernel_falls_back_to_focus_auto(self):
        result = self.run_laptop("--once", FAKE_V4L2_OLD_KERNEL="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        [directory] = self.capture_dirs()
        self.assertEqual(self.assert_saved(directory)["focus"]["control"], "focus_auto")
        calls = self.v4l2_calls()
        self.assertIn(["-d", "/dev/video0", "-c", "focus_auto=0"], calls)
        self.assertEqual(calls[calls.index(["-d", "/dev/video0", "-c", "focus_auto=0"]) + 1],
                         ["-d", "/dev/video0", "-c", "focus_absolute=0"])

    def test_focus_absolute_is_configurable(self):
        result = self.run_laptop("--once", "--focus-absolute", "40")
        self.assertEqual(result.returncode, 0, result.stderr)
        [directory] = self.capture_dirs()
        self.assertEqual(self.assert_saved(directory)["focus"]["absolute"], 40)
        invocation = json.loads(self.ssh_log.read_text().splitlines()[0])
        self.assertIn("--focus-absolute 40", invocation[-1])

    def test_default_focus_is_not_passed_so_older_board_scripts_still_run(self):
        self.assertEqual(self.run_laptop("--once").returncode, 0)
        invocation = json.loads(self.ssh_log.read_text().splitlines()[0])
        self.assertNotIn("focus", invocation[-1])

    def test_no_focus_lock_skips_v4l2(self):
        result = self.run_laptop("--once", "--no-focus-lock")
        self.assertEqual(result.returncode, 0, result.stderr)
        [directory] = self.capture_dirs()
        self.assertEqual(self.assert_saved(directory)["focus"]["lock"], "disabled")
        self.assertEqual(self.v4l2_calls(), [])
        self.assertEqual(self.run_laptop("--once", "--no-focus-lock", "--focus-absolute", "5").returncode, 2)

    def test_v4l2_failure_never_fails_the_capture(self):
        result = self.run_laptop("--once", FAKE_V4L2_BROKEN="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        [directory] = self.capture_dirs()
        focus = self.assert_saved(directory)["focus"]
        self.assertEqual(focus["lock"], "failed")
        self.assertIn("Input/output error", focus["detail"])
        self.assertIn("Focus: NOT locked (failed", result.stdout)

    def test_stream_locks_once_and_records_focus_per_frame(self):
        result = self.run_laptop("--auto", "--interval", "0.1", "--count", "2", "--focus-absolute", "15")
        self.assertEqual(result.returncode, 0, result.stderr)
        for directory in self.capture_dirs():
            self.assertEqual(self.assert_saved(directory)["focus"]["absolute"], 15)
        self.assertEqual(sum(1 for call in self.v4l2_calls() if "-c" in call), 2, "one lock per stream")
        self.assertIn("Focus: locked", result.stdout)

    def test_calibrate_saves_one_marked_frame(self):
        result = self.run_laptop("--calibrate")
        self.assertEqual(result.returncode, 0, result.stderr)
        [directory] = self.capture_dirs()
        metadata = self.assert_saved(directory)
        self.assertEqual(metadata["capturePurpose"], "calibration")
        self.assertEqual(metadata["focus"]["lock"], "locked")
        self.assertIn("npm run calibrate", result.stdout)
        self.assertIn(f"--frame {directory.name}", result.stdout)
        self.assertFalse((self.out / ".pending.json").exists())
        # A dish capture afterwards is not marked.
        self.assertEqual(self.run_laptop("--once").returncode, 0)
        purposes = sorted(json.loads((d / "metadata.json").read_text()).get("capturePurpose", "dish")
                          for d in self.capture_dirs())
        self.assertEqual(purposes, ["calibration", "dish"])
        self.assertEqual(self.run_laptop("--calibrate", "--auto").returncode, 2)

    def test_missing_v4l2_ctl_warns_and_captures(self):
        args = SimpleNamespace(device="/dev/video0", focus_absolute=0, no_focus_lock=False)
        stderr = io.StringIO()
        with patch.object(board.shutil, "which", return_value=None), patch.object(board.sys, "stderr", stderr):
            focus = board.lock_focus(args)
        self.assertEqual(focus["lock"], "unavailable")
        self.assertIn("v4l2-ctl is not installed", stderr.getvalue())


class StreamParsing(unittest.TestCase):
    def test_short_reads_reconstruct_transfer(self):
        class ShortReads(io.BytesIO):
            def read(self, size):
                return super().read(min(3, size))

        self.assertEqual(laptop.read_exact(ShortReads(b"abcdefg"), 7), b"abcdefg")
        self.assertIsNone(laptop.read_exact(io.BytesIO(), 20, allow_eof=True))
        with self.assertRaisesRegex(ValueError, "during a transfer"):
            laptop.read_exact(io.BytesIO(b"abc"), 20, allow_eof=True)

    def test_multipart_lengths_preserve_jpeg_bytes_and_repeated_frames(self):
        photo = FIXTURE_JPEG.read_bytes()
        frame = (b"--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: "
                 + str(len(photo)).encode() + b"\r\n\r\n" + photo + b"\r\n")
        stream = io.BytesIO(frame * 2)
        self.assertEqual(board.read_mjpeg_frame(stream), photo)
        self.assertEqual(board.read_mjpeg_frame(stream), photo)

    def test_padded_packets_keep_next_packet_aligned(self):
        photo = FIXTURE_JPEG.read_bytes()
        padded = photo + b"\x00\xff\xd9padding"
        frame = (b"--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: "
                 + str(len(padded)).encode() + b"\r\n\r\n" + padded + b"\r\n")
        stream = io.BytesIO(frame * 2)
        self.assertEqual(board.read_mjpeg_frame(stream), photo)
        self.assertEqual(board.read_mjpeg_frame(stream), photo)

    def test_embedded_header_markers_are_not_image_end_markers(self):
        photo = FIXTURE_JPEG.read_bytes()
        header = b"\xff\xe1\x00\x08ab\xff\xd9cd"
        photo = photo[:2] + header + photo[2:]
        self.assertEqual(board.camera_jpeg(photo + b"x" * 32), photo)
        with self.assertRaisesRegex(ValueError, "incomplete JPEG"):
            board.camera_jpeg(photo[:-2])

    def test_camera_padding_is_bounded_and_truncation_remains_an_error(self):
        photo = FIXTURE_JPEG.read_bytes()
        with self.assertRaisesRegex(ValueError, "excessive trailing data"):
            board.camera_jpeg(photo + b"x" * 33)
        for invalid in (photo[:-1], photo[2:], b"\xff\xd8\xff\xd9",
                        b"\xff\xd8\xff\xe1\x00\x01\xff\xd9"):
            with self.assertRaisesRegex(ValueError, "incomplete JPEG"):
                board.camera_jpeg(invalid)

    def test_bad_multipart_and_geometry_are_rejected(self):
        for data in (b"--wrong\r\n", b"--ffmpeg\r\nContent-length: 999999999\r\n\r\n",
                     b"--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: 20\r\n\r\nabc"):
            with self.assertRaises(ValueError):
                board.read_mjpeg_frame(io.BytesIO(data))
        with self.assertRaisesRegex(ValueError, "dimensions"):
            board.jpeg_dimensions(b"\xff\xd8\xff\xd9")

    def test_empty_packet_keeps_next_packet_aligned(self):
        photo = FIXTURE_JPEG.read_bytes()
        empty = b"--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: 0\r\n\r\n\r\n"
        frame = (b"--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: "
                 + str(len(photo)).encode() + b"\r\n\r\n" + photo + b"\r\n")
        stream = io.BytesIO(empty + frame)
        self.assertIsNone(board.read_mjpeg_frame(stream))
        self.assertEqual(board.read_mjpeg_frame(stream), photo)

    def test_missing_or_invalid_length_is_not_an_empty_packet(self):
        for value in (None, b"", b"-1", b"garbage"):
            header = b"" if value is None else b"Content-length: " + value + b"\r\n"
            data = b"--ffmpeg\r\nContent-type: image/jpeg\r\n" + header + b"\r\n"
            with self.assertRaisesRegex(ValueError, "Content-length"):
                board.read_mjpeg_frame(io.BytesIO(data))

    def test_wrong_format_reports_actual_type_even_with_empty_packet(self):
        data = b"--ffmpeg\r\nContent-type: image/png\r\nContent-length: 0\r\n\r\n"
        with self.assertRaisesRegex(ValueError, "image/png"):
            board.read_mjpeg_frame(io.BytesIO(data))

    def test_camera_timeout_is_explicit(self):
        stream = board.CameraPipe(io.BytesIO())
        with patch.object(board.select, "select", return_value=([], [], [])):
            with self.assertRaisesRegex(TimeoutError, "stopped sending"):
                stream.fill(board.time.monotonic() + 15)


class CameraLifecycle(unittest.TestCase):
    def args(self):
        return SimpleNamespace(device="/dev/video0", width=1920, height=1080,
                               warmup=0, capture_id=str(uuid.uuid4()))

    def test_manual_warmup_discards_earlier_frames(self):
        photo = FIXTURE_JPEG.read_bytes()
        selected = photo[:2] + b"\xff\xfe\x00\x06last" + photo[2:]
        args = self.args()
        args.warmup = 0.1
        frames = (frame for frame in [photo, photo, selected])
        with patch.object(board, "camera_frames", return_value=frames):
            with patch.object(board.time, "monotonic", side_effect=[0, 0.05, 0.1]):
                saved, metadata = board.capture_image(args)
        self.assertEqual(saved, selected)
        self.assertEqual(metadata["sha256"], hashlib.sha256(selected).hexdigest())

    def test_manual_capture_terminates_and_reaps_ffmpeg(self):
        photo = FIXTURE_JPEG.read_bytes()
        packet = (b"--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: "
                  + str(len(photo)).encode() + b"\r\n\r\n" + photo + b"\r\n")
        process = Mock(stdout=io.BytesIO(packet))
        with patch.object(board.subprocess, "Popen", return_value=process):
            with patch.object(board, "CameraPipe", side_effect=lambda stream: stream):
                saved, _ = board.capture_image(self.args())
        self.assertEqual(saved, photo)
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=3)
        self.assertTrue(process.stdout.closed)

    def test_failed_capture_kills_ffmpeg_if_termination_stalls(self):
        process = Mock(stdout=io.BytesIO(b"--invalid\r\n"))
        process.wait.side_effect = [subprocess.TimeoutExpired("ffmpeg", 3), 0]
        with patch.object(board.subprocess, "Popen", return_value=process):
            with patch.object(board, "CameraPipe", side_effect=lambda stream: stream):
                with self.assertRaisesRegex(ValueError, "camera boundary"):
                    board.capture_image(self.args())
        process.terminate.assert_called_once()
        process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count, 2)
        self.assertTrue(process.stdout.closed)


class SshAuthentication(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="unoq-auth-"))
        self.addCleanup(shutil.rmtree, self.root)

    def args(self):
        return SimpleNamespace(target=TARGET, identity=None, password=False)

    def test_missing_default_key_allows_password_prompt(self):
        with patch.object(laptop.Path, "home", return_value=self.root):
            command, interactive = laptop.ssh_command(self.args(), "camera-command")
        self.assertTrue(interactive)
        self.assertIn("BatchMode=no", command)
        self.assertNotIn("-i", command)
        self.assertEqual(command[-2:], [TARGET, "camera-command"])

    def test_default_key_is_optional_and_allows_password_fallback(self):
        key = self.root / ".ssh" / "scrap_unoq"
        key.parent.mkdir()
        key.touch()
        with patch.object(laptop.Path, "home", return_value=self.root):
            command, interactive = laptop.ssh_command(self.args(), "camera-command")
        self.assertTrue(interactive)
        self.assertIn(str(key), command)
        self.assertIn("BatchMode=no", command)

    def test_explicit_key_preserves_noninteractive_authentication(self):
        key = self.root / "capture-key"
        key.touch()
        args = self.args()
        args.identity = key
        command, interactive = laptop.ssh_command(args, "camera-command")
        self.assertFalse(interactive)
        self.assertIn(str(key), command)
        self.assertIn("BatchMode=yes", command)

    def test_missing_explicit_key_has_actionable_error(self):
        args = self.args()
        args.identity = self.root / "missing-key"
        with self.assertRaisesRegex(ValueError, "Use --password"):
            laptop.ssh_command(args, "camera-command")

    def test_password_mode_does_not_use_default_key(self):
        args = self.args()
        args.password = True
        command, interactive = laptop.ssh_command(args, "camera-command")
        self.assertTrue(interactive)
        self.assertNotIn("-i", command)
        self.assertIn("PubkeyAuthentication=no", command)
        self.assertIn("PreferredAuthentications=password,keyboard-interactive", command)


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
