# Environment setup (Agent 8)

## Prerequisites

- Node.js **20+** (fixture/integration runner)
- Git
- (Later) SpacetimeDB CLI, Gemini API key, and the chosen object-storage credentials — see [`.env.example`](../.env.example)

## Fixture verification (available now)

No cloud accounts required:

```bash
cd tests
npm test
```

This runs offline checks under `tests/integration/` and the skipped e2e placeholder. It validates AGENTS.md §7 formulas and scenario expectations against JSON fixtures.

## Full demo stack (when modules land)

Provisional stack from [`contracts/decisions.md`](../contracts/decisions.md):

| Piece | Provisional choice |
| --- | --- |
| Frontend | Vite + React 18 + TypeScript + Tailwind |
| Backend | Node 20 + TypeScript + Express |
| DB | SpacetimeDB (module language TBD) |
| Images | `local-dev` filesystem adapter until a cloud provider is chosen |
| Vision | Gemini `gemini-2.5-flash` via server-side `@google/genai` |

1. Copy `.env.example` → `.env` (never commit `.env`).
2. Follow root README start commands once Agent 1 publishes them.
3. Confirm `OBJECT_STORAGE_PROVIDER=local-dev` for offline demos.
4. Set `GEMINI_API_KEY` only for live vision smoke tests; fixture runs must not require it.

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
