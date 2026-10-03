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
| DB | SpacetimeDB 2.10.2 standalone, TypeScript module `db/spacetimedb`, database `scrap` |
| Images | Cloudflare R2 bucket (presigned URLs); `local-dev` filesystem adapter offline |
| Vision | Gemini `gemini-3.8-flash` via server-side `@google/genai` |

1. Copy `.env.example` → `.env` (never commit `.env`) and set `GEMINI_API_KEY`.
2. Follow the root [README setup](../README.md#setup).
3. For R2 set `OBJECT_STORAGE_PROVIDER=r2`, the bucket in `OBJECT_STORAGE_CONTAINER`, and `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (an R2 API token with Object Read & Write on that bucket). Use `local-dev` to run without a Cloudflare account.
4. Fixture/unit runs never need the key, SpacetimeDB, or network access.

## Hall defaults

- Timezone: `America/Detroit` (provisional)
- Simulated attendance range: 300–1,200 per service

## Verification modes

| Mode | Env / trigger | Claims |
| --- | --- | --- |
| Fixture | `npm test` in `tests/` | Formulas + fixtures agree |
| Live API e2e | `SCRAP_E2E=1` + running stack | HTTP path works |
| Live Gemini | documented smoke with key | Provider path works |
| Live camera | hardware present | Capture path works |

Never describe a fixture run as a live Gemini or camera test.
