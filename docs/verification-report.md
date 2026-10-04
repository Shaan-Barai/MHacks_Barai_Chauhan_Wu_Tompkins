# Verification report — Agent 8

**Date:** 2026-10-04. The newest section is IT_4 (calibration, estimated grams / CO2e / water, auth). Then BIG-PLAN v2 (`scrap`: pixels only, relative impact points,
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

## IT_4: camera calibration, estimated grams / CO2e / water, auth — 2026-10-04 (workstream K)

What K checked for the capture side, the cross-system flow and demo.py. The backend (B), vision (V) and
analytics (A) have their own unit suites. Fixture and live results are kept apart below.

### Fixture / unit (no Gemini, SAM, depth, R2 or SpacetimeDB)

| Check | Result |
| --- | --- |
| `python3 -m unittest discover -s capture/uno-q` | 66/66. New: C920s focus lock with a fake `v4l2-ctl` that behaves like the real C920 (autofocus off first, then `focus_absolute`; `focus_auto` fallback on older kernels; `--focus-absolute N`; `--no-focus-lock`; failure and a missing `v4l2-ctl` never fail the capture; focus recorded in `metadata.json`; one lock per `--auto` stream); `laptop_capture.py --calibrate` marks one frame `capturePurpose: "calibration"` |
| `cd capture && npm test` | 53/53. New: `SCRAP_API_URL` resolution, token from env → `.env` → `deploy/.run/local-secrets.env`, `Authorization: Bearer` on every backend request and **never** on a presigned PUT to another origin, 401/403 → message naming `SCRAP_INGEST_TOKEN` (token never in messages); calibration client (normalized 1024² upload, association `calibration` with the client-picked `cal_` id, polling, rerun reuse, failed → new attempt, activation keeps/sets the depth toggle); calibration frames listed apart and never ingested; focus-mismatch warning; synthetic fixture sanity |
| `cd tests && npm test` | 22/22. New `integration/calibrate-capture.test.mjs`: the real `simulate-camera` / `ingest-inbox` CLIs against a fake backend that mirrors `calibrationService` → 401 without a token, calibration uploaded at 1024², activated, rerun reuses, a later dish is one `replay` capture and the calibration frame is never a dish |

### Live (local stack: SpacetimeDB `scrap`, SAM 2.1 :8790, DAv2 :8791, R2, Gemini; backend built from the K worktree on :8798 with `NODE_ENV=production`, so mutations need the token)

| Check | Result |
| --- | --- |
| `simulate-camera --calibrate` without a token | exit 1: `Upload authorization failed (401): the backend needs an ingest token. Set SCRAP_INGEST_TOKEN …`; nothing created |
| Calibration from the **synthetic** card fixture (real Gemini box + SAM mask) | `succeeded`: N_ref **38,102 px** (drawn ≈ 37,875, +0.6%), k = 0.001213 cm²/px, fx 1289.7 px (crop-aware), geometric height **44.9 cm** (designed 45). DAv2 read 82.0 cm, scale 0.548, `depth_scale_disagrees` (the image is flat, so the depth number means nothing) |
| `SCRAP_E2E=1 npm run test:e2e:calibration` | **4/4**: calibrate → depth OFF capture (`area-calibrated-v1`; Vegetable Stir Fry Blend 117,707 px → 142.8 cm² · 114 g · 0.055 kg CO2e · 9.1 L; Sticky Rice 70,002 px → 84.9 cm² · 136 g · 0.242 kg CO2e · 122.1 L; areaCm2 = px × k within 1%) → depth ON capture (Cheese Pizza: method `volume-dav2-v1`, `negative_heights_clipped`, grams by area because pizza has no density) → impact totals with `physicalCoverage`. Settings restored afterwards |
| `python3 demo.py --simulate --yes` against :8798 | 23 PASS, 1 WARN (`depth_scale_disagrees`), 1 FAIL (`deploy`: that backend ran without `SERVE_FRONTEND`). Rerun with the built dashboard served: `services,calibration,volume,dashboard,deploy` 13 PASS / 1 WARN / 0 FAIL. `--only deploy` without `SCRAP_PROD_URL` → WARN. hall-main's settings were reset to no active calibration afterwards |
| **Real Uno Q + C920** (`arduino@35.1.88.76`, test copy of the board script) | The first try showed that a combined `v4l2-ctl -c focus_automatic_continuous=0 -c focus_absolute=0` fails on the real C920 (`focus_absolute: Permission denied`). After the fix: `--calibrate` saved a 1920×1080 frame with `focus: locked (focus_automatic_continuous=0, focus_absolute=0)`; `--auto --count 2 --focus-absolute 40` locked once at 40, and `v4l2-ctl -l` read back `focus_absolute=40, focus_automatic_continuous=0`. Board autofocus was restored afterwards and the test copy removed; **the deployed `scrap-camera/uno_q_camera.py` on the board is still the old version** |

Observed and reported to the owners:

- A depth-on capture (before V's `8afadc5` fallback landed in this backend build) reported Cheese Pizza
  `volumeCm3: 0` with only `negative_heights_clipped`. That was a numeric zero, not null. V's later
  fallback adds `depth_invalid` and uses the area method for such foods. Not re-verified live after
  that commit.

**Not verified live:** a real credit card under the mounted C920s (the room was dark and no card was
placed; the only calibration photo is synthetic); volume against an object of measured volume (IT_4 §6.4);
physical accuracy of any gram / CO2e / water number (test2/ photos are from an iPhone at 22–30 cm, not
the calibrated C920s); the production URL (no custom domain or tunnel yet).

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

## Live: real Uno Q camera → R2 → `scrap` → Gemini + SAM (2026-10-04, v2)

- **Board:** `arduino@35.1.88.76`, SSH key `~/.ssh/scrap_unoq`. `live_camera_test.py --stage camera` passed 11/11: board script, ffmpeg, `/dev/video0` MJPG 1920×1080, clock within 0.9 s, a manual `--once` capture, and 5 `--auto` frames at about 1.0 s intervals, all distinct.
- **One real photo end to end** (`laptop_capture.py --once` → `ingest-inbox --no-dedupe` → `svc_hall-main_2026-10-04_dinner`): `cap_01M42NEJWGJG9XZX14797RSDCV`, source `camera`, `succeeded`, counting rule `target-dish-v1`.
  - Original photo and overlay are both in R2; the overlay fetch returned HTTP 200.
  - The dish was a foil takeout tray (rice and chicken), which is not on the dinner menu, so 293,052 px went to "Food not on the menu". Gemini boxed 19 pieces and SAM segmented all of them.
  - Gemini called the tray dish type `other`, and its region was incomplete. The clip was skipped and the attempt was flagged `target_dish_unavailable`, so the counts were kept as designed.
- **Known issues seen live:**
  - After `--auto --count 5`, `uno_q_camera.py --stream` and its ffmpeg kept running on the board and held the camera ("Another capture is using the camera"). They had to be killed by PID.
  - The bridge's 1024² center crop of a 1920×1080 frame cuts off the sides, so the dish should sit in the middle of the frame.
