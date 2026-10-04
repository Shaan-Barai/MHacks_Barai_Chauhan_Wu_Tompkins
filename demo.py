#!/usr/bin/env python3
"""ScrapSaver end-to-end demo: plate photo -> AI segmentation -> waste stats -> dashboard.

    python3 demo.py                    # real camera (Uno Q + C920s), 1 plate
    python3 demo.py --plates 3         # three plates, one photo each
    python3 demo.py --simulate         # no board: use the test2/ plate photos
    python3 demo.py --simulate --yes   # no pauses between steps
    python3 demo.py --list             # show the steps
    python3 demo.py --only stats,recommendation,dashboard   # re-show results only
    python3 demo.py --simulate --recalibrate                # new calibration (synthetic card)
    python3 demo.py --simulate --yes --hall hall-test       # a test hall: hall-main's numbers stay untouched

Each step prints what it does and proves it with real data:
  services        SpacetimeDB, SAM 2.1 worker, backend (R2), dashboard are up (offers to start them)
  menu            today's dinner menu + demo portions served (seeds them if missing)
  calibration     camera calibration: k (cm² per pixel) and camera height
  camera          the Uno Q takes a photo and SSHes it to this laptop (or --simulate)
  upload          bridge: photo -> R2 (presigned PUT) -> SpacetimeDB image_object -> capture_event
  analysis        Gemini classifies + boxes the food, SAM 2.1 segments it, code counts pixels
  area            estimated area cm² / grams / kg CO2e / L water per food, totals and coverage
  storage         R2 holds photo, overlay and masks; SpacetimeDB holds only references
  images          side-by-side "camera photo | AI segmentation" picture
  stats           total waste, waste per portion, most wasted, relative impact, estimated CO2e + water
  recommendation  Gemini's suggestion grounded in those numbers
  dashboard       opens the ScrapSaver dashboard
  deploy          checks the production URL (SCRAP_PROD_URL): /api/health, /api/ready, dashboard HTML

Backend: SCRAP_API_URL (default http://localhost:8787; API_URL still works). Mutations send
`Authorization: Bearer $SCRAP_INGEST_TOKEN` (or --token-env NAME); when it is not in the
environment it is read from .env or deploy/.run/local-secrets.env. The token is never printed.

ADDING A FEATURE? Add a step function below and an entry in STEPS (see AGENTS.md
"Demo script"). Keep each step self-contained: read what it needs from `demo`,
print, and record PASS/WARN/FAIL with demo.check().

Everything this run writes locally goes to images/demo-runs/<time>/ (gitignored).
The captures it creates are real rows in the configured database (default `scrap`).
"""

import argparse
import base64
from datetime import datetime, timedelta, timezone
import csv
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

# Cloudflare's Browser Integrity Check answers urllib's default "Python-urllib/x.y" user agent with
# 403 (error code 1010), so every request this script makes names itself.
USER_AGENT = "ScrapSaver-demo/1"

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    ZoneInfo = None

REPO = Path(__file__).resolve().parent
FACTORS = REPO / "factors"
HALL_ID = "hall-main"
HALL_TZ = "America/Detroit"
DEFAULT_BOARD = os.environ.get("SCRAP_BOARD", "arduino@35.1.88.76")

# ------------------------------------------------------------------ output ---

COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def paint(code, text):
    return f"\033[{code}m{text}\033[0m" if COLOR else str(text)


def bold(t): return paint("1", t)
def dim(t): return paint("2", t)
def green(t): return paint("32", t)
def yellow(t): return paint("33", t)
def red(t): return paint("31", t)
def cyan(t): return paint("36", t)


def table(rows, headers, align=None):
    """Plain-text table. align: string of 'l'/'r' per column."""
    rows = [[str(c) for c in r] for r in rows]
    widths = [max(len(h), *(len(r[i]) for r in rows)) if rows else len(h) for i, h in enumerate(headers)]
    align = align or "l" * len(headers)

    def fmt(cells):
        return "  ".join(c.rjust(w) if a == "r" else c.ljust(w) for c, w, a in zip(cells, widths, align))

    print("    " + bold(fmt(headers)))
    print("    " + dim("  ".join("─" * w for w in widths)))
    for r in rows:
        print("    " + fmt(r))


def num(value, digits=0):
    if value is None:
        return "—"
    return f"{value:,.{digits}f}"


# ------------------------------------------------------------------- state ---

def read_env_file(path, key):
    """One KEY=value from a dotenv-style file, or None. Values are never printed."""
    try:
        for line in Path(path).read_text().splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[7:].strip()
            name, sep, value = line.partition("=")
            if sep and name.strip() == key:
                value = value.strip().strip("'\"")
                return value or None
    except OSError:
        pass
    return None


def resolve_token(token_env):
    """The ingest token: environment first, then .env, then deploy/.run/local-secrets.env."""
    value = os.environ.get(token_env, "").strip()
    if value:
        return value, f"${token_env}"
    for path in (REPO / ".env", REPO / "deploy" / ".run" / "local-secrets.env"):
        value = read_env_file(path, token_env)
        if value:
            return value, f"{token_env} in {path.relative_to(REPO)}"
    return None, None


def is_local(url):
    return urllib.parse.urlparse(url).hostname in ("localhost", "127.0.0.1", "::1")


class Demo:
    def __init__(self, args):
        self.args = args
        self.api = args.api.rstrip("/")
        self.token, self.token_source = resolve_token(args.token_env)
        self.auth_warned = False
        self.run = args.out.resolve() if args.out else REPO / "images" / "demo-runs" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.inbox = self.run / "inbox"
        self.state = self.run / "bridge-state"
        self.date = args.date or hall_today()
        self.service_id = args.service or f"svc_{HALL_ID}_{self.date}_dinner"
        self.event_ids = []          # captures created by this run
        self.results = []            # (status, step, message)
        self.step = ""
        self.started = []            # services this run started
        self.calibration = None      # active CameraCalibration (calibration step)
        self.restore_settings = None # hall settings to put back after a --simulate synthetic calibration

    def check(self, status, message):
        self.results.append((status, self.step, message))
        mark = {"PASS": green("✓"), "WARN": yellow("!"), "FAIL": red("✗"), "INFO": cyan("•")}[status]
        print(f"  {mark} {message}", flush=True)

    # -- HTTP --
    def get(self, route, timeout=60, anonymous=False):
        return self.request("GET", route, timeout=timeout, anonymous=anonymous)

    def request(self, method, route, body=None, timeout=60, base=None, anonymous=False):
        """anonymous=True sends no ingest token; a 401/403 is then an expected answer, never a token hint."""
        data = None if body is None else json.dumps(body).encode()
        headers = {"content-type": "application/json", "user-agent": USER_AGENT}
        if self.token and not anonymous:
            headers["authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request((base or self.api) + route, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ssl_context()) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            if e.code in (401, 403) and not anonymous and not self.auth_warned:
                self.auth_warned = True
                hint = ("no ingest token is set" if not self.token else
                        f"the token from {self.token_source} was refused")
                print(red(f"  ✗ HTTP {e.code} from {method} {route}: {hint}. Set {self.args.token_env} to the "
                          "backend's SCRAP_INGEST_TOKEN (see docs/deploy.md)."), flush=True)
            try:
                return e.code, json.loads(e.read() or b"null")
            except ValueError:
                return e.code, None

    def child_env(self):
        """Environment for the capture/backend npm scripts: same backend, same token."""
        env = {"API_URL": self.api, "SCRAP_API_URL": self.api}
        if self.token:
            env["SCRAP_INGEST_TOKEN"] = self.token
        return env

    def window(self):
        return urllib.parse.urlencode({"hallId": HALL_ID, "start": self.date, "end": self.date})


def ssl_context():
    """HTTPS context using certifi's CA bundle when importable (python.org macOS builds ship none:
    CERTIFICATE_VERIFY_FAILED); otherwise the platform default."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return None


def hall_today():
    now = datetime.now(ZoneInfo(HALL_TZ)) if ZoneInfo else datetime.now()
    return now.strftime("%Y-%m-%d")


def port_open(port, host="localhost"):
    """True if anything listens on the port (IPv4 or IPv6; Vite binds ::1 only)."""
    try:
        socket.create_connection((host, port), timeout=0.5).close()
        return True
    except OSError:
        return False


def http_ok(url, timeout=3):
    req = urllib.request.Request(url, headers={"user-agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context()) as r:
            return r.status < 500, r.read()
    except (urllib.error.URLError, OSError):
        return False, b""


def ask(question, default=True):
    if not sys.stdin.isatty():
        return default
    hint = "[Y/n]" if default else "[y/N]"
    answer = input(f"  {question} {hint} ").strip().lower()
    return default if not answer else answer.startswith("y")


def run_live(command, cwd=REPO, env=None, prefix="  │ "):
    """Run a command, streaming its output indented; return (code, output)."""
    process = subprocess.Popen(command, cwd=cwd, env={**os.environ, **(env or {})},
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = []
    for line in process.stdout:
        lines.append(line)
        print(dim(prefix) + line.rstrip(), flush=True)
    return process.wait(), "".join(lines)


def spacetime_sql(demo, query):
    """Rows from `spacetime sql --format json`, or None if the CLI is unavailable."""
    if not shutil.which("spacetime"):
        return None
    done = subprocess.run(["spacetime", "sql", "--server", "local", "--format", "json", demo.args.db, query],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if done.returncode != 0:
        return None
    try:
        payload = json.loads(done.stdout[done.stdout.index("["):])
        return payload[0]["rows"]
    except (ValueError, IndexError, KeyError):
        return None


def unwrap(value):
    """SpacetimeDB JSON encodes options as {"some": v} / {"none": []}."""
    if isinstance(value, dict):
        if "some" in value:
            return value["some"]
        if "none" in value:
            return None
    return value


# ------------------------------------------------------------------- steps ---

SERVICES = [
    # name, port, health URL, start command, cwd, wait seconds, required
    ("SpacetimeDB", 3000, None, ["spacetime", "start"], REPO, 20, True),
    ("SAM 2.1 worker", 8790, "http://127.0.0.1:8790/health", [".venv/bin/python", "vision/sam/worker.py"], REPO, 90, True),
    ("Backend API", 8787, "http://127.0.0.1:8787/api/health", ["npm", "start"], REPO / "backend", 120, True),
    ("Dashboard", 5173, None, ["npm", "run", "dev"], REPO / "frontend", 30, True),
]


def dashboard_served_by_backend(demo):
    """Production mode (deploy/local.sh, SERVE_FRONTEND=1): the backend serves the built dashboard at /."""
    ok, body = http_ok(demo.api + "/")
    return ok and b"<html" in body[:2000].lower()


def step_services_remote(demo):
    """A remote backend (SCRAP_API_URL): check it instead of local processes."""
    ok, body = http_ok(demo.api + "/api/health", timeout=10)
    if not ok:
        demo.check("FAIL", f"Backend {demo.api} not reachable (/api/health)")
        return False
    demo.check("PASS", f"Backend {demo.api}  {dim(body.decode(errors='replace')[:80])}")
    status, ready = demo.get("/api/ready", timeout=20)
    demo.check("PASS" if status == 200 else "WARN", f"/api/ready HTTP {status}" +
               (f": {json.dumps(ready)[:160]}" if status != 200 else ""))
    demo.check("PASS" if demo.token else "WARN",
               f"Ingest token {'from ' + demo.token_source if demo.token else 'not set: uploads will get 401'}")
    return True


def step_services(demo):
    """Everything the pipeline needs is running."""
    if not is_local(demo.api):
        return step_services_remote(demo)
    backend_port = urllib.parse.urlparse(demo.api).port or 80
    for name, port, health, command, cwd, wait, required in SERVICES:
        if name == "Backend API" and backend_port != port:
            port, health = backend_port, f"{demo.api}/api/health"
        if name == "Dashboard" and not port_open(port) and dashboard_served_by_backend(demo):
            demo.check("PASS", f"Dashboard served by the backend at {demo.api}/ (production build)")
            continue
        up = port_open(port) and (health is None or http_ok(health)[0])
        if not up and not demo.args.no_start and ask(f"{name} is not running. Start it now?"):
            log = demo.run / "logs" / f"{name.split()[0].lower()}.log"
            log.parent.mkdir(parents=True, exist_ok=True)
            env = {**os.environ}
            if name == "Backend API" and demo.args.db:
                env["SPACETIMEDB_MODULE"] = demo.args.db
            process = subprocess.Popen(command, cwd=cwd, env=env, stdout=open(log, "w"),
                                       stderr=subprocess.STDOUT, start_new_session=True)
            demo.started.append((name, process.pid, log))
            print(dim(f"    started {name} (pid {process.pid}), log {show_path(log)}"))
            deadline = time.time() + wait
            while time.time() < deadline and not up:
                time.sleep(1)
                up = port_open(port) and (health is None or http_ok(health)[0])
        if not up:
            demo.check("FAIL" if required else "WARN",
                       f"{name} not reachable on :{port}  (start: cd {cwd.relative_to(REPO) or '.'} && {' '.join(command)})")
            continue
        detail = ""
        if health:
            _, body = http_ok(health)
            try:
                info = json.loads(body)
                detail = info.get("model") or (f"storage: {info.get('provider')}" if "provider" in info else "")
                if name == "Backend API" and info.get("provider") != "r2":
                    demo.check("WARN", f"Backend storage is '{info.get('provider')}', not R2 (set OBJECT_STORAGE_PROVIDER=r2 in .env)")
            except ValueError:
                pass
        demo.check("PASS", f"{name} on :{port}" + (f"  {dim(detail)}" if detail else ""))
    status, me = demo.get("/api/auth/me", timeout=5)
    if status == 200 and isinstance(me, dict) and me.get("authRequired"):
        demo.check("PASS" if demo.token else "FAIL",
                   "Backend requires auth for writes; ingest token " +
                   (f"from {demo.token_source}" if demo.token else f"NOT set ({demo.args.token_env})"))
    elif status == 200:
        demo.check("INFO", "Backend runs without write auth (dev mode)")
    if not demo.args.simulate:
        if shutil.which("ssh") is None:
            demo.check("FAIL", "ssh is not installed (needed for the camera)")


def step_menu(demo):
    """Today's dinner menu, with waste factors and demo portions served."""
    status, menu = demo.get(f"/api/menus/by-service/{demo.service_id}")
    if status != 200 and not demo.args.service:
        print(f"  No menu for {demo.service_id} yet. Seeding the 26-food demo dinner for {HALL_ID} on {demo.date}…")
        seed_dinner(demo)
        status, menu = demo.get(f"/api/menus/by-service/{demo.service_id}")
    if status != 200:
        demo.check("FAIL", f"No menu for {demo.service_id}. Pick another with --service (GET /api/services).")
        return False
    service, items = menu["menu"]["service"], menu["menu"]["items"]
    demo.check("PASS", f"Menu {bold(service['serviceId'])}: {len(items)} foods (menu version {service['menuVersion']})")

    q = urllib.parse.urlencode({"hallId": HALL_ID, "serviceId": demo.service_id})
    _, portions = demo.get(f"/api/portions-served?{q}")
    served = {p["itemId"]: p for p in (portions or {}).get("portions", [])}
    if not served and not demo.args.service:
        seed_dinner(demo)
        _, portions = demo.get(f"/api/portions-served?{q}")
        served = {p["itemId"]: p for p in (portions or {}).get("portions", [])}
    sources = {p.get("source") for p in served.values()}
    if served:
        label = " (DEMO dummy counts)" if "demo" in sources else ""
        demo.check("PASS", f"Portions served recorded for {len(served)}/{len(items)} foods{label}")
    else:
        demo.check("WARN", "No portions served for this meal: waste per portion will be unavailable")

    factors = load_factors()
    rows = []
    for item in items[:8]:
        f = factors.get(slug(item["displayName"]))
        p = served.get(item["itemId"])
        rows.append([item["displayName"], num(p["count"]) if p else "—",
                     f["weight_g_per_cm2"] if f else "—",
                     f["C_kg_co2e_per_kg"] if f else "—",
                     f["W_water_m3_per_kg"] if f else "—", f["impact_score_usd_per_kg"] if f else "—"])
    print()
    table(rows, ["Food", "Portions", "g/cm²", "C kgCO2e/kg", "W m³/kg", "0.19C+1.50W"], "lrrrrr")
    print(dim("    g/cm² turns a calibrated area (cm²) into estimated grams; C and W turn grams into kg CO2e and L water."))
    if len(items) > 8:
        print(dim(f"    … and {len(items) - 8} more"))
    return True


def seed_dinner(demo):
    """Seed the 26-food demo dinner + demo portions for this hall and date (backend/scripts/seed.mjs)."""
    env = demo.child_env()
    if HALL_ID != "hall-main":
        # seed.mjs seeds its file's hallId: a minimal seed file with only this hall's live dinner.
        seed_file = demo.run / "seed-test-hall.json"
        seed_file.parent.mkdir(parents=True, exist_ok=True)
        seed_file.write_text(json.dumps({"hallId": HALL_ID, "hallTimezone": HALL_TZ, "menus": [],
                                         "referencePortions": [], "portionsServed": []}) + "\n")
        env["SEED_FILE"] = str(seed_file)
    run_live(["npm", "run", "--silent", "seed", "--", f"--live-dinner={demo.date}"], cwd=REPO / "backend", env=env)


def pick(body, key):
    """Accept {key: record} or a bare record."""
    if isinstance(body, dict) and isinstance(body.get(key), dict):
        return body[key]
    return body


def route_missing(status, body):
    error = (body or {}).get("error") if isinstance(body, dict) else None
    return status == 404 and (not error or error.get("code") == "ROUTE_NOT_FOUND")


def measurement_settings(demo):
    """(status, MeasurementSettings or None) for the demo hall."""
    status, body = demo.get(f"/api/settings/measurement?hallId={HALL_ID}")
    return status, (pick(body, "settings") if status == 200 else None)


def run_calibration_capture(demo):
    """Take (or simulate) one calibration frame and send it through upload → POST /api/calibrations."""
    inbox = demo.run / "calibration-inbox"
    common = ["--inbox", str(inbox), "--state-dir", str(demo.state), "--hall", HALL_ID,
              "--known-area-cm2", str(demo.args.known_area_cm2), "--reference-label", demo.args.reference_label]
    if demo.args.simulate:
        print("  --simulate: a SYNTHETIC calibration photo (a drawn credit card on the tray, 45 cm design height).")
        code, _ = run_live(["npm", "run", "--silent", "simulate-camera", "--", "--calibrate", *common],
                           cwd=REPO / "capture", env=demo.child_env())
        return code == 0
    if sys.stdin.isatty():
        input(f"\n  {bold('Lay the reference object')} ({demo.args.reference_label}, {demo.args.known_area_cm2} cm²) "
              "flat on the tray under the camera, no plate on it, and press Enter… ")
    command = [sys.executable, "capture/uno-q/laptop_capture.py", "--target", demo.args.target,
               "--out", str(inbox), "--calibrate"]
    if demo.args.password:
        command.append("--password")
    code, _ = run_live(command)
    if code != 0:
        demo.check("FAIL", f"Calibration photo failed (board {demo.args.target})")
        return False
    code, _ = run_live(["npm", "run", "--silent", "calibrate", "--", *common], cwd=REPO / "capture",
                       env=demo.child_env())
    return code == 0


def step_calibration(demo):
    """Camera calibration: a known-area reference gives k (cm² per pixel) and the camera height."""
    status, settings = measurement_settings(demo)
    if route_missing(status, settings):
        demo.check("WARN", "This backend has no calibration endpoints yet (IT_4 workstream B): physical numbers are off")
        return
    active = (settings or {}).get("activeCalibrationId")
    if not active or demo.args.recalibrate:
        why = "--recalibrate" if active else "No active calibration for this hall"
        if ask(f"{why}. Calibrate now ({'synthetic fixture' if demo.args.simulate else 'camera'})?"):
            if demo.args.simulate and settings is not None:
                # The synthetic card's scale doesn't match real camera frames: put the hall's previous
                # active calibration back when the run ends so later real plates aren't mis-scaled.
                demo.restore_settings = {"hallId": HALL_ID, "activeCalibrationId": settings.get("activeCalibrationId")}
            ok = run_calibration_capture(demo)
            demo.check("PASS" if ok else "FAIL", "Calibration capture uploaded and measured" if ok
                       else "Calibration failed (see output above)")
            status, settings = measurement_settings(demo)
            active = (settings or {}).get("activeCalibrationId")
    if not active:
        demo.check("WARN", "No calibration: grams / CO2e / water stay null (no_calibration). Pixels are unaffected.")
        return
    status, cal = demo.get(f"/api/calibrations/{urllib.parse.quote(active)}")
    cal = pick(cal, "calibration")
    if status != 200 or not isinstance(cal, dict):
        demo.check("FAIL", f"Active calibration {active}: HTTP {status}")
        return
    intr = cal.get("intrinsics") or {}
    rows = [
        ["Reference", f"{cal.get('referenceLabel')}, {num(cal.get('knownAreaCm2'), 2)} cm² (entered) = "
                      f"{num(cal.get('referencePixels'))} px in {cal.get('widthPx')}×{cal.get('heightPx')}"],
        ["k = area / pixels", f"{cal.get('cm2PerPx', 0):.6f} cm² per pixel" if cal.get("cm2PerPx") else "—"],
        ["Camera height", f"{num(cal.get('cameraHeightCmGeometric'), 1)} cm  (f·√k, fx {num(intr.get('fxPx'), 1)} px "
                          f"{intr.get('source', '?')})"],
        ["Flags", ", ".join(cal.get("flags") or []) or "none"],
    ]
    print()
    table(rows, ["Calibration " + active, ""], "ll")
    print(dim("    Area method (area-calibrated-v1): food area cm² = pixels × k. Recalibrate after moving the camera."))
    demo.calibration = cal
    demo.check("PASS" if cal.get("status") == "succeeded" else "FAIL",
               f"Active calibration {active}: status {cal.get('status')}, camera {cal.get('cameraId')}")


def step_camera(demo):
    """The Uno Q takes the photo and sends it to this laptop over SSH."""
    demo.inbox.mkdir(parents=True, exist_ok=True)
    plates = demo.args.plates
    if demo.args.simulate:
        print(f"  --simulate: using {plates} photo(s) from test2/ in the same inbox format as the camera.")
        code, _ = run_live(["npm", "run", "--silent", "simulate-camera", "--", "--inbox", str(demo.inbox),
                            "--count", str(plates)], cwd=REPO / "capture")
        if code != 0:
            demo.check("FAIL", "simulate-camera failed")
            return False
    else:
        base = [sys.executable, "capture/uno-q/laptop_capture.py", "--target", demo.args.target,
                "--out", str(demo.inbox), "--once"]
        if demo.args.password:
            base.append("--password")
        for n in range(1, plates + 1):
            if sys.stdin.isatty():
                input(f"\n  {bold(f'Place plate {n} of {plates} under the camera')} and press Enter… ")
            code, _ = run_live(base)
            if code != 0:
                demo.check("FAIL", f"Camera capture {n} failed (board {demo.args.target}). "
                                   "Check Wi-Fi/SSH, or rerun with --simulate.")
                return False
    rows = []
    for meta_path in sorted(demo.inbox.glob("*/metadata.json")):
        meta = json.loads(meta_path.read_text())
        rows.append([meta["captureId"][:8], f"{meta['widthPx']}×{meta['heightPx']}", num(meta["byteLength"]),
                     meta["sha256"][:12] + "…", meta.get("captureSource", "?"), meta["capturedAt"][11:19] + "Z"])
    print()
    table(rows, ["Capture", "Size", "Bytes", "SHA-256", "Source", "Taken"], "lrrlll")
    demo.check("PASS" if len(rows) == plates else "FAIL",
               f"{len(rows)} photo(s) on the laptop, checksum-verified after transfer")
    return len(rows) == plates


def step_upload(demo):
    """Bridge: photo -> R2 -> SpacetimeDB -> capture event -> analysis."""
    print("  Each photo is normalized to 1024×1024, uploaded to R2 with a presigned URL, finalized")
    print("  (SpacetimeDB image_object row), then submitted as a capture_event. Analysis runs on submit.\n")
    started = time.time()
    code, out = run_live(["npm", "run", "--silent", "ingest-inbox", "--", "--service", demo.service_id,
                          "--inbox", str(demo.inbox), "--state-dir", str(demo.state), "--no-dedupe"],
                         cwd=REPO / "capture", env=demo.child_env())
    demo.event_ids = re.findall(r"→ (cap_[0-9A-Z]+)", out)
    states = re.findall(r"→ cap_[0-9A-Z]+ \(([^)]*)\)", out)
    took = time.time() - started
    if not demo.event_ids:
        demo.check("FAIL", "No capture was ingested (see bridge output above)")
        return False
    ok = all(s in ("succeeded", "already ingested") for s in states)
    demo.check("PASS" if ok else "WARN",
               f"{len(demo.event_ids)} capture(s) ingested and analysed in {took:.0f} s: {', '.join(states)}")
    (demo.run / "events.json").write_text(json.dumps(demo.event_ids, indent=2) + "\n")
    return True


def step_analysis(demo):
    """Gemini classification + boxes, SAM 2.1 masks, pixels counted in code."""
    for event_id in demo.event_ids:
        status, body = demo.get(f"/api/captures/{event_id}")
        if status != 200:
            demo.check("FAIL", f"{event_id}: HTTP {status}")
            continue
        attempts = body.get("attempts") or []
        last = attempts[-1] if attempts else {}
        print(f"\n  {bold(event_id)}  source={body['event']['source']}  state={body['event']['state']}")
        print(dim(f"    classifier {last.get('model')}  prompt {last.get('promptVersion')}  status {last.get('status')}"))
        if last.get("status") == "failed":
            err = last.get("error") or {}
            demo.check("FAIL", f"Analysis failed: {err.get('code')} — {err.get('message')}")
            continue
        if "mock" in str(last.get("model", "")).lower():
            demo.check("WARN", "Backend is using the MOCK analyzer (no GEMINI_API_KEY): numbers are not real")
        measurements = body.get("measurements") or []
        count = (measurements[0].get("maskCount") or {}) if measurements else {}
        if count:
            print(dim(f"    1. classify + box  {count.get('classificationVersion')}"))
            print(dim(f"    2. segment         {count.get('segmentationVersion')}"))
            print(dim(f"    3. count pixels    {count.get('processingVersion')} "
                      f"({count.get('geometry', {}).get('widthPx')}×{count.get('geometry', {}).get('heightPx')} image)"))
        regions = spacetime_sql(demo, f"SELECT regionId FROM segmentation_region WHERE eventId = '{event_id}'")
        if regions is not None:
            print(dim(f"    SAM 2.1 masks for Gemini's boxes: {len(regions)}"))
        names = item_names(demo, body["event"]["serviceId"])
        rows = []
        total = 0
        for m in measurements:
            pixels = measurement_pixels(m)
            total += pixels
            rows.append([food_name(names, m.get("itemId")), num(pixels),
                         ", ".join(m.get("qualityFlags") or []) or "—"])
        if rows:
            table(rows, ["Food (Gemini label)", "Pixels wasted (SAM mask)", "Flags"], "lrl")
            demo.check("PASS", f"{num(total)} leftover-food pixels on this plate")
        else:
            demo.check("PASS", "Empty plate: 0 pixels wasted (valid zero)")


def step_area(demo):
    """Estimated area cm², grams, kg CO2e and L water per food from the calibration (labeled estimates)."""
    q = urllib.parse.urlencode({"hallId": HALL_ID, "start": demo.date, "end": demo.date, "limit": 200})
    status, listing = demo.get(f"/api/captures?{q}")
    rows = listing if isinstance(listing, list) else (listing or {}).get("captures", [])
    captures = {c["eventId"]: c for c in rows} if status == 200 else {}
    totals = {"areaCm2": 0.0, "grams": 0.0, "kgCo2e": 0.0, "waterLitres": 0.0}
    foods = {"with": 0, "without": 0}
    calibrated = 0
    for event_id in demo.event_ids:
        _, detail = demo.get(f"/api/captures/{event_id}")
        detail = detail or {}
        attempts = detail.get("attempts") or []
        last = attempts[-1] if attempts else {}
        entry = captures.get(event_id) or {}
        method = entry.get("physicalMethod") or last.get("physicalMethod")
        calibration_id = entry.get("calibrationId") or last.get("calibrationId")
        names = item_names(demo, (detail.get("event") or {}).get("serviceId", demo.service_id))
        print(f"\n  {bold(event_id)}  method={method or 'none'}  calibration={calibration_id or '—'}")
        if not method:
            demo.check("WARN", f"{event_id}: no physical estimate (no active calibration when analysed); pixels only")
            continue
        calibrated += 1
        table_rows = []
        for item in entry.get("items") or []:
            for key in totals:
                if isinstance(item.get(key), (int, float)):
                    totals[key] += item[key]
            foods["with" if isinstance(item.get("grams"), (int, float)) else "without"] += 1
            label = item.get("displayName") or food_name(names, item.get("itemId"))
            table_rows.append([label, num(item.get("pixels")), num(item.get("areaCm2"), 1), num(item.get("grams"), 0),
                               num(item.get("kgCo2e"), 3), num(item.get("waterLitres"), 1)])
        if table_rows:
            table(table_rows, ["Food", "Pixels", "Area cm²", "g (est.)", "kg CO2e (est.)", "L water (est.)"], "lrrrrr")
            demo.check("PASS", f"{event_id}: {len(table_rows)} food(s) with estimated physical numbers ({method})")
        else:
            demo.check("WARN", f"{event_id}: calibrated but the capture list has no per-food physical numbers yet")
    print(f"\n  {bold('Totals for these plates')} (estimates; — values are skipped, never counted as 0)")
    if calibrated:
        print(f"    {num(totals['areaCm2'], 1)} cm² · {num(totals['grams'], 0)} g · {num(totals['kgCo2e'], 3)} kg CO2e · "
              f"{num(totals['waterLitres'], 1)} L water")
    print(f"    Coverage: {calibrated} of {len(demo.event_ids)} plate(s) calibrated; "
          f"{foods['with']} food(s) with grams, {foods['without']} without (no factor row, or not on the menu)")
    print(dim("    area cm² = pixels × k;  grams = area × weight_g_per_cm2;  kg CO2e = g/1000 × C;  L water = g × W"))
    if calibrated:
        demo.check("PASS", f"Estimated totals for {calibrated} plate(s): {num(totals['grams'], 0)} g, "
                           f"{num(totals['kgCo2e'], 3)} kg CO2e, {num(totals['waterLitres'], 1)} L water")


def step_storage(demo):
    """R2 holds the bytes; SpacetimeDB holds only references and numbers."""
    for event_id in demo.event_ids:
        folder = demo.run / "images" / event_id
        folder.mkdir(parents=True, exist_ok=True)
        status, images = demo.get(f"/api/captures/{event_id}/images")
        if status != 200:
            demo.check("FAIL", f"{event_id}: images endpoint HTTP {status}")
            continue
        got = []
        for kind in ("original", "overlay"):
            ref = images.get(kind)
            if not ref:
                demo.check("WARN", f"{event_id}: no {kind} image")
                continue
            target = folder / f"{kind}.jpg"
            download(ref["url"], target)  # short-lived R2 read URL
            got.append(f"{kind} {target.stat().st_size // 1024} KB")
        masks = images.get("masks") or []
        demo.check("PASS", f"Downloaded from R2 via signed URLs: {', '.join(got)}; {len(masks)} mask PNG(s) stored")

        rows = spacetime_sql(demo, "SELECT objectKey, associationKind, provider, container FROM image_object "
                                   f"WHERE associationId = '{event_id}'")
        attempts = spacetime_sql(demo, f"SELECT attemptId, status FROM analysis_attempt WHERE eventId = '{event_id}'")
        if rows is None or attempts is None:
            demo.check("WARN", f"Could not query SpacetimeDB '{demo.args.db}' with the spacetime CLI")
            continue
        measurements = spacetime_sql(demo, f"SELECT measurementId FROM food_measurement WHERE eventId = '{event_id}'") or []
        for (measurement_id,) in measurements:  # per-food mask PNGs hang off their measurement
            rows += spacetime_sql(demo, "SELECT objectKey, associationKind, provider, container FROM image_object "
                                        f"WHERE associationId = '{measurement_id}'") or []
        counts = {}
        for key, kind, provider, container in rows:
            counts[kind] = counts.get(kind, 0) + 1
        for key, kind, provider, container in sorted(rows, key=lambda r: r[1] == "mask"):
            print(dim(f"    {provider}://{container}/{key}  ({kind})"))
        regions = spacetime_sql(demo, f"SELECT regionId FROM segmentation_region WHERE eventId = '{event_id}'")
        summary = ", ".join(f"{v} {k}" for k, v in sorted(counts.items()))
        demo.check("PASS", f"SpacetimeDB `{demo.args.db}`: 1 capture_event, {len(attempts)} analysis_attempt, "
                           f"{len(measurements)} food_measurement, {len(regions or [])} segmentation_region, "
                           f"image_object refs ({summary}); no image bytes in the database")


COMPOSE_JS = r"""
import sharp from 'sharp';
const [original, overlay, out, title, subtitle] = process.argv.slice(1);
const S = 900, GAP = 24, HEAD = 120, FOOT = 70, W = S * 2 + GAP * 3, H = HEAD + S + FOOT;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const text = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <style>.t{font:700 40px Helvetica,Arial,sans-serif;fill:#111}.l{font:600 26px Helvetica,Arial,sans-serif;fill:#444}
  .s{font:400 24px Helvetica,Arial,sans-serif;fill:#333}</style>
  <text x="${GAP}" y="52" class="t">${esc(title)}</text>
  <text x="${GAP}" y="100" class="l">1. Camera photo</text>
  <text x="${GAP * 2 + S}" y="100" class="l">2. AI segmentation (Gemini boxes → SAM 2.1 masks)</text>
  <text x="${GAP}" y="${HEAD + S + 46}" class="s">${esc(subtitle)}</text></svg>`;
const tile = (p) => sharp(p).resize(S, S, { fit: 'contain', background: '#f6f1e7' }).toBuffer();
await sharp({ create: { width: W, height: H, channels: 3, background: '#f6f1e7' } })
  .composite([
    { input: await tile(original), left: GAP, top: HEAD },
    { input: await tile(overlay), left: GAP * 2 + S, top: HEAD },
    { input: Buffer.from(text), left: 0, top: 0 },
  ]).jpeg({ quality: 90 }).toFile(out);
"""


def step_images(demo):
    """A presentable before/after picture for each plate."""
    pictures = []
    for event_id in demo.event_ids:
        folder = demo.run / "images" / event_id
        original, overlay = folder / "original.jpg", folder / "overlay.jpg"
        if not (original.exists() and overlay.exists()):
            demo.check("WARN", f"{event_id}: run the storage step first (needs original + overlay)")
            continue
        _, body = demo.get(f"/api/captures/{event_id}")
        names = item_names(demo, (body or {}).get("event", {}).get("serviceId", demo.service_id))
        foods = sorted(((food_name(names, m.get("itemId")), measurement_pixels(m))
                        for m in (body or {}).get("measurements") or []), key=lambda f: -f[1])
        subtitle = "  ·  ".join(f"{name}: {px:,} px" for name, px in foods[:4]) or "Empty plate: 0 px"
        out = folder / "before-after.jpg"
        done = subprocess.run(["node", "--input-type=module", "-e", COMPOSE_JS, str(original), str(overlay), str(out),
                               f"ScrapSaver · plate {event_id[-6:]} · {demo.date}", subtitle],
                              cwd=REPO / "capture", stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if done.returncode != 0:
            demo.check("WARN", f"Could not compose the picture: {done.stderr.strip()[-200:]}")
            pictures += [original, overlay]
            continue
        pictures.append(out)
        demo.check("PASS", f"Saved {show_path(out)}")
    if pictures and not demo.args.no_open:
        open_files(pictures)


def step_stats(demo):
    """Total waste, waste per portion, most wasted, relative impact, estimated CO2e and water."""
    status, d = demo.get(f"/api/dashboard/impact?{demo.window()}")
    if status != 200:
        demo.check("FAIL", f"/api/dashboard/impact HTTP {status}")
        return
    t = d["totals"]
    print(f"  {bold('Total waste')} ({demo.date}, {HALL_ID})")
    scanned = f"({t['captures']} scanned, {t['excludedCaptures']} excluded: failed or unusable)"
    print(f"    {bold(num(t['pixels']))} pixels wasted on {t['analyzedCaptures']} analysed plate(s)  {dim(scanned)}")
    print(f"    {num(t['impactPoints'], 1)} relative impact points  "
          + dim(f"= 0.19 × {num(t['co2Points'], 1)} CO2 pts (C) + 1.50 × {num(t['waterPoints'], 1)} water pts (W)"))
    if t.get("unavailableReason"):
        print(dim("    Food without a factor row (e.g. not on the menu) keeps its pixels but adds no points."))
    coverage = t.get("physicalCoverage") or {}
    if t.get("kgCo2e") is not None or t.get("waterLitres") is not None:
        print(f"    {bold(num(t.get('kgCo2e'), 2) + ' kg CO2e')} and {bold(num(t.get('waterLitres'), 0) + ' L water')} "
              f"estimated ({num(t.get('grams'), 0)} g, method {t.get('physicalMethod') or '—'})  "
              + dim(f"from {coverage.get('calibratedCaptures', '?')} of {coverage.get('analyzedCaptures', '?')} "
                    "calibrated plates"))
        demo.check("PASS", f"Estimated totals: {num(t.get('kgCo2e'), 2)} kg CO2e, {num(t.get('waterLitres'), 0)} L water "
                           f"({coverage.get('calibratedCaptures', '?')}/{coverage.get('analyzedCaptures', '?')} plates calibrated)")
    elif "kgCo2e" in t:
        print(dim(f"    Estimated CO2e / water: unavailable ({t.get('physicalUnavailableReason') or 'no calibrated plates'}); "
                  "pixels and points above are unaffected."))

    print(f"\n  {bold('Formula')}  (factors/README.md)")
    print("    base          = pixels / 1000 × weight_g_per_cm2")
    print("    impact points = base × (0.19·C + 1.50·W)     C = kg CO2e/kg, W = m³ freshwater/kg")
    print("    per portion   = Σ pixels ÷ Σ portions served (same meal)   nutrition is reported separately")

    targets = [r for r in d["targets"] if r.get("perPortion")]
    if targets:
        example = targets[0]
        f = load_factors().get(example.get("factorKey") or "")
        if f:
            base = example["impact"]["pixels"] / 1000 * float(f["weight_g_per_cm2"])
            print(dim(f"    e.g. {example['displayName']}: {example['impact']['pixels']:,} px / 1000 × "
                      f"{f['weight_g_per_cm2']} = {base:,.1f};  × (0.19·{f['C_kg_co2e_per_kg']} + "
                      f"1.50·{f['W_water_m3_per_kg']}) = {num(example['impact']['impactPoints'], 1)} pts"))

    print(f"\n  {bold('Foods to target')} — waste per portion (portions are DEMO dummy counts)"
          if d["labels"].get("demoPortions") else f"\n  {bold('Foods to target')} — waste per portion")
    rows = [[i + 1, r["displayName"], num(r["perPortion"]["pixels"], 0), num(r["impact"]["pixels"]),
             num(r["portionsServed"]), num(r["perPortion"].get("impactPoints"), 2)]
            for i, r in enumerate(targets[:6])]
    if rows:
        table(rows, ["#", "Food", "Pixels/portion", "Pixels", "Portions", "Points/portion"], "rlrrrr")
    else:
        print(dim("    No food with both pixels and portions served yet."))

    print(f"\n  {bold('Most wasted')} — total pixels")
    rows = [[i + 1, r["displayName"], num(r["impact"]["pixels"]), num(r["impact"].get("impactPoints"), 1),
             num(r["impact"].get("co2Points"), 1), num(r["impact"].get("waterPoints"), 1),
             num(r["impact"].get("grams"), 0), num(r["impact"].get("kgCo2e"), 3), num(r["impact"].get("waterLitres"), 1)]
            for i, r in enumerate(d["mostWasted"][:6])]
    table(rows, ["#", "Food", "Pixels", "Impact pts", "CO2 pts", "Water pts", "g (est.)", "kg CO2e", "L water"],
          "rlrrrrrrr")
    print(dim("    g / kg CO2e / L are estimates from calibrated plates only; — = unavailable (never 0)."))
    print(dim(f"\n    Nutrition (separate, not in the score): {num(t.get('nutritionPoints'), 1)} relative nutrition points"))
    demo.check("PASS", f"Stats for {demo.date}: {num(t['pixels'])} px across {t['analyzedCaptures']} plate(s)")
    if t["excludedCaptures"]:
        demo.check("INFO", f"{t['excludedCaptures']} excluded capture(s) today. Re-run failed ones with: "
                           f"node backend/scripts/retry-failed.mjs --start {demo.date} --end {demo.date}")


def step_recommendation(demo):
    """Gemini's recommendation, grounded in the numbers above."""
    status, rec = demo.get(f"/api/recommendation?{demo.window()}", timeout=120)
    if status != 200:
        demo.check("FAIL", f"/api/recommendation HTTP {status}")
        return
    print(f"  {wrap(rec['text'], 4)}\n")
    for b in rec.get("bullets", []):
        print(f"    • {b['text']}")
        print(dim(f"      {b['metric']}"))
    label = "Gemini" if rec["source"] == "gemini" else "rule-based FALLBACK (Gemini unavailable)"
    demo.check("PASS" if rec["source"] == "gemini" else "WARN", f"Source: {label}, generated {rec['generatedAt']}")


def step_dashboard(demo):
    """Open ScrapSaver: landing page → Dashboard (carbon by day) → Statistics → Behind the scenes."""
    end = demo.date
    start = (datetime.fromisoformat(end) - timedelta(days=6)).date().isoformat()
    q = urllib.parse.urlencode({"hallId": HALL_ID, "start": start, "end": end})
    status, d = demo.get(f"/api/dashboard/impact/daily?{q}", timeout=30)
    if status != 200:
        demo.check("FAIL", f"/api/dashboard/impact/daily HTTP {status} (restart the backend to load the route)")
    else:
        print(f"  {bold('Carbon emissions by day')} ({start} to {end}, estimated kg CO2e, calibrated plates only)")
        for day in d["days"]:
            kg = day["kgCo2e"]
            bar = "█" * max(1, round(kg * 20)) if kg else ""
            print(f"    {day['date']}  {num(kg, 2) + ' kg' if kg is not None else dim('—'):>10}  {bar}")
        with_kg = [x for x in d["days"] if x["kgCo2e"] is not None]
        demo.check("PASS" if with_kg else "WARN",
                   f"{len(with_kg)} of {len(d['days'])} day(s) have estimated CO2e"
                   + ("" if with_kg else " (calibrate the camera for kg CO2e)"))
    url = demo.args.dashboard_url
    parsed = urllib.parse.urlparse(url)
    if not (port_open(parsed.port or 80, parsed.hostname or "localhost")):
        if dashboard_served_by_backend(demo):
            url = demo.api + "/"  # production build served by the backend (deploy/local.sh)
        else:
            demo.check("FAIL", f"Dashboard not running at {url} (cd frontend && npm run dev, or deploy/local.sh up)")
            return
    print("  ScrapSaver → Get started → Dashboard (Today / This week: carbon, water, food, plates; carbon by day),")
    print("  Statistics (Last 30 / 90 days, recommendations, foods to target, most wasted), Behind the scenes (plates).")
    if not demo.args.no_open:
        webbrowser.open(url)
    demo.check("PASS", f"Opened {url}")


def step_admin(demo):
    """Admin page: staff choose which plates the dashboard shows (hidden plates are kept, never deleted)."""
    rows = spacetime_sql(demo, "SELECT event_id FROM capture_event")
    hidden = spacetime_sql(demo, "SELECT event_id FROM capture_visibility WHERE hidden = true")
    if rows is None or hidden is None:
        demo.check("WARN", f"Could not query SpacetimeDB '{demo.args.db}' (capture_visibility needs the 2026-10-04 module)")
    else:
        demo.check("PASS", f"{len(rows) - len(hidden)} plate(s) shown on the dashboard, {len(hidden)} hidden by an admin "
                           "(hidden plates stay in SpacetimeDB and R2)")
    status, _ = demo.get(f"/api/admin/captures?{demo.window()}", timeout=10, anonymous=True)  # no token on purpose
    if status == 401:
        demo.check("PASS", "Admin list needs a staff sign-in (401 without one)")
    elif status == 200:
        demo.check("WARN", "Admin list answered without sign-in: the backend runs open (no SCRAP_ADMIN_PASSCODE)")
    else:
        demo.check("FAIL", f"/api/admin/captures HTTP {status}")
    url = demo.args.dashboard_url.rstrip("/") + "/admin"
    print(f"  Admin page (unlisted): {url}  (passcode if the backend sets one, then Shown/Hidden per plate)")
    if not demo.args.no_open:
        webbrowser.open(url)


def step_upload_site(demo):
    """Upload website: one button → results page with original, Gemini classification, SAM masks, total wasted (upload_demo/)."""
    port = int(os.environ.get("UPLOAD_DEMO_PORT", "8795"))
    url = f"http://localhost:{port}"
    up = http_ok(url + "/api/foods")[0]
    if not up and not demo.args.no_start and ask("The upload website is not running. Start it now?"):
        log = demo.run / "logs" / "upload-site.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        process = subprocess.Popen(["node", "upload_demo/server.mjs"], cwd=REPO, stdout=open(log, "w"),
                                   stderr=subprocess.STDOUT, start_new_session=True)
        demo.started.append(("Upload website", process.pid, log))
        print(dim(f"    started upload website (pid {process.pid}), log {show_path(log)}"))
        deadline = time.time() + 20
        while time.time() < deadline and not up:
            time.sleep(0.5)
            up = http_ok(url + "/api/foods")[0]
    if not up:
        demo.check("FAIL", f"Upload website not reachable at {url}  (start: node upload_demo/server.mjs)")
        return
    demo.check("PASS", f"Upload website at {url}")
    print(f"  Running the sample halal chicken + rice bowl through the website's API (2 Gemini calls)...")
    sample = urllib.request.urlopen(url + "/sample.jpg", timeout=10).read()
    req = urllib.request.Request(url + "/api/analyze", data=sample, method="POST",
                                 headers={"content-type": "image/jpeg"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            result = json.loads(r.read())
    except urllib.error.HTTPError as e:
        demo.check("FAIL", f"Upload analysis HTTP {e.code}: {e.read()[:200].decode(errors='replace')}")
        return
    s = result["summary"]
    rows = [[f["food"], num(f["pixelsWasted"]), num((f["factors"] or {}).get("co2KgPerKg"), 2),
             num((f["points"] or {}).get("co2Points"), 1), num((f["points"] or {}).get("waterPoints"), 1)] for f in s["foods"]]
    table(rows, ["Food", "Pixels wasted", "kg CO2e/kg", "CO2 pts", "Water pts"], "lrrrr")
    out = demo.run / "upload-site"
    out.mkdir(parents=True, exist_ok=True)
    for key, name in [("original", "1_original"), ("boxes", "2_gemini_boxes"), ("masks", "3_sam_segmentation"), ("final", "4_final_result")]:
        if result["images"].get(key):
            (out / f"{name}.jpg").write_bytes(base64.b64decode(result["images"][key].split(",", 1)[1]))
    print(dim(f"  Step pictures: {show_path(out)}/  (halal bowl reference set: demo_pictures/)"))
    found = {f["food"] for f in s["foods"]}
    ok = s["countStatus"] == "complete" and {"Halal Chicken", "Halal Rice"} <= found
    demo.check("PASS" if ok else "WARN", f"Sample bowl: {num(s['capturePixelsWasted'])} px, {s['countStatus']}, "
               f"found {', '.join(sorted(found)) or 'nothing'} (matched against the full food database) in {s['seconds']} s")
    print(f"  Results page: {url}/results/{result['id']}")
    if not demo.args.no_open:
        webbrowser.open(f"{url}/results/{result['id']}")


def step_deploy(demo):
    """The production URL (SCRAP_PROD_URL) answers: health, readiness, dashboard over HTTPS."""
    url = (demo.args.prod_url or "").rstrip("/")
    if not url:
        demo.check("WARN", "SCRAP_PROD_URL is not set: no production URL to check (local stack: deploy/local.sh status)")
        return
    if not urllib.parse.urlsplit(url).hostname:
        demo.check("FAIL", f"SCRAP_PROD_URL {url!r} has no host (is $DOMAIN set in this terminal?)")
        return
    if not url.startswith("https://") and not is_local(url):
        demo.check("WARN", f"{url} is not https")
    # Public reads: no ingest token, so a 403 here is never blamed on the token.
    status, health = demo.request("GET", "/api/health", base=url, timeout=15, anonymous=True)
    demo.check("PASS" if status == 200 else "FAIL", f"{url}/api/health HTTP {status}"
               + (f"  {dim('storage: ' + str((health or {}).get('provider')))}" if status == 200 else ""))
    status, ready = demo.request("GET", "/api/ready", base=url, timeout=30, anonymous=True)
    detail = ""
    if isinstance(ready, dict):
        parts = {k: v for k, v in ready.items() if k != "ready"}
        detail = "  " + dim(json.dumps(parts)[:200])
    demo.check("PASS" if status == 200 else "FAIL", f"{url}/api/ready HTTP {status}{detail}")
    ok, body = http_ok(url + "/", timeout=15)
    html = ok and b"<html" in body[:4000].lower()
    demo.check("PASS" if html else "FAIL", f"{url}/ serves the dashboard HTML" if html else f"{url}/ did not return the dashboard")
    if html and not demo.args.no_open and demo.args.only and "deploy" in demo.args.only:
        webbrowser.open(url + "/")


def step_try_image(demo):
    """Try an Image: Behind the scenes → Try an Image runs one visitor photo through Gemini + SAM 2.1 (not stored)."""
    status, body = demo.get("/api/try-image/status", timeout=10, anonymous=True)
    if status != 200 or not isinstance(body, dict):
        demo.check("FAIL", f"GET /api/try-image/status: HTTP {status} (restart the backend: deploy/local.sh restart)")
        return
    if body.get("available"):
        demo.check("PASS", f"Try an Image is open to visitors without sign-in: {body.get('hourlyRemaining')} analyses left "
                           f"this hour, {body.get('waiting')} waiting (each photo costs 2 Gemini calls; nothing is stored)")
    else:
        demo.check("WARN", f"Try an Image is unavailable: {body.get('reason')}")
    ok, sample = http_ok(demo.api + "/api/try-image/sample.jpg")
    demo.check("PASS" if ok and sample[:2] == b"\xff\xd8" else "FAIL", "Sample photo served at /api/try-image/sample.jpg")
    url = demo.args.dashboard_url.rstrip("/") + "/behind-the-scenes/try-an-image"
    print(f"  Open {url}  (Upload a photo, or Use the sample photo)")
    if not demo.args.no_open:
        webbrowser.open(url)


def step_demo_data(demo):
    """Dashboard demo-data controls: GET /api/demo/status (read-only; the buttons live on the dashboard)."""
    status, body = demo.get(f"/api/demo/status?hallId={HALL_ID}", timeout=10, anonymous=True)
    if status != 200 or not isinstance(body, dict):
        demo.check("FAIL", f"GET /api/demo/status: HTTP {status} (restart the backend: deploy/local.sh restart)")
        return
    print(f"  mode={body.get('mode')}  sample captures={body.get('sampleCaptures')}  cleared at={body.get('clearedAt')}")
    demo.check("PASS", f"Demo data mode is '{body.get('mode')}' (default = live dashboard; Load dummy data / Clear data / "
                       "Restore default switch it, and nothing real is ever deleted)")


STEPS = [
    ("services", "Services", step_services),
    ("menu", "Menu, waste factors and portions served", step_menu),
    ("calibration", "Camera calibration (cm² per pixel, camera height)", step_calibration),
    ("camera", "Camera → laptop", step_camera),
    ("upload", "Laptop → R2 + SpacetimeDB (inbox bridge)", step_upload),
    ("analysis", "AI analysis: Gemini → SAM 2.1 → pixel count", step_analysis),
    ("area", "Estimated area, grams, CO2e and water", step_area),
    ("storage", "Where everything is stored", step_storage),
    ("images", "Photo vs. segmentation", step_images),
    ("stats", "Waste statistics", step_stats),
    ("recommendation", "AI recommendation", step_recommendation),
    ("dashboard", "Dashboard", step_dashboard),
    ("admin", "Admin: choose which plates are shown", step_admin),
    ("upload_site", "Upload website: photo → results page", step_upload_site),
    ("try_image", "Try an Image (dashboard → Behind the scenes)", step_try_image),
    ("demo_data", "Demo data controls (load / clear / restore)", step_demo_data),
    ("deploy", "Production URL", step_deploy),
]
NEEDS_EVENTS = {"analysis", "area", "storage", "images"}


# ----------------------------------------------------------------- helpers ---

def item_names(demo, service_id):
    status, menu = demo.get(f"/api/menus/by-service/{service_id}")
    return {i["itemId"]: i["displayName"] for i in menu["menu"]["items"]} if status == 200 else {}


def food_name(names, item_id):
    if item_id is None:
        return "Food not on the menu"
    return names.get(item_id) or item_id.rsplit("_", 1)[-1].replace("-", " ").title()


def measurement_pixels(m):
    count = m.get("maskCount") or {}
    return int(count.get("pixelsWasted", m.get("remainingAreaPx") or 0))


def show_path(path):
    try:
        return str(Path(path).resolve().relative_to(REPO))
    except ValueError:
        return str(path)


def download(url, target):
    """curl first: python.org builds on macOS often lack CA certificates for HTTPS."""
    if shutil.which("curl"):
        done = subprocess.run(["curl", "-fsS", "--max-time", "60", "-o", str(target), url],
                              stderr=subprocess.PIPE, text=True)
        if done.returncode == 0:
            return
        raise OSError(f"download failed: {done.stderr.strip()}")
    with urllib.request.urlopen(url, timeout=60) as r:
        target.write_bytes(r.read())


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def load_factors():
    """Factor rows by slug, in the app's lookup order (data/src/factors.ts): the
    hall's own table (menu_waste_factors_EastQuad.csv) first, then the 500
    common foods (menu_waste_factors_500.csv) as a fallback. The hall row wins."""
    east_quad = next((p for p in (FACTORS / "menu_waste_factors_EastQuad.csv", FACTORS / "menu_waste_factors.csv") if p.exists()), None)
    factors = {}
    for path in (east_quad, FACTORS / "menu_waste_factors_500.csv"):
        if path is None or not path.exists():
            continue
        with path.open(newline="", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                factors.setdefault(slug(row["food"]), row)
    return factors


def wrap(text, indent):
    width = max(60, shutil.get_terminal_size((100, 20)).columns - indent - 2)
    words, lines, line = text.split(), [], ""
    for w in words:
        if len(line) + len(w) + 1 > width:
            lines.append(line)
            line = w
        else:
            line = f"{line} {w}".strip()
    lines.append(line)
    return ("\n" + " " * indent).join(lines)


def open_files(paths):
    opener = {"darwin": "open", "win32": None}.get(sys.platform, "xdg-open")
    if sys.platform == "win32":
        for p in paths:
            os.startfile(str(p))  # noqa: S606
    elif shutil.which(opener):
        subprocess.run([opener, *map(str, paths)])


def main():
    global HALL_ID
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--simulate", action="store_true", help="Use test2/ photos instead of the Uno Q camera")
    parser.add_argument("--plates", type=int, default=1, help="Plates to photograph (default 1)")
    parser.add_argument("--target", default=DEFAULT_BOARD, help=f"Board SSH target (default {DEFAULT_BOARD})")
    parser.add_argument("--password", action="store_true", help="Type the board password instead of using an SSH key")
    parser.add_argument("--hall", default=HALL_ID,
                        help=f"Dining hall (default {HALL_ID}). Another hall, e.g. hall-test, keeps {HALL_ID}'s numbers "
                             "untouched: its dinner is seeded from the same demo menu")
    parser.add_argument("--service", help="serviceId (default: today's dinner, seeded if missing)")
    parser.add_argument("--date", help="Hall-local date YYYY-MM-DD for stats (default: today in America/Detroit)")
    parser.add_argument("--events", help="Comma-separated capture IDs to show instead of taking new photos")
    parser.add_argument("--api", default=os.environ.get("SCRAP_API_URL") or os.environ.get("API_URL") or "http://localhost:8787",
                        help="Backend URL (default $SCRAP_API_URL, else $API_URL, else http://localhost:8787)")
    parser.add_argument("--token-env", default="SCRAP_INGEST_TOKEN",
                        help="Environment variable with the ingest token (default SCRAP_INGEST_TOKEN)")
    parser.add_argument("--prod-url", default=os.environ.get("SCRAP_PROD_URL"),
                        help="Production URL for the deploy step (default $SCRAP_PROD_URL)")
    parser.add_argument("--recalibrate", action="store_true", help="Take a new calibration even if one is active")
    parser.add_argument("--known-area-cm2", type=float, default=46.21,
                        help="Calibration reference area in cm² (default 46.21 = credit card)")
    parser.add_argument("--reference-label", default="credit card", help="Calibration reference object")
    parser.add_argument("--dashboard-url", default="http://localhost:5173/")
    parser.add_argument("--db", default=os.environ.get("SPACETIMEDB_MODULE", "scrap"), help="SpacetimeDB database")
    parser.add_argument("--only", help="Comma-separated steps to run (see --list)")
    parser.add_argument("--skip", help="Comma-separated steps to skip")
    parser.add_argument("--list", action="store_true", help="List the steps and exit")
    parser.add_argument("--yes", action="store_true", help="Don't pause between steps")
    parser.add_argument("--no-open", action="store_true", help="Don't open images or the browser")
    parser.add_argument("--no-start", action="store_true", help="Never offer to start missing services")
    parser.add_argument("--out", type=Path, help="Run folder (default images/demo-runs/<UTC time>)")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", args.hall):
        parser.error("--hall must be 1-64 letters, digits, '.', '_' or '-'")
    HALL_ID = args.hall

    if args.list:
        for key, title, fn in STEPS:
            print(f"  {key:<15} {title} — {fn.__doc__}")
        return 0
    if not 1 <= args.plates <= 10:
        parser.error("--plates must be between 1 and 10")
    keys = [k for k, _, _ in STEPS]
    only = [s.strip() for s in args.only.split(",")] if args.only else keys
    skip = {s.strip() for s in args.skip.split(",")} if args.skip else set()
    unknown = (set(only) | skip) - set(keys)
    if unknown:
        parser.error(f"unknown step(s): {', '.join(sorted(unknown))}. Use --list.")
    if args.events:
        skip |= {"camera", "upload"}

    demo = Demo(args)
    demo.run.mkdir(parents=True, exist_ok=True)
    if args.events:
        demo.event_ids = [e.strip() for e in args.events.split(",") if e.strip()]

    camera = "simulated camera (test2/ photos)" if args.simulate else f"Uno Q camera at {args.target}"
    print(bold("\nScrapSaver demo") + dim(f" — {camera}, {args.plates} plate(s), {demo.service_id}"))
    print(dim(f"Run folder: {show_path(demo.run)}"))

    selected = [(k, t, f) for k, t, f in STEPS if k in only and k not in skip]
    for index, (key, title, fn) in enumerate(selected, 1):
        demo.step = key
        if key in NEEDS_EVENTS and not demo.event_ids:
            print(f"\n{dim(f'[{index}/{len(selected)}] {title}: skipped, no captures (use --events cap_…)')}")
            continue
        print(f"\n{cyan('━' * 4)} {bold(f'[{index}/{len(selected)}] {title}')} {cyan('━' * 4)}")
        print(dim(f"  {fn.__doc__}"))
        try:
            outcome = fn(demo)
        except (urllib.error.URLError, OSError) as error:
            demo.check("FAIL", f"{type(error).__name__}: {error}")
            outcome = False
        if outcome is False and key in ("services", "menu", "camera", "upload"):
            if any(s == "FAIL" for s, k, _ in demo.results if k == key):
                print(red(f"\n  Stopping: the '{key}' step failed, later steps depend on it."))
                break
        if not args.yes and index < len(selected) and sys.stdin.isatty():
            input(dim("\n  Press Enter for the next step… "))

    if demo.restore_settings is not None:
        status, _ = demo.request("PUT", "/api/settings/measurement", demo.restore_settings)
        print(dim(f"\n  Restored {HALL_ID}'s measurement settings (the synthetic calibration is no longer active): HTTP {status}"))

    print(f"\n{cyan('━' * 4)} {bold('Summary')} {cyan('━' * 4)}")
    counts = {s: sum(1 for r in demo.results if r[0] == s) for s in ("PASS", "WARN", "FAIL")}
    print("  " + "  ".join([green(f"{counts['PASS']} passed"), yellow(f"{counts['WARN']} warnings"),
                            red(f"{counts['FAIL']} failed")]))
    for status, step, message in demo.results:
        if status in ("WARN", "FAIL"):
            print(f"  {status} [{step}] {message}")
    if demo.event_ids:
        print(dim(f"  Captures: {', '.join(demo.event_ids)}  (re-show: python3 demo.py --events {','.join(demo.event_ids)})"))
    for name, pid, log in demo.started:
        print(dim(f"  {name} left running (pid {pid}); log {log}"))
    (demo.run / "results.json").write_text(json.dumps(
        [{"status": s, "step": k, "message": re.sub(r"\033\[[0-9;]*m", "", m)} for s, k, m in demo.results],
        indent=2) + "\n")
    return 1 if counts["FAIL"] else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(130)
