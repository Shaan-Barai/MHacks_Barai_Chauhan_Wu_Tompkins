#!/usr/bin/env python3
"""Live hardware test: Uno Q + C920s camera, then the inbox bridge (BRIDGE.md).

Run from the repository root on the laptop:

  # Camera only (no backend needed)
  python3 capture/scripts/live_camera_test.py --target arduino@BOARD_IP --stage camera

  # Camera + bridge (backend running with GEMINI_API_KEY, R2, SpacetimeDB)
  python3 capture/scripts/live_camera_test.py --target arduino@BOARD_IP \
      --service svc_hall-main_2026-10-04_dinner --spacetime-db scrap

Camera stage:
  1. One SSH call: board hostname, board script present, camera node, MJPG
     support, board clock vs laptop clock.
  2. Manual --once capture (the FFmpeg manual path's hardware smoke check).
  3. --auto --count 5: five frames, about 1 s apart, with distinct content.
  Every saved capture is re-verified: byte length, sha256, JPEG markers, and
  SOF dimensions matching metadata.json.

Bridge stage (BRIDGE.md section 6 "Live check"):
  1. Backend health, the service exists, and POST /api/dish-match answers.
  2. Bridge --watch runs in the background while the camera runs --auto. Cues
     tell you when to place, hold, slide, and remove each plate.
  3. Expect exactly one "✓ dish" per plate, each a source=camera capture event.
  4. Rerun the bridge one-shot over the same frames: expect no new dish and
     0 Gemini checks.

Everything goes into a fresh folder under images/camera-test/ (gitignored),
including the bridge's state files, so the real images/arduino-inbox and
capture/.inbox-*.json are never touched. The capture events this creates in
the backend are real rows for --service; use a demo/test service.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import ssl
import urllib.error
import urllib.request

REPO = Path(__file__).resolve().parents[2]
CAPTURE = REPO / "capture"
LAPTOP_CAPTURE = CAPTURE / "uno-q" / "laptop_capture.py"

sys.path.insert(0, str(CAPTURE / "uno-q"))
from laptop_capture import ssh_command  # noqa: E402  (reuse its SSH auth rules)

results = []  # (status, name, detail)


def record(status, name, detail=""):
    results.append((status, name, detail))
    mark = {"PASS": "✓", "FAIL": "✗", "WARN": "!", "SKIP": "-"}[status]
    print(f"  {mark} {status} {name}" + (f" — {detail}" if detail else ""), flush=True)


def heading(text):
    print(f"\n=== {text} ===", flush=True)


# ---------------------------------------------------------------- camera ---

def camera_args(args, out, *extra):
    command = [sys.executable, str(LAPTOP_CAPTURE), "--target", args.target,
               "--device", args.device, "--width", str(args.width), "--height", str(args.height),
               "--remote-script", args.remote_script, "--out", str(out)]
    if args.identity:
        command += ["--identity", str(args.identity)]
    if args.password:
        command += ["--password"]
    return command + list(extra)


def board_preflight(args):
    heading("Board preflight (one SSH login)")
    script = shlex.quote(args.remote_script)
    device = shlex.quote(args.device)
    remote = (
        "echo host=$(hostname); "
        f"test -f {script} && echo script=present || echo script=missing; "
        f"test -e {device} && echo device=present || echo device=missing; "
        f"(command -v ffmpeg >/dev/null && echo ffmpeg=yes) || echo ffmpeg=no; "
        f"(command -v v4l2-ctl >/dev/null && echo mjpg=$(v4l2-ctl --device={device} --list-formats-ext 2>/dev/null"
        " | grep -c MJPG)) || echo mjpg=unknown; "
        f"(command -v v4l2-ctl >/dev/null && echo sizes=$(v4l2-ctl --device={device} --list-formats-ext 2>/dev/null"
        " | awk '/MJPG/{m=1} /\\[[0-9]+\\]/ && !/MJPG/{m=0} m && /Size/{print $3}' | sort -u | tr '\\n' ,)) || true; "
        "echo clock=$(date -u +%s.%N)"
    )
    command, _ = ssh_command(args, remote)
    sent = time.time()
    try:
        done = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    except subprocess.TimeoutExpired:
        record("FAIL", "SSH reachable", f"no answer from {args.target} within 120 s")
        return False
    received = time.time()
    if done.returncode != 0:
        record("FAIL", "SSH reachable", done.stderr.decode(errors="replace").strip()[-300:])
        return False
    info = dict(line.split("=", 1) for line in done.stdout.decode().splitlines() if "=" in line)
    record("PASS", "SSH reachable", f"board {info.get('host', '?')}")

    if info.get("script") == "present":
        record("PASS", "board script present", args.remote_script)
    else:
        record("FAIL", "board script present",
               f"copy it: scp capture/uno-q/uno_q_camera.py {args.target}:{args.remote_script}")
    record("PASS" if info.get("ffmpeg") == "yes" else "FAIL", "ffmpeg installed on board")
    if info.get("device") == "present":
        record("PASS", "camera node exists", args.device)
    else:
        record("FAIL", "camera node exists", f"{args.device} missing; run `v4l2-ctl --list-devices` on the board")
    mjpg = info.get("mjpg", "unknown")
    if mjpg == "unknown":
        record("WARN", "camera offers MJPG", "v4l2-ctl not installed on board; cannot check")
    elif mjpg.isdigit() and int(mjpg) > 0:
        sizes = info.get("sizes", "").strip(",")
        want = f"{args.width}x{args.height}"
        if sizes and want not in sizes.split(","):
            record("FAIL", "camera offers MJPG", f"{want} not among MJPG sizes {sizes}; pass --width/--height")
        else:
            record("PASS", "camera offers MJPG", f"{want} available")
    else:
        record("FAIL", "camera offers MJPG", f"{args.device} lists no MJPG format; wrong video node?")

    try:
        board = float(info["clock"])
        # Board time was sampled somewhere inside the SSH round trip.
        skew = board - (sent + received) / 2
        slack = (received - sent) / 2
        if abs(skew) <= 2 + slack:
            record("PASS", "board clock", f"within {abs(skew):.1f} s of laptop")
        else:
            record("WARN", "board clock", f"off by {skew:+.1f} s; capturedAt timestamps will be shifted"
                   " (check `timedatectl status` on the board)")
    except (KeyError, ValueError):
        record("WARN", "board clock", "could not read board time")
    return not any(s == "FAIL" for s, _, _ in results)


def jpeg_dimensions(data):
    """Return (width, height) from the first SOF marker, or None."""
    if data[:2] != b"\xff\xd8":
        return None
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        length = int.from_bytes(data[i + 2:i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            height = int.from_bytes(data[i + 5:i + 7], "big")
            width = int.from_bytes(data[i + 7:i + 9], "big")
            return width, height
        i += 2 + length
    return None


def verify_captures(folder):
    """Re-verify every complete capture folder. Returns list of metadata dicts."""
    captures = []
    for directory in sorted(p for p in folder.iterdir() if p.is_dir() and not p.name.startswith(".")):
        photo, meta_path = directory / "photo.jpg", directory / "metadata.json"
        if not photo.is_file() or not meta_path.is_file():
            record("FAIL", f"capture {directory.name[:8]}", "photo.jpg or metadata.json missing")
            continue
        meta = json.loads(meta_path.read_text())
        data = photo.read_bytes()
        problems = []
        if meta.get("byteLength") != len(data):
            problems.append(f"byteLength {meta.get('byteLength')} != {len(data)}")
        if meta.get("sha256") != hashlib.sha256(data).hexdigest():
            problems.append("sha256 mismatch")
        if not data.endswith(b"\xff\xd9"):
            problems.append("no JPEG end marker")
        dims = jpeg_dimensions(data)
        if dims != (meta.get("widthPx"), meta.get("heightPx")):
            problems.append(f"JPEG says {dims}, metadata says {meta.get('widthPx')}x{meta.get('heightPx')}")
        if problems:
            record("FAIL", f"capture {directory.name[:8]}", "; ".join(problems))
            continue
        meta["_photo"] = photo
        meta["_sha"] = meta["sha256"]
        captures.append(meta)
    captures.sort(key=lambda m: m["capturedAt"])
    return captures


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def manual_capture(args, root):
    heading("Manual capture (--once)")
    out = root / "manual"
    print("Point the camera at a plate (or anything), then wait for 'Saved'.", flush=True)
    code = subprocess.run(camera_args(args, out, "--once"), cwd=REPO).returncode
    if code != 0:
        record("FAIL", "manual --once capture", f"exit code {code}; see output above")
        return
    captures = verify_captures(out) if out.exists() else []
    if len(captures) == 1:
        meta = captures[0]
        record("PASS", "manual --once capture", f"{meta['widthPx']}x{meta['heightPx']}, {meta['byteLength']} bytes")
        if (meta["widthPx"], meta["heightPx"]) != (args.width, args.height):
            record("WARN", "manual capture size", f"asked {args.width}x{args.height}")
        print(f"    photo: {meta['_photo']}")
        if args.open:
            subprocess.run(["open", str(meta["_photo"])])
    else:
        record("FAIL", "manual --once capture", f"expected 1 verified capture, found {len(captures)}")


def auto_smoke(args, root):
    heading("Automatic capture (--auto --count 5)")
    out = root / "auto-smoke"
    print("Move something in view during these 5 seconds so frames differ.", flush=True)
    code = subprocess.run(camera_args(args, out, "--auto", "--count", "5"), cwd=REPO).returncode
    if code != 0:
        record("FAIL", "auto capture", f"exit code {code}; see output above")
        return
    captures = verify_captures(out) if out.exists() else []
    record("PASS" if len(captures) == 5 else "FAIL", "auto capture count", f"{len(captures)}/5 verified frames")
    if len(captures) < 2:
        return
    gaps = [(parse_time(b["capturedAt"]) - parse_time(a["capturedAt"])).total_seconds()
            for a, b in zip(captures, captures[1:])]
    detail = ", ".join(f"{g:.2f}" for g in gaps) + " s"
    record("PASS" if all(0.8 <= g <= 1.6 for g in gaps) else "WARN", "auto interval ≈ 1 s", detail)
    bad_meta = [m for m in captures if m.get("triggerSource") != "interval" or m.get("dishIdentity") != "unresolved"]
    record("FAIL" if bad_meta else "PASS", "auto metadata labels", "triggerSource=interval, dishIdentity=unresolved")
    distinct = len({m["_sha"] for m in captures})
    record("PASS" if distinct == len(captures) else "WARN", "frames are fresh", f"{distinct} distinct images")
    if args.open:
        subprocess.run(["open", *[str(m["_photo"]) for m in captures]])


# ---------------------------------------------------------------- bridge ---

def ingest_token(args):
    """SCRAP_INGEST_TOKEN (or --token-env): environment, then .env, then deploy/.run/local-secrets.env."""
    value = os.environ.get(args.token_env, "").strip()
    if value:
        return value
    for path in (REPO / ".env", REPO / "deploy" / ".run" / "local-secrets.env"):
        try:
            for line in path.read_text().splitlines():
                name, sep, raw = line.strip().removeprefix("export ").partition("=")
                if sep and name.strip() == args.token_env and raw.strip().strip("'\""):
                    return raw.strip().strip("'\"")
        except OSError:
            continue
    return None


def ssl_context():
    """certifi's CA bundle when importable (python.org macOS builds ship none), else the default."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return None


def api_json(args, method, route, body=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    # A named user agent: Cloudflare refuses urllib's default "Python-urllib" one (403, error 1010).
    headers = {"content-type": "application/json", "user-agent": "ScrapSaver-live-camera-test/1"}
    if args.token:
        headers["authorization"] = f"Bearer {args.token}"  # never printed
    request = urllib.request.Request(f"{args.api}{route}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=ssl_context()) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            record("FAIL", "backend auth", f"HTTP {error.code} on {method} {route}: set {args.token_env} to the "
                                            "backend's ingest token")
        try:
            return error.code, json.loads(error.read() or b"{}")
        except ValueError:
            return error.code, {}


def build_capture():
    done = subprocess.run(["npm", "run", "--silent", "build"], cwd=CAPTURE,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if done.returncode != 0:
        record("FAIL", "capture package builds", done.stdout.decode(errors="replace")[-500:])
        return False
    return True


def thumbnail_b64(photo):
    """Same 512px JPEG the bridge sends, made by capture's own thumbnail()."""
    code = ("import {readFileSync} from 'node:fs'; import {thumbnail} from './dist/src/index.js';"
            "const t = await thumbnail(readFileSync(process.argv[1])); process.stdout.write(JSON.stringify(t));")
    done = subprocess.run(["node", "--input-type=module", "-e", code, str(photo)], cwd=CAPTURE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.decode(errors="replace")[-300:])
    return json.loads(done.stdout)


def backend_preflight(args, root):
    heading("Backend preflight")
    try:
        status, health = api_json(args, "GET", "/api/health", timeout=5)
    except (urllib.error.URLError, OSError) as error:
        record("FAIL", "backend reachable", f"{args.api}: {error}. Start it: cd backend && npm start")
        return None
    record("PASS" if status == 200 else "FAIL", "backend reachable", f"storage provider {health.get('provider')}")
    if health.get("provider") != "r2":
        record("WARN", "storage provider", f"'{health.get('provider')}', not r2; BRIDGE.md live check expects R2")

    status, body = api_json(args, "GET", "/api/services")
    service = next((s for s in body.get("services", []) if s.get("serviceId") == args.service), None)
    if not service:
        record("FAIL", "service exists", f"{args.service} not in GET /api/services; upload its menu first")
        return None
    record("PASS", "service exists", f"hall {service.get('hallId')}")

    if not build_capture():
        return None
    # Probe dish-match with one real frame against itself (1 Gemini call).
    probe_photo = next(iter(sorted((root / "auto-smoke").glob("*/photo.jpg"))), None) \
        or next(iter(sorted((root / "manual").glob("*/photo.jpg"))), None)
    if probe_photo is None:
        record("SKIP", "dish-match probe", "no camera photo from this run to probe with")
        return service
    image = thumbnail_b64(probe_photo)
    started = time.time()
    status, body = api_json(args, "POST", "/api/dish-match", {"reference": image, "candidate": image})
    took = time.time() - started
    if status == 200:
        verdict = body.get("sameDish", "no plate") if body.get("plateVisible") else "no plate"
        record("PASS", "dish-match answers", f"{verdict} in {took:.1f} s ({body.get('model')}, {body.get('promptVersion')})")
        if body.get("plateVisible") and body.get("sameDish") != "same":
            record("WARN", "dish-match self-check", f"frame vs itself was '{body.get('sameDish')}': {body.get('reason')}")
        if took > 3:
            record("WARN", "dish-match latency", f"{took:.1f} s per call; slower than 1 fps frames")
    else:
        code = body.get("error", body).get("code") if isinstance(body.get("error", body), dict) else body
        record("FAIL", "dish-match answers", f"HTTP {status} {code}; is GEMINI_API_KEY set on the backend?")
        return None
    return service


def schedule(plates, lead=5, gap=6):
    """(start offset seconds, cue) list and total seconds."""
    cues, t = [(0, "Keep the view EMPTY.")], lead
    for n in range(1, plates + 1):
        if n == 1:
            cues.append((t, f"PLACE plate {n} and hold it STILL."))
            hold = 12
        elif n == 2:
            cues.append((t, f"PLACE plate {n} and SLIDE it slowly across the view (keep it in the centre square)."))
            hold = 10
        else:
            cues.append((t, f"PLACE plate {n} (a different plate from the previous one) and hold it."))
            hold = 8
        t += hold
        cues.append((t, f"REMOVE plate {n}. View empty."))
        t += gap
    cues.append((t, "Done. Leave the view empty."))
    return cues, t


def cue_runner(inbox, cues, stop):
    # Start the clock at the first saved frame, so SSH login/warmup don't eat the cues.
    print(f"\n>>> {cues[0][1]}  (cues start once the first frame arrives)", flush=True)
    while not stop.is_set() and not any(p.is_dir() and not p.name.startswith(".") for p in inbox.glob("*")):
        time.sleep(0.2)
    start = time.monotonic()
    for offset, text in cues[1:]:
        while not stop.is_set() and time.monotonic() - start < offset:
            time.sleep(0.1)
        if stop.is_set():
            return
        print(f"\n>>> [{offset:>3}s] {text}\n", flush=True)


def run_bridge(args, inbox, state, watch, log_path):
    command = ["npm", "run", "--silent", "ingest-inbox", "--", "--service", args.service,
               "--inbox", str(inbox), "--state-dir", str(state)]
    if watch:
        command += ["--watch", "--idle", str(args.idle)]
    env = {**os.environ, "API_URL": args.api, "SCRAP_API_URL": args.api}
    if args.token:
        env["SCRAP_INGEST_TOKEN"] = args.token
    log = open(log_path, "w")
    process = subprocess.Popen(command, cwd=CAPTURE, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True,
                               start_new_session=True)

    def pump():
        for line in process.stdout:
            log.write(line)
            log.flush()
            print(f"[bridge] {line}", end="", flush=True)
        log.close()

    thread = threading.Thread(target=pump, daemon=True)
    thread.start()
    return process, thread


def summarize_log(text):
    dishes = re.findall(r"✓ dish (\S+) \((\d+) frames\) → (\S+) \(([^)]*)\)", text)
    gemini = re.findall(r"Gemini checks this run: (\d+)", text)
    return {
        "dishes": dishes,
        "failed": re.findall(r"✗ .*", text),
        "paused": re.findall(r"⏸ .*", text),
        "unsure": re.findall(r"\? .*", text),
        "gemini": int(gemini[-1]) if gemini else None,
    }


def live_bridge(args, root, service):
    heading(f"Live bridge check: {args.plates} plates")
    run = root / "live"
    inbox, state = run / "inbox", run / "state"
    inbox.mkdir(parents=True, exist_ok=True)
    cues, seconds = schedule(args.plates)
    frames = seconds + 4
    print("Timeline (seconds after the first frame):")
    for offset, text in cues:
        print(f"  {offset:>3}s  {text}")
    input("\nHave the plates ready and the view empty. Press Enter to start…")

    bridge, pump = run_bridge(args, inbox, state, watch=True, log_path=run / "bridge.log")
    stop = threading.Event()
    cue_thread = threading.Thread(target=cue_runner, args=(inbox, cues, stop), daemon=True)
    cue_thread.start()
    camera = subprocess.run(camera_args(args, inbox, "--auto", "--count", str(frames)), cwd=REPO)
    stop.set()
    if camera.returncode != 0:
        record("FAIL", "live auto capture", f"exit code {camera.returncode}")

    # Let --watch see the last frames, idle-close the open dish, and ingest it.
    wait = args.idle + 15
    print(f"\nCamera done. Waiting up to {wait} s for the bridge to close and ingest the last dish…", flush=True)
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline and bridge.poll() is None:
        if len(summarize_log((run / "bridge.log").read_text())["dishes"]) >= args.plates:
            break
        time.sleep(1)
    if bridge.poll() is None:
        os.killpg(bridge.pid, signal.SIGINT)  # bridge flushes the open dish on Ctrl+C
        try:
            bridge.wait(timeout=60)
        except subprocess.TimeoutExpired:
            os.killpg(bridge.pid, signal.SIGKILL)
    pump.join(timeout=5)

    captures = verify_captures(inbox)
    log = summarize_log((run / "bridge.log").read_text())
    record("PASS" if len(captures) >= frames - 2 else "WARN", "live frames saved", f"{len(captures)}/{frames}")
    record("PASS" if not log["paused"] else "FAIL", "bridge never paused",
           "; ".join(log["paused"][:3]) or "dish-match available throughout")
    record("PASS" if not log["failed"] else "FAIL", "no bridge errors", "; ".join(log["failed"][:3]))
    count = len(log["dishes"])
    record("PASS" if count == args.plates else "FAIL", "one dish per plate", f"{count} dishes for {args.plates} plates")
    for group, members, event_id, state_label in log["dishes"]:
        print(f"    dish {group}: {members} frames → {event_id} ({state_label})")
    if log["unsure"]:
        record("WARN", "unsure merges", f"{len(log['unsure'])}: " + "; ".join(log["unsure"][:3]))
    if log["gemini"] is not None:
        record("PASS" if log["gemini"] <= len(captures) else "WARN", "Gemini checks vs frames",
               f"{log['gemini']} checks for {len(captures)} frames (pre-filter should keep this low)")

    heading("Capture events in the backend")
    for _, _, event_id, _ in log["dishes"]:
        status, body = api_json(args, "GET", f"/api/captures/{event_id}")
        event = body.get("event", {})
        geometry = event.get("geometry") or {}
        ok = (status == 200 and event.get("source") == "camera"
              and event.get("serviceId") == args.service
              and (geometry.get("widthPx"), geometry.get("heightPx")) == (1024, 1024))
        detail = (f"source={event.get('source')} state={event.get('state')} "
                  f"{geometry.get('widthPx', '?')}x{geometry.get('heightPx', '?')} "
                  f"measurements={len(body.get('measurements') or [])}")
        record("PASS" if ok else "FAIL", f"event {event_id}", detail if status == 200 else f"HTTP {status}")

    heading("Rerun over the same frames (expect nothing new)")
    rerun, rerun_pump = run_bridge(args, inbox, state, watch=False, log_path=run / "bridge-rerun.log")
    rerun.wait()
    rerun_pump.join(timeout=5)
    again = summarize_log((run / "bridge-rerun.log").read_text())
    fresh = [d for d in again["dishes"] if d[3] != "already ingested"]
    record("PASS" if rerun.returncode == 0 else "FAIL", "rerun exits cleanly", f"exit {rerun.returncode}")
    record("PASS" if not fresh else "FAIL", "rerun adds no dishes", f"{len(fresh)} new")
    record("PASS" if again["gemini"] == 0 else "FAIL", "rerun makes no Gemini calls", f"{again['gemini']} calls")

    if args.spacetime_db and shutil.which("spacetime"):
        heading("SpacetimeDB rows")
        # SpacetimeDB SQL has no IN (...); OR the equalities instead.
        ids = " OR ".join(f"event_id = '{d[2]}'" for d in log["dishes"]) or "event_id = ''"
        query = f"SELECT event_id, source FROM capture_event WHERE {ids}"
        # --server: the CLI's default server may be maincloud, not the local database.
        done = subprocess.run(["spacetime", "sql", "--server", args.spacetime_server, args.spacetime_db, query],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        print(done.stdout)
        found = sum(1 for d in log["dishes"] if d[2] in done.stdout)
        record("PASS" if found == count and done.returncode == 0 else "WARN",
               "capture_event rows in SpacetimeDB", f"{found}/{count} found (check column names if 0)")


# ------------------------------------------------------------------ main ---

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target", required=True, help="arduino@board-IP-or-hostname")
    parser.add_argument("--stage", choices=["camera", "bridge", "all"], default="all",
                        help="camera = hardware only; bridge = skip manual/5-frame checks; all = both")
    parser.add_argument("--service", help="serviceId for the bridge stage (GET /api/services)")
    parser.add_argument("--plates", type=int, default=3, help="Plates to pass under the camera (default 3)")
    parser.add_argument("--api", default=os.environ.get("SCRAP_API_URL") or os.environ.get("API_URL") or "http://localhost:8787",
                        help="Backend (default $SCRAP_API_URL, else $API_URL, else http://localhost:8787)")
    parser.add_argument("--token-env", default="SCRAP_INGEST_TOKEN", help="Variable holding the ingest token")
    parser.add_argument("--idle", type=int, default=10, help="Bridge --idle seconds (default 10)")
    parser.add_argument("--device", default="/dev/video0")
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--remote-script", default="scrap-camera/uno_q_camera.py")
    auth = parser.add_mutually_exclusive_group()
    auth.add_argument("--identity", type=Path, help="SSH key (default ~/.ssh/scrap_unoq if present)")
    auth.add_argument("--password", action="store_true", help="Use the board password instead of a key")
    parser.add_argument("--spacetime-db", help="Also query this SpacetimeDB database with `spacetime sql` (e.g. scrap)")
    parser.add_argument("--spacetime-server", default="local",
                        help="`spacetime sql --server` nickname/URL (default local)")
    parser.add_argument("--open", action="store_true", help="Open captured photos in the image viewer")
    parser.add_argument("--out", type=Path, help="Run folder (default images/camera-test/<UTC time>)")
    args = parser.parse_args()
    args.api = args.api.rstrip("/")
    args.token = ingest_token(args)
    if args.stage != "camera" and not args.service:
        parser.error("--service is required unless --stage camera")
    if not 1 <= args.plates <= 10:
        parser.error("--plates must be between 1 and 10")

    root = args.out or REPO / "images" / "camera-test" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    root.mkdir(parents=True, exist_ok=True)
    print(f"Run folder: {root}")

    if board_preflight(args):
        if args.stage in ("camera", "all"):
            manual_capture(args, root)
            auto_smoke(args, root)
        if args.stage in ("bridge", "all"):
            if args.stage == "bridge":
                auto_smoke(args, root)  # also gives the dish-match probe a real frame
            service = backend_preflight(args, root)
            if service:
                live_bridge(args, root, service)

    heading("Summary")
    counts = {s: sum(1 for r in results if r[0] == s) for s in ("PASS", "WARN", "FAIL", "SKIP")}
    print("  " + "  ".join(f"{k} {v}" for k, v in counts.items()))
    for status, name, detail in results:
        if status in ("FAIL", "WARN"):
            print(f"  {status} {name}: {detail}")
    print(f"  Photos and bridge logs: {root}")
    (root / "results.json").write_text(json.dumps(
        [{"status": s, "check": n, "detail": d} for s, n, d in results], indent=2) + "\n")
    return 1 if counts["FAIL"] else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(130)
