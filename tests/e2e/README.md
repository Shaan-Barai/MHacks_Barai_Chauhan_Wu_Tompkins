# tests/e2e

Owner: Agent 8 — end-to-end demo flow against a running stack.

## Status

Live HTTP/UI e2e is **not enabled** yet (`SCRAP_E2E` unset). The placeholder
test suite loads in CI and stays skipped so we do not claim a live path from
fixtures alone.

## Intended flow (when enabled)

1. Start SpacetimeDB + backend + local-dev object storage + frontend.
2. Upload the vertical-slice menu and reference portion.
3. Replay `cap_01J9ABCD` through capture → storage finalize → analysis.
4. Confirm dashboard aggregates match `fixtures/scenarios/vertical-slice.json`.
5. Exercise failure paths from `upload-failures.json` and `invalid-analysis.json`.

## Run

```bash
cd tests
npm test                 # fixture + placeholder
SCRAP_E2E=1 npm run test:e2e   # only after live stack is documented
```
