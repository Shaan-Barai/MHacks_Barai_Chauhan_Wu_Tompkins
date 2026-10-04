# Minimal runbook

The demo database is **`scrap`** (BIG-PLAN v2). Pixels wasted is the stored measurement; impact is shown
as unitless **relative impact points**; each capture counts only the **target dish** (the plate being
scanned). With an active camera calibration (IT_4, [calibration.md](calibration.md)), captures also get
**estimated** grams, kg CO2e and litres of water. `scrap-bigplan` is retired: don't point new runs at it.

## Run every test: `./test-all.sh`

One command from the repo root runs every suite and ends with a PASS/FAIL table (suite, result,
passed/failed/skipped counts, duration). The exit code is non-zero when anything failed.

```bash
./test-all.sh                  # offline (no network): ~2 min
./test-all.sh --live           # + the local stack, smoke test, live E2E and the demo (Gemini/SAM/R2 calls)
./test-all.sh --only backend,tests          # just some suites (./test-all.sh --list)
./test-all.sh --skip frontend-build --install   # npm ci everywhere first, skip one suite
./test-all.sh -v               # stream each suite's output
```

| Suite | What it runs |
| --- | --- |
| `install` | `npm ci` in data, vision, analytics, capture, backend, frontend, db/spacetimedb where `node_modules` is missing (every package with `--install`) |
| `data` `vision` `analytics` `capture` `backend` | each package's `npm test` (tsc + `node --test`), in dependency order |
| `frontend` / `frontend-build` | `vitest run` / `tsc -b && vite build` |
| `db` | `db/spacetimedb` typecheck |
| `tests` | `tests/` contract fixtures + cross-system integration (live E2E skipped) |
| `python` | `python3 -m unittest discover -s capture/uno-q` (simulated board, no hardware) |
| `scripts` | `bash -n` + `shellcheck` (if installed) on deploy scripts, `node --check`, Python syntax, `demo.py --list`, JSON configs |
| `stack` (live) | `deploy/local.sh up`: starts or reuses SpacetimeDB, SAM 2.1 and the backend |
| `seed` (live) | today's 26-food demo dinner + demo portions for the test hall `hall-test` |
| `smoke` (live) | `deploy/smoke.mjs`: health, ready, dashboard HTML, 401 on unauthenticated writes, one upload → analysis round trip on `hall-smoke` |
| `e2e-flow` (live) | `tests/e2e/demo-flow.test.mjs` on its own `hall-e2e-<time>` |
| `e2e-scrap` (live) | `tests/e2e/scrap-live.test.mjs` on `svc_hall-test_<today>_dinner` (2 photos) |
| `e2e-calibration` (live) | `tests/e2e/calibration-live.test.mjs`: synthetic-card calibration → capture → area/grams/CO2e/water on `hall-e2e-cal` |
| `demo` (live) | `python3 demo.py --simulate --yes --no-open --no-start --hall hall-test` |

- **Live suites never touch hall-main.** They write only to test halls (`hall-test`, `hall-smoke`,
  `hall-e2e-*`), and every measurement setting they change is put back. A live suite named in `--only`
  runs without `--live` (e.g. `--only stack,smoke`).
- **Secrets:** the live suites load the stack's secrets the same way `deploy/local.sh` does
  (`deploy/.run/local-secrets.env`, then `.env`), never print them, and redact their values from the
  logs.
- **Processes:** `test-all.sh` never stops or kills anything. The stack it starts (or reuses) stays up;
  stop it with `deploy/local.sh down`.
- **Logs:** `tests/.logs/<UTC time>/<suite>.log` (gitignored); `tests/.logs/latest` is the last run. A
  failed suite also prints its last 15 log lines.
- A git worktree can reuse the main checkout's running stack and token:
  `SCRAP_RUN_DIR=/path/to/main/deploy/.run ./test-all.sh --live`.

## Start (fixture-only machine)

```bash
./test-all.sh                  # everything offline; or only the cross-system checks:
cd tests && npm test
```

Expected: all integration tests pass; the live e2e suites are skipped unless `SCRAP_E2E=1`.

## Start (full stack: R2 + `scrap` + Gemini + SAM)

Five terminals. The real secrets live in `/Users/mike/mhacks/.env` (gitignored; `SPACETIMEDB_MODULE=scrap`).
Variables set in the shell override `--env-file`.

```bash
# 1. SpacetimeDB (already running locally on :3000 in the dev setup)
spacetime start
#    once, or after a schema change. Additive publish in place; NEVER --delete-data on `scrap`:
cd db/spacetimedb && npm ci && \
  spacetime publish --module-path . --server local --delete-data=never --yes=migrate,break-clients scrap
#    if the CLI says the change needs a data wipe, stop: the schema change is not additive.

# 2. SAM 2.1 worker on :8790 (from the repo root; run only one)
.venv/bin/python vision/sam/worker.py

# 3. Backend on :8787. npm start loads <checkout>/.env; in a worktree, pass the real file instead:
cd backend && npm ci && npm run build
PORT=8787 node --env-file=/Users/mike/mhacks/.env dist/backend/src/server.js
#    expect: "storage: r2, persistence: SpacetimeDB scrap, vision: Gemini classification + SAM 2.1 masks"
#    once (idempotent): cd backend && npm run seed -- --live-dinner
#      menus incl. the 26-food dinners for 2026-10-01..03 (a menu revision where the stored items
#      differed), demo portions, and today's dinner (hall-local date, America/Detroit) for the camera.

# 4. Frontend: http://localhost:5173 (proxies /api to :8787)
cd frontend && npm run dev

# 5. Capture: the real Uno Q (BRIDGE.md, service svc_hall-main_<today>_dinner) or the simulator
cd capture && npm run simulate-camera -- --count 3 --service svc_hall-main_2026-10-03_dinner --state-dir /tmp/scrap-demo-state
```

Smoke checks:
- `curl -s localhost:8787/api/health` should return `{"ok":true,"provider":"r2"}`.
- `curl -s 127.0.0.1:8790/health` should show `sam2.1-hiera-small`.
- `curl -s "localhost:8787/api/services?hallId=hall-main"` should list the 2026-10-01..04 services.
- `curl -s "localhost:8787/api/dashboard/impact?start=2026-10-03&end=2026-10-04&hallId=hall-main"` should
  return pixel totals, relative impact points (`labels.relativeImpact: true`) and
  `coverage.capturesWithNeighborFoodExcluded`.

Always pass `hallId=hall-main`; the backend's live repository test writes rows for throwaway halls
(`hall-t…`).

### Menu revisions (why some services are at version 2 or 3)

`npm run seed` never overwrites a stored menu. It plans each one with `data/` `planMenuRevision`: a new
service is created, an identical menu is left alone, and a menu whose items changed becomes the next
`menuVersion` (same `serviceId`/`menuId`). The module archives the outgoing items in
`menu_item_revision`, and every `analysis_attempt` keeps the `menuVersion` it froze, so old captures
still resolve their foods. `upsert_menu` refuses a version older than the stored one. Demo portions are
saved for the current version only.

### Live E2E (about 3 Gemini calls and 2+ SAM calls per photo; capped at 4 photos)

```bash
cd tests
SCRAP_E2E=1 SCRAP_E2E_START=2026-10-03 SCRAP_E2E_END=2026-10-04 \
  node --env-file=/Users/mike/mhacks/.env --test e2e/scrap-live.test.mjs
# choose photos:   SCRAP_E2E_PHOTO_DIR=<folder with the JPEGs> SCRAP_E2E_PHOTOS=3
# neighbour plate: SCRAP_E2E_EXPECT_NEIGHBOR=1 (one photo must show a second plate)
# re-check only:   SCRAP_E2E_EVENT_IDS=cap_…,cap_…   (no new captures, no Gemini/SAM spend)
```

From the main checkout, `npm run test:e2e:scrap` loads `../.env` on its own. Pass test files to
`node --test`, never the `tests/e2e` folder.

### IT_4: production mode, ingest token, calibration

The local production stack (`deploy/local.sh up`, [deploy.md](deploy.md)) needs `SCRAP_INGEST_TOKEN`
for every mutation. The bridge, `npm run calibrate`, `simulate-camera`, `replay`, `live_camera_test.py`
and `demo.py` read it from the environment, then `.env`, then `deploy/.run/local-secrets.env` (another
variable name: `--token-env NAME`). They send `Authorization: Bearer …` and never print it. A 401 means the
token is missing or different from the backend's. Point them at another backend with
`SCRAP_API_URL=https://…` (`API_URL` still works).

```bash
# Calibrate once per camera position (docs/calibration.md)
python3 capture/uno-q/laptop_capture.py --target arduino@35.1.88.76 --identity ~/.ssh/scrap_unoq --calibrate
cd capture && npm run calibrate -- --known-area-cm2 46.21 --reference-label "credit card"
#   no card / no board:  npm run simulate-camera -- --calibrate        (SYNTHETIC fixture)
python3 demo.py --only calibration          # k, camera height, flags
python3 demo.py --only deploy               # SCRAP_PROD_URL: /api/health, /api/ready, dashboard HTML

# Live E2E for calibration → calibrated area → totals (~3 Gemini calls + 1 calibration)
cd tests && SCRAP_E2E=1 npm run test:e2e:calibration
```

The calibration E2E copies the source service's menu to the test hall `hall-e2e-cal`, calibrates that
hall, and restores its previous `activeCalibrationId` when it finishes, so hall-main is never touched.
If a run on hall-main (`SCRAP_E2E_CAL_HALL=source`) or `demo.py --simulate` is interrupted, reset with
`PUT /api/settings/measurement {"hallId":"hall-main","activeCalibrationId":null}` using the token.

The board script must be the current one for the focus lock:
`scp capture/uno-q/uno_q_camera.py arduino@BOARD:scrap-camera/` (ARDUINO.md). An older board script still
captures; `laptop_capture.py` then prints `Focus: unknown`.

### Real camera live test

```bash
python3 capture/scripts/live_camera_test.py --target arduino@35.1.88.76 --identity ~/.ssh/scrap_unoq \
  --service svc_hall-main_2026-10-04_dinner --spacetime-db scrap
```

It writes everything (frames and bridge state) into a fresh `images/camera-test/<UTC time>/`, so the
real inbox and `capture/.inbox-*.json` are untouched. See [BRIDGE.md](../BRIDGE.md) §6.

## Demo data is never wiped

Don't reset `scrap` or `scrap-bigplan` (`--delete-data`, `spacetime delete`, clearing tables). The
seed is idempotent and replays are deduplicated by eventId, so rerunning them is the recovery path. For
throwaway experiments, publish the module to a new local database name and delete only that one.

## Recover

| Symptom | Check | Action |
| --- | --- | --- |
| Backend 500 `SpacetimeDB … failed` | `spacetime start` running? `SPACETIMEDB_URI`/`SPACETIMEDB_TOKEN` in `.env` | Start it; re-run README setup step 3 if the database is missing |
| `spacetime` command hits maincloud | Missing `--server local` | Always pass `--server local` (the CLI's default server is maincloud) |
| Seed fails `… is older than the stored version` | Someone POSTed a menu with an old `menuVersion` | Use `npm run seed` / `POST /api/menus/upload`, which plan the revision |
| Menu missing | Hall/date/service filter | Re-upload menu; confirm `MENU_NOT_FOUND` is gone |
| Bridge prints `Service … does not exist` | `GET /api/services` on the backend you target | `cd backend && npm run seed -- --live-dinner`; check `SPACETIMEDB_MODULE=scrap` |
| Capture stuck `pending` | Object upload state | Re-run finalize; look for `orphaned` objects |
| `502 STORAGE_UNAVAILABLE` | R2 credentials/bucket in `.env`, Cloudflare status | Fix `R2_*` / `OBJECT_STORAGE_CONTAINER`; retry |
| R2 PUT returns 403 `SignatureDoesNotMatch` | PUT headers | Send exactly the returned `uploadHeaders` and the declared byte count |
| Analysis `failed` | ApiError code | Retry if `retryable` (rerun the bridge; same eventIds); otherwise needs_review |
| Every capture fails with `GEMINI_BILLING` (HTTP 402), and the recommendation stays `fallback` | `details.providerStatus` 402 / "prepayment credits are depleted" | Gemini billing is empty: top up the project in AI Studio. Rerun the bridge afterwards; it retries under the same eventIds |
| `GEMINI_AUTH_FAILED` | Key in `.env` | Fix `GEMINI_API_KEY`; `cd vision && npm run smoke` |
| `GEMINI_MODEL_NOT_FOUND` | `GEMINI_MODEL` | Use a model the key can access |
| Plate flagged `target_dish_unavailable` | Overlay, SAM worker log | Gemini/SAM could not find the scanned dish, so nothing was clipped: neighbouring food may be counted. Re-aim the camera so one plate is centered |
| Plate flagged `neighbor_food_excluded` | Overlay (excluded food drawn separately) | Expected when a second plate is in frame: its food was dropped. It is counted when it is the centered plate in its own capture |
| Tip says "rule-based (AI unavailable)" | Gemini error/truncation | Reload; fallback tips are retried with Gemini |
| Broken image in UI | Read URL expiry | Renew the temporary read URL; do not rewrite objectKey |
| Attendance changes on refresh | Seed / persistence | Attendance must be persisted once per service |
| Backend vanished from :8787 | `lsof -nP -iTCP:8787 -sTCP:LISTEN` | Another agent's `pkill -f dist/backend/src/server.js` matches every backend; restart it (command above). Bridge reruns are idempotent by eventId |
| Impact dashboard empty for a fresh capture | Window | `start`/`end` are **service dates**, not the capture's UTC time |
| Simulated dishes show `replay` | Expected | `simulate-camera` photos are labeled `replay`; only the Uno Q yields `camera` |

## Do not

- Commit `.env` or real API keys; print or log signed URLs
- Store image bytes in SpacetimeDB
- Wipe or clear `scrap` / `scrap-bigplan`
- Present pixels as grams, kg CO2e, litres or dollars. v2 has no plate calibration. Relative impact
  points are unitless and only compare foods with each other; nutrition points are separate and never in
  the impact score
- Present simulated attendance as swipe data, or demo portions as real serving counts

## Re-run failed analyses (e.g. Gemini credits ran out)

Captures whose analysis failed keep their photo in R2 and their row in `scrap`. After fixing the cause
(top up Gemini billing, restart the SAM worker), re-run them. Each one gets a new analysis attempt on the
**same** capture, so nothing is double-counted:

```bash
cd backend && node scripts/retry-failed.mjs --start 2026-10-04 --end 2026-10-04 --dry-run   # list
cd backend && node scripts/retry-failed.mjs --start 2026-10-04 --end 2026-10-04             # retry
```
