# Environment setup (Agent 8)

## Prerequisites

- Node.js **20.12+** (22+ fine)
- Git
- SpacetimeDB CLI **2.10.x** (`curl -sSf https://install.spacetimedb.com | sh`)
- A Gemini API key for live analysis (optional: without it the backend uses a mock analyzer) — see [`.env.example`](../.env.example)

## Fixture verification (available now)

No cloud accounts required:

```bash
cd tests
npm test
```

This runs offline checks under `tests/integration/` and the skipped e2e placeholder. It validates AGENTS.md §7 formulas and scenario expectations against JSON fixtures.

## Full demo stack

| Piece | Choice |
| --- | --- |
| Frontend | Vite + React 18 + TypeScript + Tailwind (`frontend/`, dev proxy → backend) |
| Backend | Node 20 + TypeScript + Express (`backend/`, port 8787) |
| DB | SpacetimeDB 2.10.2 standalone, TypeScript module `db/spacetimedb`, database `scrap` (v2; `scrap-bigplan` is retired) |
| Images | Cloudflare R2 bucket (presigned URLs); `local-dev` filesystem adapter offline |
| Vision | Gemini (`GEMINI_MODEL`) via server-side `@google/genai`: classification, two localization passes, target dish; SAM 2.1 worker (`SAM_WORKER_URL`, :8790) for masks |
| Measurement | Pixels wasted (stored); relative impact points derived by `analytics/` at read time; IT_4: estimated grams / kg CO2e / L water from an active camera calibration ([calibration.md](calibration.md)), Depth Anything V2 worker (`DEPTH_WORKER_URL`, :8791) optional and off by default |

1. Copy `.env.example` → `.env` (never commit `.env`) and set `GEMINI_API_KEY`.
2. Follow the root [README setup](../README.md#setup).
3. For R2 set `OBJECT_STORAGE_PROVIDER=r2`, the bucket in `OBJECT_STORAGE_CONTAINER`, and `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (an R2 API token with Object Read & Write on that bucket). Use `local-dev` to run without a Cloudflare account.
4. Keep `SPACETIMEDB_MODULE=scrap`. There is no `PLATE_DIAMETER_PX` in v2.
5. Seed once: `cd backend && npm run seed -- --live-dinner` (menus with revisions, demo portions, today's dinner).
6. Fixture/unit runs never need the key, SpacetimeDB, or network access.
7. Client side (bridge, `npm run calibrate`, `replay`, `simulate-camera`, `live_camera_test.py`, `demo.py`):
   `SCRAP_API_URL` (default `http://localhost:8787`; `API_URL` still works) and `SCRAP_INGEST_TOKEN`
   (needed when the backend runs in production mode; read from the environment, then `.env`, then
   `deploy/.run/local-secrets.env`; never printed). `SCRAP_PROD_URL` is the URL `demo.py --only deploy` checks.

## Hall defaults

- Timezone: `America/Detroit` (provisional)
- Simulated attendance range: 300–1,200 per service

## Verification modes

| Mode | Env / trigger | Claims |
| --- | --- | --- |
| Fixture | `npm test` in `tests/` | Formulas + fixtures agree |
| Live API e2e | `SCRAP_E2E=1` + running stack (`tests/e2e/scrap-live.test.mjs`) | HTTP path works |
| Live Gemini | documented smoke with key | Provider path works |
| Live camera | Uno Q + C920s, `capture/scripts/live_camera_test.py` | Capture path works |
| Live calibration e2e | `SCRAP_E2E=1 npm run test:e2e:calibration` (`tests/e2e/calibration-live.test.mjs`) | Calibration → area/volume → estimated totals path works (synthetic card; not physical accuracy) |

Never describe a fixture run as a live Gemini or camera test.
