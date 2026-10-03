# tests/integration

Owner: Agent 8 — cross-system checks against `contracts/` and `tests/fixtures/`.

## What runs today

Offline **fixture** checks (Node 20+ `node:test`):

- Contract sample presence and scenario manifest integrity
- AGENTS.md §7 measurement/aggregate arithmetic (hand-calculated)
- Exclusion rules (unknown, missing baseline, above-baseline, failed analysis)
- Hall/date/service filter isolation
- Capture-event idempotency expectations
- Simulated attendance stability expectations
- Storage reference-only rules and upload/finalization failure cases
- Dashboard label requirements

These tests **do not** call Gemini, a camera, SpacetimeDB, or a live HTTP API. Passing them means the fixtures and formulas agree — not that production modules are wired end-to-end.

## Run

```bash
cd tests
npm test
```

## Live API / e2e

When Agents 5 and 7 expose a runnable stack, extend `../e2e/` with HTTP checks. Until then, e2e tests stay skipped and are documented in `docs/`.
