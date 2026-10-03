# Verification report — Agent 8

**Date:** 2026-10-03 (Phase 3 vertical-slice integration)
**Scope:** fixture/unit suites, live Gemini smoke test, live API e2e against a
local stack (SpacetimeDB standalone 2.10.2 + backend + local-dev storage),
and a browser check of the dashboard.

## Summary

The vertical slice works end to end on one machine: menu upload → reference
portions → replay capture → object storage → live Gemini analysis →
SpacetimeDB persistence → analytics + simulated attendance → grounded
suggestion → dashboard. Camera hardware and a cloud object-storage provider
are **not** tested (neither exists yet).

## Results

| Check | Mode | Result |
| --- | --- | --- |
| `tests/` `npm test` | fixture | 18/18 pass |
| `data/` `npm test` | unit | 27/27 pass |
| `capture/` `npm test` | unit | 16/16 pass |
| `vision/` `npm test` | unit (mock transport) | 38/38 pass |
| `analytics/` `npm test` | unit | 28/28 pass |
| `backend/` `npm test` | unit/API (in-memory repo, mock analyzer, R2 adapter offline) | 19/19 pass (live SpacetimeDB test skipped without `SPACETIMEDB_URI`) |
| `frontend/` `npm test` | unit (vitest, mock + stubbed fetch) | 23/23 pass |
| `db/spacetimedb` typecheck + `spacetime publish --server local` | build/publish | pass |
| `vision/` `npm run smoke` | **live Gemini** (`gemini-3.8-flash`) | 9/9 checks pass |
| `tests/` `SCRAP_E2E=1 npm run test:e2e` | **live stack** (SpacetimeDB + live Gemini) | 5/5 pass |
| Demo replay (`capture/` `npm run replay`, 6 synthetic plates) | **live stack** | 6/6 ingested `succeeded`; re-run → "already ingested", still 6 capture events / 6 attempts in SpacetimeDB |
| Backend restart | live stack | menus, captures, attendance, insights all served unchanged after restart |
| `backend/` live SpacetimeDB test (`SPACETIMEDB_URI` set) | **live SpacetimeDB** | 11/11: every reducer + read round-trips; re-upload replaces items; capture idempotent; attempt + measurements atomic (a bad measurement stores nothing, attempts append-only); reducers reject zero baselines and non-simulated attendance; data visible to a fresh connection; image rows hold only key + metadata |
| SpacetimeDB server restart | **live SpacetimeDB** | row counts identical before/after (13 services, 9 captures, 21 measurements, 9 insights); dashboard served unchanged |
| `vision/` `npm run eval:leftovers` (countable/uncountable mode, blind) | **live Gemini** | label + countable decision 15/15; counts/percents in `vision/README.md` |
| Dashboard in Chrome (`npm run dev`) | live stack | cards, daily chart, per-meal panel with Gemini tip, simulated swipes badge, "left out of totals" coverage, Menus calendar from SpacetimeDB, typed menu save → row in SpacetimeDB; no console errors |

## Defects found and fixed during integration

| Defect | Owner | Fix |
| --- | --- | --- |
| `gemini-2.5-flash` unavailable to new keys (404) | Agent 4 / 1 | Default model → `gemini-3.8-flash` |
| Invalid API key (Google answers HTTP 400) mapped to `GEMINI_BAD_REQUEST` | Agent 4 | Normalized to `GEMINI_AUTH_FAILED` + test |
| Thinking tokens consumed `maxOutputTokens`, truncating suggestions | Agent 4 / 6 | Text requests use `thinkingBudget: 0`; `MAX_TOKENS` finish → `GEMINI_TRUNCATED_RESPONSE` (falls back, never shows half a sentence); suggestion budget 220 → 512 |
| One above-baseline item marked the whole plate `needs_review`, dropping its valid items | Agent 4 | Attempt stays `succeeded`; the flagged measurement alone is excluded |
| Replay CLI re-runs would mint new eventIds (duplicate dishes) | Agent 3 | Optional persisted identity registry (`.replay-state.json`) |
| Frontend tests failed on Node 22+ (built-in `localStorage` shadows jsdom) | Agent 7 | Test workers run with `--no-experimental-webstorage` on Node ≥ 22 |
| Scanned-but-fully-excluded meal showed "No data" | Agent 7 | Panel shows plates scanned + items left out with a plain explanation |
| Stored fallback suggestion was reused forever | Agent 5 | Fallback insights are retried with Gemini on next read |

## Not verified

- Camera hardware / conveyor capture (no hardware).
- Cloudflare R2 against a real bucket: the adapter is unit-tested offline
  (presigned URL signing, HeadObject verification, error mapping); the live
  e2e above ran on `local-dev` storage. Re-run it with
  `OBJECT_STORAGE_PROVIDER=r2` once bucket credentials are in `.env`.
- Measurement accuracy: replay images are AI-generated synthetic plates and
  the demo baselines are hand-assigned; many live estimates land above the
  baseline and are (correctly) excluded. Numbers demonstrate the pipeline,
  not real-world waste.
- Restart persistence is a manual check, not part of the automated e2e.
- CI runs fixture/unit suites only (no Gemini key or SpacetimeDB in CI).

## Distinction reminder

| Claim | Allowed after |
| --- | --- |
| "Fixture tests pass" | `cd tests && npm test` green |
| "API demo path works" | live e2e green |
| "Gemini works" | live smoke with key |
| "Camera works" | hardware test |
