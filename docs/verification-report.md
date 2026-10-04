# Verification report — Agent 8

**Date:** 2026-10-04. The newest section is BIG-PLAN v2 (`scrap`: pixels only, relative impact points,
target-dish counting). Below it: the v1 BIG-PLAN end-to-end run (retired `scrap-bigplan`), the Phase 3
vertical slice, and the mask pipeline.
**Scope:** fixture/unit suites, live Gemini smoke test, live API e2e against a
local stack (SpacetimeDB standalone 2.10.2 + backend + local-dev storage),
and a browser check of the dashboard.

## Summary

The vertical slice works end to end on one machine: menu upload → reference
portions → replay capture → object storage → live Gemini analysis →
SpacetimeDB persistence → analytics + simulated attendance → grounded
suggestion → dashboard. Camera hardware and a cloud object-storage provider
are **not** tested (neither exists yet).

## BIG-PLAN v2: `scrap` database, menu revisions, seed — 2026-10-04

v2 rules (BIG-PLAN §7, contracts/decisions.md 2026-10-04): Pixels wasted is the only measurement (no
plate calibration, no grams/kg CO2e/litres/dollars); impact is unitless **relative impact points**;
each capture counts only the **target dish** (`target-dish-v1`).

| Check | Mode | Result |
| --- | --- | --- |
| `spacetime publish --server local --delete-data=never scrap` (module from `big-plan-v2`) | **live SpacetimeDB** | Published in place. Created `capture_count`, `segmentation_region`, `attempt_calibration` (they were missing from `scrap`), then `menu_item_revision`. Row counts before = after: 9 services, 33 menu items, 6 captures, 6 attempts, 14 food measurements, 6 image objects, 45 reference portions, 3 attendance, 18 insights |
| `upsert_menu` revision guard + archive (throwaway database `scrap-s-scratch`, deleted afterwards) | **live SpacetimeDB** | A higher `menuVersion` archives the outgoing items in `menu_item_revision` (`<itemId>@v<version>`); an older version is rejected (`… is older than the stored version 3`) |
| `npm run seed -- --live-dinner=2026-10-04` against `scrap` (backend on a side port, local-dev storage) | **live SpacetimeDB** | 1 created (2026-10-04 dinner), 5 revised (10-01 and 10-02 dinners v1→v2; 10-03 breakfast, lunch, dinner v2→v3, replacing hand-typed test items), 4 unchanged; 99 reference portions; 92 demo portions (23 × 4 dinners, each for the current version). Second run: 0 created, 0 revised, 10 unchanged, same counts |
| `scrap` after seeding (SQL, owner token) | **live SpacetimeDB** | 10 services, 122 menu items (5 × 6 + 23 × 4), 13 archived items, 92 portions served, 114 reference portions; captures 6, attempts 6, measurements 14, image objects 6 (unchanged); `svc_hall-main_2026-10-04_dinner` has 23 items and 23 demo portions |
| `backend/` `seed.test.ts` (JSON repository) | unit | 1/1: idempotent, demo labels, one row per seeded count |
| `tests/e2e/scrap-live.test.mjs` | not run yet | Retargeted to `scrap` and v2: counting rule `target-dish-v1`, no calibration, integer per-food pixels summing to the capture union, `capture_count` rows, no grams keys, `labels.relativeImpact`, ranking by pixels and pixels per portion, `coverage.capturesWithNeighborFoodExcluded`. Waits for the v2 vision/backend code and Gemini billing |

Notes:

- The six old captures froze menu version 1. The 10-01/10-02 dinner items they reference are archived
  in `menu_item_revision`; the 10-03 version-1 items had already been replaced by hand-typed test
  items before this run (no archive existed then), so those itemIds no longer resolve to a name.
- Today's dinner is `svc_hall-main_2026-10-04_dinner` (`localServiceDate` in America/Detroit).
- **Not verified yet:** the real Uno Q with the v2 pipeline (`live_camera_test.py`), target-dish
  counting on live photos, and the v2 dashboard payloads (waiting for Gemini billing, HTTP 402).

## v1 BIG-PLAN end-to-end (camera path → R2 + SpacetimeDB → Gemini + SAM) — 2026-10-03

> **Historical (v1).** This run used the retired `scrap-bigplan` database and the v1 plate calibration.
> Its gram, CO2e, water and dollar figures are no longer reported (v2 has no calibration) and have
> been removed below; the pixel counts stand.

Run on one laptop (M1 Max): SpacetimeDB standalone 2.10.2 (database `scrap-bigplan`) on :3000, SAM 2.1
worker (`sam2.1-hiera-small`, `sam2@2b90b9f`, MPS) on :8790, and the backend from `big-plan` at
`71ef028` on :8787 with `OBJECT_STORAGE_PROVIDER=r2` and live Gemini (`GEMINI_MODEL=gemini-3.5-flash` from `.env`). Camera
input came from **`simulate-camera`** (real `test2/` iPhone plate photos written in the Uno Q inbox
format). **The Uno Q board was not used in this run.**

### Live results

| Check | Mode | Result |
| --- | --- | --- |
| `tests/e2e/bigplan-live.test.mjs` (now `scrap-live.test.mjs`; `SCRAP_E2E=1`, 3 photos, `--no-dedupe`) | **live: R2 + SpacetimeDB + Gemini + SAM** | 7/8 on the first run. The SpacetimeDB SQL check failed because of a bug in the test helper (it read the response body twice). After the fix, a re-check of the same 3 events (`SCRAP_E2E_EVENT_IDS`, no new captures) passed 8/8 |
| simulate-camera → bridge, one pass | live | 3 photos → 3 dishes → 3 capture events in 53 s (analysis runs during `POST /api/captures`); bridge rerun: nothing ingested |
| Analysis | live | 3/3 `succeeded`, segmentation `complete`, source `replay`, 1024² `topdown-normalized-v1` |
| `GET /api/captures/:id/images` | live R2 | original + overlay + every mask returned HTTP 200 with an image content type (8 masks in total); URLs were not printed or logged |
| SpacetimeDB rows (SQL over HTTP, owner token) | live | per capture: 1 `capture_event`, `image_object` rows for photo/overlay/masks (provider `r2`, `finalized`, kinds `capture`/`overlay`/`mask`, keys not URLs, no long strings), 1 `analysis_attempt`, 1 `attempt_calibration` (overlay id matching the overlay row), and `food_measurement` rows |
| `GET /api/dashboard/impact?start=2026-10-03&end=2026-10-03&hallId=hall-main` | live | `targets` and `mostWasted` filled; `demoPortions = true` |
| `GET /api/recommendation` (same window, before credits ran out) | **live Gemini** | `source: gemini`, 4 bullets each citing a dashboard metric; mentions that only 3 plates were analyzed; no cause claimed |
| Secrets/URLs | live | backend and E2E logs contain no signed URL (`X-Amz-Signature`: 0 matches) |

Per photo (Pixels wasted):

| Photo | Event | Foods → px | Total |
| --- | --- | --- | --- |
| IMG_2695 | `cap_01M42HG5…` | Vegetable Stir Fry Blend 110,941; Sticky Rice 69,487 | 180,428 px |
| IMG_2697 | `cap_01M42HGV…` | Baked Sweet Potatoes 83,531; Roasted Cauliflower 72,529; Baked Boneless Ham 28,822; food not on the menu 13,919 | 198,801 px |
| IMG_2701 | `cap_01M42HHD…` | Michigan Farmers 4 Bean Stew 20,108; Cheese Bread 13,707 | 33,815 px |

Compared with the hand labels in `ground_truth.csv`: IMG_2695 got 2 of 2 foods right and IMG_2697 got
3 of 3. IMG_2701 found the bean stew but also reported Cheese Bread, which the hand labels don't list.
This is 3 photos, not an accuracy measurement.

Totals (hall-main, 2026-10-03; only these 3 captures in the window): 3 captures, 3 analyzed,
0 excluded, 413,044 px. Most wasted by pixels: Baked Sweet Potatoes 83,531, Roasted Cauliflower 72,529,
Sticky Rice 69,487.

### Fixture / unit results (same commit)

| Suite | Result |
| --- | --- |
| `capture/` `npm test` (incl. 8 new `simulateCamera` tests: inbox reader + bridge with fake matcher and `--no-dedupe`, `replay` label, `laptop_capture.py` `validate_bundle()`/`save_capture()` byte-for-byte) | 36/36 |
| `capture/uno-q` `python3 -B -m unittest discover -s capture/uno-q` (fake FFmpeg/SSH) | 57 OK |
| `tests/` `npm test` (live suites skipped) | 18/18 |
| `data/` 38/38 · `vision/` 68/68 · `analytics/` 57/57 · `backend/` 49/50 (1 live-only skip) · `frontend/` 46/46 | pass |

### Gemini credits ran out right after the run (2026-10-04 04:12 UTC)

After the run, the backend was restarted on `619cbaf`/`baab6d9`. The same 3 events were re-checked
(`SCRAP_E2E_EVENT_IDS`): 7/7 pass, with the simulator step skipped. `/api/recommendation` now returns
the labeled **`fallback`**, and keeps doing so after the 60 s Gemini retry. A direct gateway call shows
why: Google returns **HTTP 402 `RESOURCE_EXHAUSTED`, "Your prepayment credits are depleted"**.

- Until billing is topped up, **new captures will fail Gemini classification**, and recommendations stay
  rule-based.
- Stored results, R2 images and the impact dashboard are unaffected.
- Defect, owner Agent 4 (`vision/`): the gateway mapped the 402 to `GEMINI_BAD_REQUEST`. Fixed in
  `e54c29e`: it is now `GEMINI_BILLING`.

### Notes and limits

- **Not verified live:** the Uno Q + C920s with this pipeline (use `capture/scripts/live_camera_test.py`),
  Gemini same-dish grouping (`--no-dedupe` was used on purpose), the dashboard UI in a browser (this run
  checked the API only), and restart persistence.
- Simulated dishes are labeled `source: replay`. The `capturedAt` of these events is the run time
  (2026-10-04 UTC), while the service is the 2026-10-03 dinner chosen with `--service`. The impact window
  filters by service date, so they count toward 2026-10-03.
- Portions are demo values.
- `scrap-bigplan` also has a test capture in `hall-tmuta9xkt` from the backend's live test; every query
  above used `hallId=hall-main`.

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
- ~~Cloudflare R2 against a real bucket~~: verified live in the BIG-PLAN
  section above. The earlier Phase 3 e2e ran on `local-dev` storage.
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
| "Camera works" | hardware test (`capture/scripts/live_camera_test.py`) |
| "Camera path works without the board" | `simulate-camera` + bridge live run (labeled `replay`) |
