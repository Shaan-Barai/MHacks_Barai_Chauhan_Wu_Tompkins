# ScrapSaver: dining hall food-waste tracker (MHacks prototype)

ScrapSaver helps dining hall managers see what food comes back uneaten. The agreed
analysis flow is **Gemini food classification → segmentation mask → pixel
counting in code**. The primary metric is **Pixels wasted**: foreground pixels
in validated masks of visible leftover food. A beginner-friendly dashboard
shows totals, trends, the most-wasted items, and AI-powered suggestions.

**Waste metrics (BIG-PLAN v2, 2026-10-04):** everything is in **pixels**:
total Pixels wasted, **waste per portion** (pixels ÷ portions served, the
ranking for foods to target) and most wasted. **Relative impact points** weight
pixels by each food's typical density and its greenhouse-gas (C) and freshwater
(W) footprint: `points = pixels/1000 × weight_g_per_cm2 × (0.19·C + 1.50·W)`
([menu_waste_factors_README.md](menu_waste_factors_README.md)). They are
unitless and only compare foods with each other. They are not kg, litres or dollars. Nutrition
points are reported separately and are not in the score. Each photo counts only
the dish being scanned: food on neighboring plates is left out (target-dish
counting). Portion counts are currently **demo** numbers. The dashboard shows
total waste, relative impact, foods to target, most wasted, nutrition points,
a plate gallery with the original and segmented (AI outline) images, and a
grounded AI recommendation.

**End-to-end path:** Uno Q camera → laptop inbox → bridge (one capture per
dish) → R2 upload → SpacetimeDB records → Gemini classify + boxes → SAM 2.1
masks → counted pixels on the target dish, overlay JPEG (stored in R2) →
dashboard. See [BIG-PLAN.md](BIG-PLAN.md), [BRIDGE.md](BRIDGE.md), and
[EXPLAIN.md](EXPLAIN.md) for a plain-language tour of the database.

**Portions served:** enter actual per-food counts under **Portions served**,
or upload a CSV for a selected meal. Counts persist by service and menu
version; re-imports replace counts. See [the portion-count guide](docs/portions-served.md).

Attendance is **simulated**. Pixels are counted from AI masks of visible
leftovers; they are not a weight. Impact points are relative estimates.

## Calibrated area, CO2e and water (IT_4)

With an active **camera calibration**, each food also gets an **estimated**
area (cm²) and grams, plus kg CO2e and litres of water. These are shown next to
the food's label on the plate image and on the dashboard.

1. Lay a credit card (46.21 cm²) or any flat object of measured area where the
   plates go, with the camera locked in place.
2. Run `npm run calibrate -- --known-area-cm2 46.21` in `capture/`, or use
   Settings → Camera calibration.
3. Grams = area × the food's `weight_g_per_cm2`; kg CO2e and litres of water
   follow from grams. See [docs/calibration.md](docs/calibration.md) and
   [IT_4.md](IT_4.md).

Pixels wasted stays the primary measurement. Without a calibration, the
physical numbers are blank, never zero.

**Run the whole stack locally in production mode:**
`deploy/local.sh up | status | smoke | down` ([docs/deploy.md](docs/deploy.md)).

## Demo

One command runs and narrates the whole product: the Uno Q takes a photo, sends it to the laptop,
the bridge puts it in R2 and SpacetimeDB, Gemini + SAM 2.1 segment it, and the demo prints the
pixels, where every object is stored, total waste, waste per portion, most wasted, relative impact,
the AI recommendation, saves a "photo | AI segmentation" picture per plate, and opens the dashboard.

```bash
python3 demo.py                  # real camera (arduino@35.1.88.76), press Enter per plate
python3 demo.py --simulate       # no board: test2/ photos through the same path (labeled replay)
python3 demo.py --plates 3 --yes # three plates, no pauses
python3 demo.py --list           # the steps; --only/--skip pick some, --events cap_… re-shows captures
python3 demo.py --simulate --hall hall-test   # run on a test hall instead of hall-main
```

**Upload website:** `node upload_demo/server.mjs` → http://localhost:8795. Anyone can upload a food
photo and see the original, Gemini's boxes, SAM 2.1's masks, the final Pixels wasted, and each food's
carbon and water factors from the 27-food database ([`upload_demo/README.md`](upload_demo/README.md)).
[`demo_pictures/`](demo_pictures/README.md) shows every step for the halal chicken + rice bowl.

It needs the stack from [Setup](#setup) (it offers to start missing services) and writes its
photos and logs to `images/demo-runs/` (gitignored). **Adding a feature? Add a demo step**
(AGENTS.md §3 rule 13).

## Documents

- [`IT_4.md`](IT_4.md) — calibrated area, estimated CO2e/water, local production stack (plan + tracker; Depth Anything V2 was tried and removed).
- [`docs/deploy.md`](docs/deploy.md) — **deploy the website**: local production stack (`deploy/local.sh`) + Cloudflare Tunnel + custom domain, step by step.
- [`BIG-PLAN.md`](BIG-PLAN.md) — the camera → impact → dashboard plan and its tracker.
- [`EXPLAIN.md`](EXPLAIN.md) — the whole database (SpacetimeDB + R2) in plain language.
- [`menu_waste_factors_README.md`](menu_waste_factors_README.md) — the waste
  impact formula and per-food factors (nutrition in `menu_nutrition_factors.csv`).
- [`AGENTS.md`](AGENTS.md) — the working plan: agent roles, ownership, rules,
  measurement formulas, and completion checks.
- [`UI.md`](UI.md) — dashboard spec (layout, palette, copy).
- [`MVP_AI.md`](MVP_AI.md) — researched Meta SAM segmentation plan and
  bounding-box model options; implementation and food-image evaluation are pending.
- [`AI.md`](AI.md) — current AI flow. The DepthAnythingV2 volume idea was
  tried in IT_4 and removed (see `contracts/decisions.md`).
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
cd db/spacetimedb && npm ci && spacetime publish --module-path . --server local --yes scrap && cd ../..
#    (additive schema changes publish in place; never use --delete-data on scrap)

# 4. SAM 2.1 segmentation worker (Python venv with Meta's sam2; see vision/sam/README.md)
.venv/bin/python vision/sam/worker.py      # own terminal; http://127.0.0.1:8790

# 5. Backend API (builds data/vision/analytics first) — http://localhost:8787
cd backend && npm ci && SPACETIMEDB_MODULE=scrap npm start   # own terminal

# 6. Demo data: seed menus (incl. the 26-food dinner) + demo portions served
cd backend && SPACETIMEDB_MODULE=scrap npm run seed -- --live-dinner   # adds today's 26-food dinner

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

**One command runs everything** (see [docs/runbook.md](docs/runbook.md)):

```bash
./test-all.sh            # offline: every package, dashboard build, db typecheck, integration, Python, scripts
./test-all.sh --live     # + starts the local stack: smoke test, live E2E suites, demo.py --simulate (test halls only)
./test-all.sh --list     # suites; --only a,b / --skip a,b / --install / --fail-fast
```

Individual suites:

```bash
cd tests && npm test                          # fixture + formula checks
(cd <module> && npm test)                     # data capture vision analytics backend frontend
cd vision && npm run smoke                    # live Gemini smoke test (uses .env key)
cd tests && SCRAP_E2E=1 npm run test:e2e      # live API flow against the running stack
cd tests && SCRAP_E2E=1 npm run test:e2e:scrap   # camera sim → R2 → scrap → Gemini+SAM → dashboard API
python3 capture/scripts/live_camera_test.py --target arduino@<board-ip> --identity ~/.ssh/scrap_unoq --service svc_hall-main_<date>_dinner --spacetime-db scrap   # real Uno Q
```

### API additions (BIG-PLAN)

`start`/`end` are inclusive local service dates (`YYYY-MM-DD`); pass `hallId`.

| Endpoint | Returns |
| --- | --- |
| `GET /api/dashboard/impact?start&end&hallId` | totals (pixels, relative impact points; nutrition points separate), foods to target (pixels per portion), most wasted (pixels), coverage incl. neighbor-food exclusions |
| `GET /api/captures?start&end&hallId[&limit]` | recent plates with state and pixels per food |
| `GET /api/captures/:eventId/images` | short-lived URLs for the original photo, segmented overlay, and per-food masks |
| `GET /api/recommendation?start&end&hallId` | AI recommendation (`gemini`) or labeled rule-based `fallback`, with cited metrics |
| `GET /api/dashboard/daily` | per-day Pixels wasted |

See [`docs/`](docs/) for the [demo walkthrough](docs/demo-walkthrough.md),
[runbook](docs/runbook.md), [known limitations](docs/known-limitations.md),
and the latest [verification report](docs/verification-report.md).
