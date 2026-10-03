# Scrap — dining hall food-waste tracker (MHacks prototype)

Scrap helps dining hall managers see what food comes back uneaten. The agreed
analysis flow is **Gemini food classification → segmentation mask → pixel
counting in code**. The primary metric is **Pixels wasted**: foreground pixels
in validated masks of visible leftover food. A beginner-friendly dashboard
shows totals, trends, the most-wasted items, and AI-powered suggestions.

**Portions served:** enter actual per-food counts under **Portions served**,
or download and upload a CSV template for a selected meal. The recommendation
benchmark is **Pixels wasted per portion** = validated observed item pixels ÷
that item's portions served. Counts persist by service and menu version;
re-imports replace counts. See [the portion-count guide](docs/portions-served.md).
Legacy area estimates cannot supply this benchmark: it remains unavailable
until the planned mask stage produces validated counts.

Uploaded/replayed images are the current input; camera placement and conveyor
integration are deferred. Mask counts use a shared normalized image geometry,
count overlapping pixels once, and preserve AI segmentation quality metadata.
Attendance is **simulated**. Pixels are not physical mass or servings.

This is the updated product context. Existing scalar-area and count/percentage
analysis paths still require migration; this context update does not implement
the new pipeline. See [the measurement contract](contracts/measurement.md).

## Documents

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
| `frontend/` | Agent 7 | Scrap dashboard (React + Tailwind) |
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

# 4. Backend API (builds data/vision/analytics first) — http://localhost:8787
cd backend && npm ci && npm start          # own terminal

# 5. Demo data: seed menus + reference portions, then replay labeled captures
cd backend && npm run seed
cd capture && npm ci && npm run replay     # live Gemini analysis per plate

# 6. Dashboard — http://localhost:5173 (proxies /api to the backend)
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
```

See [`docs/`](docs/) for the [demo walkthrough](docs/demo-walkthrough.md),
[runbook](docs/runbook.md), [known limitations](docs/known-limitations.md),
and the latest [verification report](docs/verification-report.md).
