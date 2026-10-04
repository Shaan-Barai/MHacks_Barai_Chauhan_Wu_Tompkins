#!/usr/bin/env python3
"""ScrapSaver end-to-end demo: plate photo -> AI segmentation -> waste stats -> dashboard.

    python3 demo.py                    # real camera (Uno Q + C920s), 1 plate
    python3 demo.py --plates 3         # three plates, one photo each
    python3 demo.py --simulate         # no board: use the test2/ plate photos
    python3 demo.py --simulate --yes   # no pauses between steps
    python3 demo.py --list             # show the steps
    python3 demo.py --only stats,recommendation,dashboard   # re-show results only

Each step prints what it does and proves it with real data:
  services        SpacetimeDB, SAM 2.1 worker, backend (R2), dashboard are up (offers to start them)
  menu            today's dinner menu + demo portions served (seeds them if missing)
  camera          the Uno Q takes a photo and SSHes it to this laptop (or --simulate)
  upload          bridge: photo -> R2 (presigned PUT) -> SpacetimeDB image_object -> capture_event
  analysis        Gemini classifies + boxes the food, SAM 2.1 segments it, code counts pixels
  storage         R2 holds photo, overlay and masks; SpacetimeDB holds only references
  images          side-by-side "camera photo | AI segmentation" picture
  stats           total waste, waste per portion, most wasted, relative impact (C + W)
  recommendation  Gemini's suggestion grounded in those numbers
  dashboard       opens the ScrapSaver dashboard

ADDING A FEATURE? Add a step function below and an entry in STEPS (see AGENTS.md
"Demo script"). Keep each step self-contained: read what it needs from `demo`,
print, and record PASS/WARN/FAIL with demo.check().

Everything this run writes locally goes to images/demo-runs/<time>/ (gitignored).
The captures it creates are real rows in the configured database (default `scrap`).
"""

import argparse
from datetime import datetime, timezone
import csv
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    ZoneInfo = None

REPO = Path(__file__).resolve().parent
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

class Demo:
    def __init__(self, args):
        self.args = args
        self.api = args.api.rstrip("/")
        self.run = args.out or REPO / "images" / "demo-runs" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.inbox = self.run / "inbox"
        self.state = self.run / "bridge-state"
        self.date = args.date or hall_today()
        self.service_id = args.service or f"svc_{HALL_ID}_{self.date}_dinner"
        self.event_ids = []          # captures created by this run
        self.results = []            # (status, step, message)
        self.step = ""
        self.started = []            # services this run started

    def check(self, status, message):
        self.results.append((status, self.step, message))
        mark = {"PASS": green("✓"), "WARN": yellow("!"), "FAIL": red("✗"), "INFO": cyan("•")}[status]
        print(f"  {mark} {message}", flush=True)

    # -- HTTP --
    def get(self, route, timeout=60):
        return self.request("GET", route, timeout=timeout)

    def request(self, method, route, body=None, timeout=60):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.api + route, data=data, method=method,
                                     headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"null")
            except ValueError:
                return e.code, None

    def window(self):
        return urllib.parse.urlencode({"hallId": HALL_ID, "start": self.date, "end": self.date})


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
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
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
    # name, port, health URL, start command, cwd, wait seconds
    ("SpacetimeDB", 3000, None, ["spacetime", "start"], REPO, 20),
    ("SAM 2.1 worker", 8790, "http://127.0.0.1:8790/health", [".venv/bin/python", "vision/sam/worker.py"], REPO, 90),
    ("Backend API", 8787, "http://127.0.0.1:8787/api/health", ["npm", "start"], REPO / "backend", 120),
    ("Dashboard", 5173, None, ["npm", "run", "dev"], REPO / "frontend", 30),
]


def step_services(demo):
    """Everything the pipeline needs is running."""
    for name, port, health, command, cwd, wait in SERVICES:
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
            demo.check("FAIL", f"{name} not reachable on :{port}  (start: cd {cwd.relative_to(REPO) or '.'} && {' '.join(command)})")
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
    if not demo.args.simulate:
        if shutil.which("ssh") is None:
            demo.check("FAIL", "ssh is not installed (needed for the camera)")


def step_menu(demo):
    """Today's dinner menu, with waste factors and demo portions served."""
    status, menu = demo.get(f"/api/menus/by-service/{demo.service_id}")
    if status != 200 and not demo.args.service:
        print(f"  No menu for {demo.service_id} yet. Seeding the 23-food demo dinner for {demo.date}…")
        run_live(["npm", "run", "--silent", "seed", "--", f"--live-dinner={demo.date}"], cwd=REPO / "backend",
                 env={"API_URL": demo.api})
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
        run_live(["npm", "run", "--silent", "seed", "--", f"--live-dinner={demo.date}"], cwd=REPO / "backend",
                 env={"API_URL": demo.api})
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
                     f["weight_g_per_cm2"] if f else "—", f["C_kg_co2e_per_kg"] if f else "—",
                     f["W_water_m3_per_kg"] if f else "—", f["impact_score_usd_per_kg"] if f else "—"])
    print()
    table(rows, ["Food", "Portions", "g/cm²", "C kgCO2e/kg", "W m³/kg", "0.19C+1.50W"], "lrrrrr")
    if len(items) > 8:
        print(dim(f"    … and {len(items) - 8} more"))
    return True


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
                         cwd=REPO / "capture", env={"API_URL": demo.api})
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
    """Total waste, waste per portion, most wasted, relative impact."""
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

    print(f"\n  {bold('Formula')}  (menu_waste_factors_README.md)")
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
             num(r["impact"].get("co2Points"), 1), num(r["impact"].get("waterPoints"), 1)]
            for i, r in enumerate(d["mostWasted"][:6])]
    table(rows, ["#", "Food", "Pixels", "Impact pts", "CO2 pts", "Water pts"], "rlrrrr")
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
    """Open the ScrapSaver dashboard."""
    url = demo.args.dashboard_url
    if not port_open(urllib.parse.urlparse(url).port or 80):
        demo.check("FAIL", f"Dashboard not running at {url} (cd frontend && npm run dev)")
        return
    print("  Dashboard → last 7 days: Total waste, Relative impact, AI recommendation, Foods to target")
    print("  (pixels per portion), Most wasted, Pixels by day, and Plates (toggle photo ↔ AI outline).")
    print(dim("  First visit in a browser asks for the dining hall name once."))
    if not demo.args.no_open:
        webbrowser.open(url)
    demo.check("PASS", f"Opened {url}")


STEPS = [
    ("services", "Services", step_services),
    ("menu", "Menu, waste factors and portions served", step_menu),
    ("camera", "Camera → laptop", step_camera),
    ("upload", "Laptop → R2 + SpacetimeDB (inbox bridge)", step_upload),
    ("analysis", "AI analysis: Gemini → SAM 2.1 → pixel count", step_analysis),
    ("storage", "Where everything is stored", step_storage),
    ("images", "Photo vs. segmentation", step_images),
    ("stats", "Waste statistics", step_stats),
    ("recommendation", "AI recommendation", step_recommendation),
    ("dashboard", "Dashboard", step_dashboard),
]
NEEDS_EVENTS = {"analysis", "storage", "images"}


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
    path = REPO / "menu_waste_factors.csv"
    if not path.exists():
        return {}
    with path.open(newline="") as f:
        return {slug(row["food"]): row for row in csv.DictReader(f)}


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
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--simulate", action="store_true", help="Use test2/ photos instead of the Uno Q camera")
    parser.add_argument("--plates", type=int, default=1, help="Plates to photograph (default 1)")
    parser.add_argument("--target", default=DEFAULT_BOARD, help=f"Board SSH target (default {DEFAULT_BOARD})")
    parser.add_argument("--password", action="store_true", help="Type the board password instead of using an SSH key")
    parser.add_argument("--service", help="serviceId (default: today's dinner, seeded if missing)")
    parser.add_argument("--date", help="Hall-local date YYYY-MM-DD for stats (default: today in America/Detroit)")
    parser.add_argument("--events", help="Comma-separated capture IDs to show instead of taking new photos")
    parser.add_argument("--api", default=os.environ.get("API_URL", "http://localhost:8787"))
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
