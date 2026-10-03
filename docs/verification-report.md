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

## Mask pipeline (MVP_AI.md) — 2026-10-03

Gemini classification + boxes → SAM 2.1 Small (`sam2@2b90b9f`, MPS on M1
Max) → validated binary masks → Pixels wasted counted in code.

| Check | Mode | Result |
| --- | --- | --- |
| `vision/` mask tests (box XY/YX conversion, known foreground count, misaligned/soft/non-PNG masks, overlap union, explicit empty plate, classification failure, worker down, partial, unknown food, invented IDs) | unit | 10 new; vision 48/48 |
| `analytics/` pixel aggregation (hand-calculated: complete + empty counted; partial, failed, legacy, other geometry, pending excluded by reason) | unit | 3 new; analytics 31/31 |
| `backend/` capture → masks in object storage → dashboard pixels, dedup on resubmit, worker-down failure | unit/API | 2 new; backend 21/21 (+1 live-only skip) |
| `backend/` live SpacetimeDB: segmentation result + regions round-trip; reducer rejects a capture total ≠ sum of item pixels | **live SpacetimeDB** | 12/12 |
| `frontend/` Pixels wasted payloads, coverage, unclassified food | unit | 23/23; build passes |
| `tests/` live e2e incl. segmentation present, integer counts summing to the union, masks in storage at image size | **live stack** | 5/5 (one earlier run hit a transient Gemini network error, recorded as a retryable `failed` attempt; two reruns passed) |
| Demo replay (6 synthetic plates) | **live stack** | 6/6 `complete`; 23 mask objects stored; e.g. dinner 10-03: 177,920 px (rice 66%, zucchini 20%, salmon 14%) with a Gemini tip citing those pixels |

### Preliminary segmentation evaluation (not the planned annotated set)

A local evaluation script (kept out of the repo, like the photos) on the 5
stock photos in the gitignored `images/` folder. **Ground truth is a proxy** — non-near-white
pixels on a white background — not a hand annotation; it counts food
shadows as food. A = SAM with the tight proxy box (segmentation alone);
B = full path with Gemini's boxes.

| Image | A IoU | B IoU | B count vs proxy | Gemini label |
| --- | --- | --- | --- | --- |
| burger50 | 93.5% | 93.5% | 127,421 vs 124,714 (+2.2%) | burger ✓ |
| burger60 | 91.9% | 91.8% | 81,182 vs 78,635 (+3.2%) | burger ✓ |
| burger90 | 96.4% | 96.4% | 72,240 vs 72,843 (−0.8%) | burger ✓ |
| fries10 | 96.9% | 96.9% | 82,076 vs 84,739 (−3.1%) | fries ✓ |
| fries20 | 82.9% | 82.9% | 53,748 vs 64,575 (−16.8%) | fries ✓ |

Mean IoU 92.3% (A and B), Dice 95.9%, classification 5/5. fries20's "missed"
area is mostly the shadow under the fries (proxy error); its fry edges are
traced with 116 false-positive pixels. Gemini's boxes matched the tight
proxy boxes almost exactly, so on these images localization added no
measurable error. **Limits:** 5 single-food stock photos on white is far
easier than real trays; nothing here is a held-out test or an accuracy
claim. Latency: SAM ~0.3 s/image warm; full path 2.3–3.3 s typical (one
33.6 s outlier from Gemini). Worker memory ~0.4 GB RSS + ~0.3 GB MPS.

**Still required by the plan:** a 20–30-image hand-annotated set of real
dish photos (residue, mixed/unknown foods, empty plates, non-food objects)
with a held-out split, and team-agreed error/latency thresholds.

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
