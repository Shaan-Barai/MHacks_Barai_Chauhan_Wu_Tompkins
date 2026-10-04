# ScrapSaver: dining hall food-waste tracker (MHacks prototype)

ScrapSaver helps dining hall managers see what food comes back uneaten. The agreed
analysis flow is **Gemini food classification → segmentation mask → pixel
counting in code**. The primary metric is **Pixels wasted**: foreground pixels
in validated masks of visible leftover food. A beginner-friendly dashboard
shows totals, trends, the most-wasted items, and AI-powered suggestions.

**Waste impact (BIG-PLAN, 2026-10-03):** each photo's plate is measured
(26.7 cm plate → cm² per pixel), so leftover pixels become **estimated grams**
via per-food weight constants, then greenhouse gases (kg CO2e), freshwater
(m³) and a **Waste impact score** = `0.19·C + 1.50·W` dollars per kg
([menu_waste_factors_README.md](menu_waste_factors_README.md)). Nutrition lost
is reported separately and is not part of the score. **Waste per portion** =
estimated grams ÷ portions served ranks the foods to target; portion counts
are currently **demo** numbers. Everything derived from pixels is labeled an
estimate. The dashboard shows total waste, CO2e, water, impact, foods to
target, most wasted, nutrition lost, a plate gallery with the original and
segmented (AI outline) images, and a grounded AI recommendation.

**End-to-end path:** Uno Q camera → laptop inbox → bridge (one capture per
dish) → R2 upload → SpacetimeDB records → Gemini classify + boxes → SAM 2.1
masks → counted pixels, plate calibration, overlay JPEG (stored in R2) →
dashboard. See [BIG-PLAN.md](BIG-PLAN.md), [BRIDGE.md](BRIDGE.md), and
[EXPLAIN.md](EXPLAIN.md) for a plain-language tour of the database.

**Portions served:** enter actual per-food counts under **Portions served**,
or upload a CSV for a selected meal. Counts persist by service and menu
version; re-imports replace counts. See [the portion-count guide](docs/portions-served.md).

Attendance is **simulated**. Pixels are measured; grams, CO2e, water and $
are estimates from a plate-size calibration and typical weights, not a scale.

## Documents

- [`BIG-PLAN.md`](BIG-PLAN.md) — the camera → impact → dashboard plan and its tracker.
- [`EXPLAIN.md`](EXPLAIN.md) — the whole database (SpacetimeDB + R2) in plain language.
- [`menu_waste_factors_README.md`](menu_waste_factors_README.md) — the waste
  impact formula and per-food factors (nutrition in `menu_nutrition_factors.csv`).
- [`AGENTS.md`](AGENTS.md) — the working plan: agent roles, ownership, rules,
  measurement formulas, and completion checks.
- [`UI.md`](UI.md) — dashboard spec (layout, palette, copy).
- [`MVP_AI.md`](MVP_AI.md) — researched Meta SAM segmentation plan and
  bounding-box model options; implementation and food-image evaluation are pending.
- [`AI.md`](AI.md) — current AI flow and future DepthAnythingV2 volume plan;
  depth/volume work is deferred.
- [`contracts/`](contracts/) — shared entity types, error format, sample
  records, and [recorded decisions](contracts/decisions.md).

## Repository layout

| Directory | Owner | Contents |
| --- | --- | --- |
| `contracts/` | Agent 1 | Shared types, samples, decisions |
| `data/`, `db/` | Agent 2 | Menu parsing/validation, SpacetimeDB schema, seeds |
| `capture/` | Agent 3 | Camera/replay capture adapter |
| `vision/` | Agent 4 | Gemini classification, segmentation, mask pixel counting |
| `backend/` | Agent 5 | API, object-storage adapter, orchestration |
| `analytics/` | Agent 6 | Aggregates, simulated attendance, suggestions |
| `frontend/` | Agent 7 | ScrapSaver dashboard (React + Tailwind) |
| `docs/`, `tests/` | Agent 8 | Demo docs, fixtures, integration/e2e tests |

## Setup

Prerequisites: Node.js 20.12+ and the SpacetimeDB CLI 2.10.x
(`curl -sSf https://install.spacetimedb.com | sh`).

```bash
# 1. Secrets (server-side only; .env is gitignored — never commit it)
cp .env.example .env            # then set GEMINI_API_KEY and the R2_* bucket credentials

# 2. Local SpacetimeDB (keep running in its own terminal)
spacetime start

# 3. One-time: a local identity that owns the database, saved to .env
echo "SPACETIMEDB_TOKEN=$(curl -s -X POST http://127.0.0.1:3000/v1/identity | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')" >> .env
spacetime login --token "$(grep ^SPACETIMEDB_TOKEN= .env | cut -d= -f2)"
cd db/spacetimedb && npm ci && spacetime publish --module-path . --server local --yes scrap-bigplan && cd ../..
#    (set SPACETIMEDB_MODULE=scrap-bigplan in .env, or prefix backend commands with it)

# 4. SAM 2.1 segmentation worker (Python venv with Meta's sam2; see vision/sam/README.md)
.venv/bin/python vision/sam/worker.py      # own terminal; http://127.0.0.1:8790

# 5. Backend API (builds data/vision/analytics first) — http://localhost:8787
cd backend && npm ci && SPACETIMEDB_MODULE=scrap-bigplan npm start   # own terminal

# 6. Demo data: seed menus (incl. the 23-food dinner) + demo portions served
cd backend && SPACETIMEDB_MODULE=scrap-bigplan npm run seed

# 7a. Real camera: Uno Q → laptop inbox, then the bridge (BRIDGE.md, ARDUINO.md)
python3 capture/uno-q/laptop_capture.py --target arduino@YOUR_BOARD_IP --auto
cd capture && npm ci && npm run ingest-inbox -- --service svc_hall-main_2026-10-03_dinner --watch
# 7b. No board: simulate the camera with the test2/ photos (one dish per photo)
cd capture && npm run simulate-camera -- --service svc_hall-main_2026-10-03_dinner

# 8. Dashboard — http://localhost:5173 (proxies /api to the backend)
cd frontend && npm ci && npm run dev
```

Images are stored in a private **Cloudflare R2** bucket: create the bucket and
an R2 API token with Object Read & Write on it, then fill in
`OBJECT_STORAGE_CONTAINER` and `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
`R2_SECRET_ACCESS_KEY`. Set `OBJECT_STORAGE_PROVIDER=local-dev` to run without
a Cloudflare account (files under `backend/.local-storage/`).

Always pass `--server local` to `spacetime` commands: the CLI's default
server is the hosted maincloud. Without `GEMINI_API_KEY` the backend uses a
deterministic mock analyzer; without `SPACETIMEDB_URI` it uses an in-memory
store. `VITE_USE_MOCK=1 npm run dev` runs the dashboard on demo data alone.

## Verify

```bash
cd tests && npm test                          # fixture + formula checks
(cd <module> && npm test)                     # data capture vision analytics backend frontend
cd vision && npm run smoke                    # live Gemini smoke test (uses .env key)
cd tests && SCRAP_E2E=1 npm run test:e2e      # live API flow against the running stack
cd tests && SCRAP_E2E=1 SPACETIMEDB_MODULE=scrap-bigplan npm run test:e2e:bigplan   # camera sim → R2 → SpacetimeDB → Gemini+SAM → dashboard API
python3 capture/scripts/live_camera_test.py --help   # real Uno Q hardware check
```

### API additions (BIG-PLAN)

`start`/`end` are inclusive local service dates (`YYYY-MM-DD`); pass `hallId`.

| Endpoint | Returns |
| --- | --- |
| `GET /api/dashboard/impact?start&end&hallId` | totals (pixels, est. grams, CO2e, water, $; nutrition separate), foods to target (per portion), most wasted, coverage |
| `GET /api/captures?start&end&hallId[&limit]` | recent plates with state, pixels and grams per food |
| `GET /api/captures/:eventId/images` | short-lived URLs for the original photo, segmented overlay, and per-food masks |
| `GET /api/recommendation?start&end&hallId` | AI recommendation (`gemini`) or labeled rule-based `fallback`, with cited metrics |
| `GET /api/dashboard/daily` | per-day Pixels wasted plus estimated `grams` (null when unavailable) |

See [`docs/`](docs/) for the [demo walkthrough](docs/demo-walkthrough.md),
[runbook](docs/runbook.md), [known limitations](docs/known-limitations.md),
and the latest [verification report](docs/verification-report.md).
