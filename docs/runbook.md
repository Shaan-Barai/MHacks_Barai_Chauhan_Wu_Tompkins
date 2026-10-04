# Minimal runbook

The demo database is **`scrap`** (BIG-PLAN v2). Pixels wasted is the only measurement; impact is shown
as unitless **relative impact points**; each capture counts only the **target dish** (the plate being
scanned). `scrap-bigplan` is retired: don't point new runs at it.

## Start (fixture-only machine)

```bash
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
