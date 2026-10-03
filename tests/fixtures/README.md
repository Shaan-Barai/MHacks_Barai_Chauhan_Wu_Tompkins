# tests/fixtures

Owner: Agent 8 — shared contract fixtures and scenario expectations.

## Layout

| Path | Purpose |
| --- | --- |
| `manifest.json` | Index of scenarios, labels, and which AGENTS.md checks they cover |
| `scenarios/*.json` | Self-contained input → expected-output cases for cross-system checks |

Canonical sample entity shapes live in [`contracts/samples.json`](../../contracts/samples.json). Scenarios here compose those shapes into edge cases; they do not redefine types.

## Labels

Every scenario marks its verification mode:

- `fixture` — pure offline data + formula checks (runs in CI today)
- `live_api` — requires a running backend (skipped until Agent 5 lands)
- `live_gemini` / `live_camera` — require credentials or hardware (never claimed by fixture runs)

## Adding a scenario

1. Copy an existing scenario file.
2. Keep `schemaVersion: 1`.
3. List every quality/demo label the dashboard must show (`simulated`, `ai_estimate`, etc.).
4. Put hand-calculated expected aggregates under `expected.aggregates` when applicable.
5. Register the file in `manifest.json`.
