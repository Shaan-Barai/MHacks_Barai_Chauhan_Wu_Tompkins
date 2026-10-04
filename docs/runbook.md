# Minimal runbook

## Start (fixture-only machine)

```bash
cd tests && npm test
```

Expected: all integration tests pass; e2e live suite skipped unless `SCRAP_E2E=1`.

## Start (full prototype)

Follow the root [README](../README.md#setup). In short, four terminals:

1. `spacetime start`
2. `cd backend && npm start` — logs `persistence: SpacetimeDB scrap, vision: live Gemini`
3. `cd frontend && npm run dev` → http://localhost:5173
4. One-off: `cd backend && npm run seed`, then `cd capture && npm run replay`

Smoke: the dashboard's "Today" preset shows waste for 2026-10-03 and the
Dinner tab shows a Gemini tip.

## Start (BIG-PLAN demo: R2 + `scrap-bigplan`)

Five terminals. The real secrets live in `/Users/mike/mhacks/.env` (gitignored). Variables set in the
shell override `--env-file`.

```bash
# 1. SpacetimeDB (already running locally on :3000 in the dev setup)
spacetime start
#    once, or after a schema change; never --delete-data on `scrap`
cd db/spacetimedb && npm ci && spacetime publish --module-path . --server local --yes scrap-bigplan

# 2. SAM 2.1 worker on :8790 (from the repo root; run only one)
.venv/bin/python vision/sam/worker.py

# 3. Backend on :8787. npm start loads <checkout>/.env; in a worktree, pass the real file instead:
cd backend && npm ci && npm run build
SPACETIMEDB_MODULE=scrap-bigplan PORT=8787 node --env-file=/Users/mike/mhacks/.env dist/backend/src/server.js
#    expect: "storage: r2, persistence: SpacetimeDB scrap-bigplan, vision: Gemini classification + SAM 2.1 masks"
#    once: cd backend && npm run seed   (menus incl. the 23-food dinner + demo portions; idempotent)

# 4. Frontend: http://localhost:5173 (proxies /api to :8787)
cd frontend && npm run dev

# 5. Capture: real board (BRIDGE.md) or the simulator
cd capture && npm run simulate-camera -- --count 3 --service svc_hall-main_2026-10-03_dinner --state-dir /tmp/scrap-demo-state
```

Smoke checks:
- `curl -s localhost:8787/api/health` should return `{"ok":true,"provider":"r2"}`.
- `curl -s 127.0.0.1:8790/health` should show `sam2.1-hiera-small`.
- `curl -s "localhost:8787/api/dashboard/impact?start=2026-10-03&end=2026-10-03&hallId=hall-main"` should
  return totals.

Always pass `hallId=hall-main`. `scrap-bigplan` also contains test halls (for example `hall-tmuta9xkt`,
`hall-e2e-*`).

### Live E2E (about 3 Gemini calls and 2+ SAM calls per photo; capped at 4 photos)

```bash
cd tests
SCRAP_E2E=1 SPACETIMEDB_MODULE=scrap-bigplan SCRAP_E2E_START=2026-10-03 SCRAP_E2E_END=2026-10-03 \
  node --env-file=/Users/mike/mhacks/.env --test e2e/bigplan-live.test.mjs
# choose photos:   SCRAP_E2E_PHOTO_DIR=<folder with the JPEGs> SCRAP_E2E_PHOTOS=3
# re-check only:   SCRAP_E2E_EVENT_IDS=cap_…,cap_…   (no new captures, no Gemini/SAM spend)
```

From the main checkout, `npm run test:e2e:bigplan` loads `../.env` on its own. Pass test files to
`node --test`, never the `tests/e2e` folder.

## Reset the demo data

```bash
spacetime publish --module-path db/spacetimedb --server local --delete-data=always --yes scrap
rm -f capture/.replay-state.json      # replay identities belong to the old database
rm -rf backend/.local-storage          # local-dev images (R2 objects can stay; they're unreferenced)
# restart the backend, then seed + replay again
```

## Recover

| Symptom | Check | Action |
| --- | --- | --- |
| Backend 500 `SpacetimeDB … failed` | `spacetime start` running? `SPACETIMEDB_URI`/`SPACETIMEDB_TOKEN` in `.env` | Start it; re-run README setup step 3 if the database is missing |
| `spacetime` command hits maincloud | Missing `--server local` | Always pass `--server local` |
| Menu missing | Hall/date/service filter | Re-upload menu; confirm `MENU_NOT_FOUND` is gone |
| Capture stuck `pending` | Object upload state | Re-run finalize; look for `orphaned` objects |
| `502 STORAGE_UNAVAILABLE` | R2 credentials/bucket in `.env`, Cloudflare status | Fix `R2_*` / `OBJECT_STORAGE_CONTAINER`; retry |
| R2 PUT returns 403 `SignatureDoesNotMatch` | PUT headers | Send exactly the returned `uploadHeaders` and the declared byte count |
| Analysis `failed` | ApiError code | Retry if `retryable` (re-run replay); otherwise needs_review |
| Every capture fails with `GEMINI_BAD_REQUEST`, and the recommendation stays `fallback` | `details.providerStatus` 402 / "prepayment credits are depleted" | Gemini billing is empty: top up the project in AI Studio. Rerun the bridge afterwards; it retries under the same eventIds |
| `GEMINI_AUTH_FAILED` | Key in `.env` | Fix `GEMINI_API_KEY`; `cd vision && npm run smoke` |
| `GEMINI_MODEL_NOT_FOUND` | `GEMINI_MODEL` | Use a model the key can access (`gemini-3.8-flash`) |
| Tip says "rule-based (AI unavailable)" | Gemini error/truncation | Reload the meal; fallback tips are retried with Gemini |
| Meal shows "every food estimate was left out" | Exclusion reasons in `/api/dashboard/meal` | Usually `above_baseline`: the reference area is smaller than the plate's estimate — review baselines |
| Replay adds duplicate dishes | `.replay-state.json` deleted without resetting the DB | Reset the demo data (above) |
| Broken image in UI | Read URL expiry | Renew temporary read URL; do not rewrite objectKey |
| Wild waste % | Geometry / baseline | Confirm `topdown-normalized-v1` and baseline > 0 |
| Attendance changes on refresh | Seed / persistence | Attendance must be persisted once per service |
| Backend vanished from :8787 | `lsof -nP -iTCP:8787 -sTCP:LISTEN` | Another agent's `pkill -f dist/backend/src/server.js` matches every backend; restart it (command above). Bridge reruns are idempotent by eventId |
| Bridge prints `Service … does not exist` | `GET /api/services` on the backend you target | `cd backend && npm run seed`; check `SPACETIMEDB_MODULE` |
| Impact dashboard empty for a fresh capture | Window | `start`/`end` are **service dates** (the dinner is 2026-10-03), not the capture's UTC time |
| Plate shows no overlay / `calibration_default` | `attempt_calibration` row, SAM worker log | SAM plate fit failed; grams use `PLATE_DIAMETER_PX` and are flagged |
| Simulated dishes show `replay` | Expected | `simulate-camera` photos are labeled `replay`; only the Uno Q yields `camera` |

## Do not

- Commit `.env` or real API keys
- Store image bytes in SpacetimeDB
- Present grams/CO2e/water/$ without the "estimate" label (they come from the plate calibration and
  factor tables, not a scale), or add nutrition into the $ score
- Present simulated attendance as swipe data
