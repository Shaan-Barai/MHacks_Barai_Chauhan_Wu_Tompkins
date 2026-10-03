# Fixture provenance

Owner: Agent 8. Fixtures are **synthetic demo data** for verification. They are not measured dining-hall waste.

## Sources

| Asset | Origin |
| --- | --- |
| Entity shapes | [`contracts/types.ts`](../contracts/types.ts) |
| Canonical single-record samples | [`contracts/samples.json`](../contracts/samples.json) (Agent 1) |
| Scenario compositions | [`tests/fixtures/scenarios/`](../tests/fixtures/scenarios/) (Agent 8) |
| Measurement formulas | AGENTS.md §7 |

## Notable numbers

| Value | Meaning |
| --- | --- |
| `expectedAreaPx = 48000` | Hand-chosen uneaten reference area for scrambled eggs in normalized 1024² space |
| `remainingAreaPx = 14880` | Chosen so `14880/48000 = 0.31` exactly for a clean demo percent |
| Attendance `742` | Arbitrary value inside 300–1,200 with seed `demo-seed-1` |
| Hall `hall-main` / TZ `America/Detroit` | Provisional MHacks defaults from decisions.md |

## Modes

Every scenario sets `"mode": "fixture"` today. Live-provider fixtures will be added only when credentials/hardware exist, and will be labeled `live_gemini` / `live_camera` separately.

## Image bytes

Scenario JSON contains **metadata only**. Any replay image files added later must live under object storage (or a clearly labeled `tests/fixtures/images/` path that is never embedded into SpacetimeDB rows).
