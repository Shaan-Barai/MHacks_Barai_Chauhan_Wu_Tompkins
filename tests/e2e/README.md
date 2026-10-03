# tests/e2e

Owner: Agent 8 — end-to-end demo flow against a running stack.

## Status

Live HTTP e2e is implemented (`demo-flow.test.mjs`) and **skipped unless
`SCRAP_E2E=1`**, so CI never claims a live path from fixtures alone. Last live
run: 2026-10-03, 5/5 pass (SpacetimeDB + live Gemini).

## Flow

Against a running backend (`API_URL`, default `http://localhost:8787`), using a
fresh `hall-e2e-<timestamp>` so demo numbers are untouched:

1. Upload a dinner menu via `POST /api/menus/upload`; identical re-upload → `unchanged`.
2. Store reference portions.
3. Authorize → (finalize-before-upload refused 409) → PUT bytes → finalize → `POST /api/captures`.
4. Analysis is not `failed`; measurements are `ai_estimate` and only use menu item IDs.
5. Re-submitting the capture is deduplicated; one observation exists.
6. Dashboard meal detail: attendance `simulated` and stable across reads; the
   suggestion's `topItemId` matches the top item (or no tip without counted items).

Restart persistence is checked by hand (docs/runbook.md).

## Run

```bash
cd tests
npm test                          # fixture + placeholder
SCRAP_E2E=1 npm run test:e2e      # needs the running stack (README setup)
```
