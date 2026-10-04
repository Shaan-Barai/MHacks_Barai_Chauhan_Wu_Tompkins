# BIG-PLAN: camera → R2/SpacetimeDB → Gemini+SAM → waste impact → dashboard

> **v2 (2026-10-04) supersedes D2, D3, D5 and the database choice below.** Decisions:
> pixels only (no plate-size calibration, no grams); relative impact points;
> target-dish counting for neighboring plates; everything in the `scrap` database;
> live run on the real Uno Q (35.1.88.76). See §7 and `contracts/decisions.md` (2026-10-04).

**Started:** 2026-10-03 · **Integration branch:** `big-plan` (merged into `main` when done)
**Coordinator:** Agent 1 (main session). This file is the live tracker; the coordinator updates the
status table below as agents report back.

## 0. Goal (from the user)

1. The camera (Logitech C920s on the Arduino Uno Q) takes a picture.
2. The Uno Q sends it to the laptop.
3. The picture reaches the **R2** bucket, and **SpacetimeDB** gets a matching record.
4. Analysis uses the AI setup from `menu-source-experiment`: **Gemini classifies + boxes**, then
   **SAM 2.1 segments**, and the code counts pixels.
5. Uploaded photos **and segmented images** (overlay + per-food masks) go to R2. SpacetimeDB holds
   only their references/metadata.
6. Use the formula in `menu_waste_factors_README.md`, **without nutrition in the score**.
   Score = `s·C + t·W` (greenhouse gases + freshwater withdrawn). Nutrition lost moves to a separate,
   separately labeled place. Update the README to match.
7. Compute **waste per portion** to find the foods to target. Use reasonable dummy portion counts.
8. Dashboard: **total waste**, **waste per portion**, **most wasted** foods. The UI/UX changes to match,
   and the dashboard shows the original and segmented images.
9. An **AI recommendation** grounded in these statistics.

## 1. What already exists (after merging `menu-source-experiment` into `main`)

| Step | Status before this plan | Where |
| --- | --- | --- |
| Uno Q capture (manual + `--auto` 1 fps) → SSH → laptop inbox | Implemented | `capture/uno-q/`, `ARDUINO.md` |
| Inbox → dish grouping (Gemini same-dish) → R2 presigned upload → finalize → `POST /api/captures` | Implemented, fixture-tested | `capture/src/inboxBridge.ts`, `BRIDGE.md` |
| Gemini classify + boxes → SAM 2.1 masks → per-food pixels; masks stored in object storage | Implemented on the experiment branch | `vision/src/maskPipeline.ts`, `vision/sam/worker.py`, `backend/src/services/ingestionService.ts` |
| Plate calibration (Gemini plate box → SAM → circle fit → cm²/px) and colored overlay | **Script only** | `vision/scripts/waste-impact.mjs` |
| Waste factors (C, W, O, score) | CSV + README; the score still includes nutrition | `menu_waste_factors_EastQuad.csv`, `menu_waste_factors_README.md` |
| Portions served + Pixels-wasted-per-portion | Implemented (pixels only) | `analytics/src/portions.ts`, `data/src/portionsServed.ts` |
| Dashboard | Simplified ScrapSaver redesign. No impact, no per-portion headline, no images | `frontend/` |
| AI suggestions | Pixel/portion-grounded suggestions | `analytics/src/*Suggestions.ts` |

## 2. Decisions (the coordinator records them in `contracts/decisions.md`)

- **D1. Score without nutrition.** `waste_impact_usd_per_kg = 0.19·C + 1.50·W`. C = kg CO2e/kg and
  W = m³ freshwater/kg, from `menu_waste_factors_EastQuad.csv`. Nutrition (O, nutrient-days/kg) moves to
  `menu_nutrition_factors_EastQuad.csv`. It is reported separately as "nutrition lost" and never added to the score.
- **D2. Pixels → grams.** The calibration and weight constants that AGENTS.md §2 required now exist,
  so estimated grams may be shown, **always labeled as estimates**. Per capture:
  `cm²/px = (26.7 cm / plate_diameter_px)²`. The plate diameter comes from Gemini's plate box → SAM
  plate mask → outer-rim circle fit (`plate-fit-v1`, ported from `waste-impact.mjs`). If that fails, we
  fall back to the configured `PLATE_DIAMETER_PX` and flag `calibration_default`.
  `grams = pixels × cm²/px × weight_g_per_cm2`. Pixels wasted stays the raw stored measurement.
- **D3. Impact is computed in analytics at read time.** We persist pixels and per-capture calibration.
  Grams, CO2e, water, impact $ and nutrition are derived through the pure `analytics` functions, with a
  `wasteFactorsVersion` stamp (`waste-factors-v2`). A factor edit therefore never needs a DB migration.
- **D4. Menu item → factor row.** The match uses `factorKey = slug(displayName)`
  (e.g. `ancho-flank-steak`), checked against the factor table in `data/`. Items without a factor
  keep their pixels and grams-unavailable status. They are listed as "no impact factor", never as zero.
- **D5. Waste per portion.** `grams_per_portion_i = Σ estimated grams_i / Σ portions_served_i` over
  the same hall/date/service/menu version, plus `pixels_per_portion` and
  `impact_usd_per_portion`. The **"Foods to target"** list is ranked by grams per portion.
  **"Most wasted"** is ranked by total estimated grams. Missing or zero portions make the rate
  unavailable (AGENTS.md §7).
- **D6. Demo menu and dummy portions.** (2026-10-04: now 26 foods, adding Halal Rice, Tomatoes and Lettuce.) The demo dinner menu uses the 23 foods in
  `menu_waste_factors_EastQuad.csv`. Descriptions are the `gemini_visible_components` text from
  `gemini_menu_guesses_raw.txt`, because Gemini descriptions scored slightly better in
  `experiment_summary.csv`. Dummy portions use a seeded, plausible 40–260 range per item, with
  source `demo`, labeled demo.
- **D7. Images.** For each capture, R2 holds the normalized photo (existing), every per-food mask PNG
  (existing), and **a new segmented overlay JPEG** (masks tinted per food, plate rim outlined, legend).
  SpacetimeDB holds `image_object` rows for each one, with association kinds `capture`, `mask` and
  `overlay`. The dashboard gets short-lived read URLs from `GET /api/captures/:id/images`.
- **D8. AI recommendation.** This is Gemini via the existing gateway. It is grounded in the
  per-portion ranking, totals and impact, and it cites its numbers. A labeled rule-based fallback is
  used when Gemini is unavailable. It must not claim a cause.

## 3. Shared contract additions (Agent 1 → `contracts/types.ts`, published before fan-out)

```ts
export interface PlateCalibration {
  method: 'plate-fit-v1' | 'configured-default';
  plateDiameterCm: number;          // 26.7
  plateDiameterPx: number;
  cm2PerPx: number;
  dishType?: 'plate' | 'bowl' | 'other';
  fullyVisible?: boolean;
  flags: Array<'calibration_default' | 'plate_cut_off' | 'bowl_size_assumed'>;
}
export interface WasteFactor {      // one row of menu_waste_factors_EastQuad.csv
  factorKey: string; food: string; station: string;
  weightGPerCm2: number; kgCo2ePerKg: number; waterM3PerKg: number;
  impactUsdPerKg: number;           // 0.19*C + 1.50*W (no nutrition)
  largestFactor: 'carbon' | 'water';
}
export interface NutritionFactor { factorKey: string; nutrientDaysPerKg: number; kcalPerKg: number }
export interface WasteImpact {      // derived, never stored
  pixels: number; cm2: number | null; grams: number | null;
  kgCo2e: number | null; waterM3: number | null; impactUsd: number | null;
  nutrientDaysLost: number | null;  // separate, NOT part of impactUsd
  wasteFactorsVersion: string;
  unavailableReason?: 'no_calibration' | 'no_factor' | 'unknown_item';
}
```

Dashboard payloads (Agent 5 serves them, Agent 7 consumes them, and `contracts/samples.json` gets
examples):
`GET /api/dashboard/impact?start&end&hallId` →
`{ totals: WasteImpact & { captures, analyzedCaptures, excludedCaptures }, items: ItemImpactRow[], coverage }`,
where `ItemImpactRow = { itemId, displayName, factorKey, impact: WasteImpact, portionsServed: number|null, perPortion: { grams, pixels, impactUsd } | null, portionsSource }`.
`GET /api/captures?start&end` → a recent capture list with state and item pixel/gram totals.
`GET /api/captures/:id/images` → `{ original, overlay, masks[] }`, each `{ objectId, url, expiresAt }`.
`GET /api/recommendation?start&end` → `{ text, bullets[{ text, metric }], source: 'gemini'|'fallback', generatedAt, inputVersion }`.

## 4. Workstreams and ownership

Each agent works in its own git worktree. It commits small verified chunks, then
`git fetch && git rebase origin/big-plan && git push origin HEAD:big-plan`, resolving any conflicts
itself. It never force-pushes, and it never edits another agent's directory without a coordinator handoff.

| WS | Agent | Owns | Deliverables |
| --- | --- | --- | --- |
| **M** | Merge integrator | everything (one-time) | `menu-source-experiment` merged into `big-plan`, builds/tests green |
| **C** | Coordinator (Agent 1) | `BIG-PLAN.md`, `AGENTS.md`, `README.md`, `contracts/` | Decisions D1–D8, §3 contract types + samples, final review and merge to `main` |
| **A** | Factors & analytics (Agents 2+6) | `data/`, `analytics/`, `menu_waste_factors*.{csv,md}`, new `menu_nutrition_factors_EastQuad.csv` | Split CSV (no nutrition in score); README rewrite; typed factor table + `slug` lookup in `data/`; dinner demo menu (23 foods, Gemini descriptions) + dummy portions in the seed; `analytics` `computeWasteImpact`, item impact rows, per-portion ranking, totals, nutrition-lost (separate); recommendation facts + prompt + fallback; unit tests with hand-calculated numbers |
| **B** | Vision (Agent 4) | `vision/` | Port `plate-fit-v1` calibration and overlay rendering from `waste-impact.mjs` into `vision/src` (library API returning `PlateCalibration` + overlay JPEG bytes). Use menu descriptions in the localize prompt. Set up the local SAM 2.1 worker venv (`.venv`, gitignored) and run a live smoke test on `test2/` photos. Tests use fakes |
| **D** | Backend + DB (Agents 2/5) | `backend/`, `db/` | Persist the calibration per capture (schema, additive). Store overlay JPEGs in R2 + `image_object` (`overlay`). Endpoints in §3. Seed the dinner menu + demo portions into SpacetimeDB. Wire `analytics` impact/recommendation. Tests |
| **E** | Dashboard (Agent 7) | `frontend/`, `UI.md` | New dashboard: headline cards **Total waste** (est. g + pixels), **CO2e**, **Water**, **Waste impact $**. **Foods to target** (waste per portion), **Most wasted** table, nutrition lost as a separate labeled note, **Plates** gallery (original ↔ segmented toggle, per-food legend), **AI recommendation** card. Mock data first, then the live API. Tests |
| **F** | Capture + E2E + docs (Agents 3/8) | `capture/`, `tests/`, `docs/`, `BRIDGE.md`, `ARDUINO.md` | Verify Uno Q → inbox → bridge → backend against the new pipeline. Add a `simulate-camera` script that writes `test2/` photos into an inbox-shaped dir (same layout and metadata as `laptop_capture.py`) so the full path runs without the board. Live E2E: inbox → R2 → SpacetimeDB → Gemini+SAM → overlay in R2 → dashboard API. Demo walkthrough update |

**Final step (user request):** after everything lands, the coordinator writes `EXPLAIN.md`, a simple explanation of the whole database (SpacetimeDB tables + R2 objects and how they link).

**Order:** M → C (contracts) → A, B, E start in parallel against the §3 shapes → D starts once A's
analytics API and B's vision API are exported (stubs allowed earlier) → F runs the live end-to-end
once D lands → C does the final review, updates README/AGENTS, and merges `big-plan` → `main`.

## 5. Acceptance checks

1. A photo dropped into the inbox (real Uno Q or `simulate-camera`) yields exactly one capture event.
   R2 holds the photo, overlay and masks. SpacetimeDB has `image_object` + `capture_event` +
   `analysis_attempt` + `food_measurement` rows with references only.
2. Gemini runs before SAM. Pixel counts come from validated masks. The calibration is persisted or
   flagged as the default.
3. `menu_waste_factors_EastQuad.csv` scores exclude nutrition, and the README documents `0.19·C + 1.50·W`.
   Nutrition lives in its own file/section.
4. The dashboard shows total waste (est. g + pixels), CO2e, water, impact $, foods to target by waste
   per portion, most wasted, plate images (original + segmented), and an AI recommendation citing
   shown numbers. Demo portions and estimates are labeled.
5. Every package builds and its tests pass. Live-vs-fixture verification is reported honestly.

## 6. Status tracker

| WS | State | Last update | Notes |
| --- | --- | --- | --- |
| M | running | 2026-10-03 | 22 conflicts. The frontend base is main's redesign |
| C | **done** | 2026-10-04 | contracts, decisions, README/.env.example/AGENTS.md (`baab6d9`), GEMINI_BILLING + fallback logging (`e54c29e`), EXPLAIN.md, merge to main |
| A | **done** | 2026-10-04 | `1290f52` `f0221be` `fe7be24` `bc293c6`; data 38/38, analytics 57/57 (fixtures). Water is the largest factor for 17 foods, carbon for 6 |
| B | **done** | 2026-10-04 | `997eeac` `bb7a7a3` `6857fae` (merge of the user's two-pass localization) `2ada2a2` `71ef028`; vision 68/68; **live** smoke on 4 photos: all plate-fit-v1, foods match ground truth; SAM worker running on :8790 |
| D | **done** | 2026-10-04 | `a8919d6` `714e158` `5fd5838` `8ef4ecd` `12fd391` `6c34b80`; backend 49 pass; live repo test 13/13 on `scrap-bigplan`; seeded |
| E | **done** | 2026-10-04 | `27fdaa5` `4feb9c2` (+ coordinator polish `563de3f`); frontend 46/46; checked in headless Chrome against live data: cards, targets, most wasted, chart in grams, plate gallery with R2 photo + segmented overlay |
| F | **done** | 2026-10-04 | `2d03127` `af46873` `1c5f3ad` `ade68d4` `2684e85`; **live E2E 8/8** on 3 photos (simulate-camera → bridge → R2 → scrap-bigplan → Gemini+SAM → overlay → dashboard API) |

### Log
- 2026-10-03: user pushed `85ba842` (capture/scripts/live_camera_test.py, ingest-inbox `--state-dir`) to `big-plan`, and `fef1065` (two Gemini localization passes merged by IoU) + `df909ca` (before/after mixed-dish data) to `menu-source-experiment`. All agents notified; WS-B owns merging `menu-source-experiment` again (overlaps its maskPipeline.ts work); WS-F builds on live_camera_test.py.
- Landed so far: A `1290f52` (score without nutrition), `f0221be` (factor tables), `fe7be24` (demo dinner + portions); B `997eeac` (calibration + overlay); D `a8919d6` (calibration/overlay persistence, images endpoint), `714e158` (seed), `5fd5838`, `8ef4ecd`.
- Open judgement calls: (1) clip food counts to the fitted dish? Not enabled: a bad fit would delete real food; `diagnostics.pixelsOutsideDish` reports it instead (it matters for multi-dish phone photos, less so for the single-plate camera). (2) The 900 px default plate diameter should be measured from a real C920s frame. (3) `scrap-bigplan` has one stray test capture (hall `hall-tmuta9xkt`); the dashboard always passes `hallId=hall-main`. Wiping it is the user's call.
- 2026-10-04 live E2E result: 3 captures, 413,044 px ≈ 337 g, 0.59 kg CO2e, 132 L water, $0.31 impact; top target Baked Sweet Potatoes 1.4 g/portion (demo portions). After the run, the Gemini key's prepaid credits were depleted (HTTP 402). New captures will fail classification and the recommendation shows the labeled fallback until billing is topped up.
- Not verified live: the real Uno Q board with this pipeline (`capture/scripts/live_camera_test.py`), Gemini same-dish dedupe (E2E used `--no-dedupe`).

## 7. v2 (2026-10-04): pixels only, relative impact, target dish, `scrap`, real camera

**User direction:** run the real Arduino (35.1.88.76) and use the current Gemini settings (two-pass IoU
localization `fef1065`, numbered per-piece boxes `d24ce1b`, Gemini menu descriptions). Put everything in
`scrap`. Drop the plate size and use pixels. Fix neighboring plates by having Gemini count only the
scanned plate. Update all context docs.

| Decision | Rule |
| --- | --- |
| V1 pixels only | Total waste, waste per portion (px ÷ portions) and most wasted are in pixels. No calibration, no grams |
| V2 relative impact | `points = px/1000 × weight_g_per_cm2 × factor`: co2Points (C), waterPoints (W), impactPoints (0.19C + 1.50W). Unitless and labeled relative. nutritionPoints are separate |
| V3 target dish | Gemini marks the target dish and assigns each food box to target or other. Other-dish food is dropped, then masks are clipped to the dish region (filled, dilated SAM mask). No dish found ⇒ no clip + flag. Counting rule `target-dish-v1` |
| V4 `scrap` | Additive publish to `scrap`. The seed adds a menu revision for dinners whose items changed. Configs and docs default to `scrap` |
| V5 context | Every doc (README, AGENTS, EXPLAIN, BIG-PLAN, UI.md, menu_waste_factors_README, contracts, docs/, package READMEs) describes v2 |

| WS | Owns | Task | State |
| --- | --- | --- | --- |
| V | `vision/` | target-dish counting (V3), stop producing calibration, overlay shows the target dish + excluded food, tests, live check when Gemini billing works | **done**: `639ce19` `16650b7` `5b5e526` `578ef13` `4016fd9`; 74/74. Live on IMG_2697/2701: neighbor food excluded (13,918 / 13,707 px), every hand-labeled food counted, nothing extra; 2 Gemini calls per capture |
| M | `analytics/`, `backend/` services/endpoints, `menu_waste_factors_README.md` | V1/V2 metrics + recommendation in pixels/points, endpoint payloads per the new contract, tests, docs | **done**: `f12d10a` `01ed2c7` `6a507e8` `d7138fb` `9dc4b82` `baf8441`; analytics 61, backend 55 |
| U | `frontend/`, `UI.md` | pixel headline cards, relative impact card(s), per-portion pixels, labels, tests | **done**: `bcefe45`; 49/49 |
| S | `db/`, `backend/scripts`, `capture/`, `tests/`, `docs/`, `.env.example` | publish to `scrap`, seed with menu revision, switch defaults to `scrap`; then the real Uno Q live run once SSH + Gemini billing are ready | phase A **done**: `e7d0ebb` `1b9ba2a` `3f597bb` (`scrap` published in place, nothing wiped; seeded with revisions; 10-04 dinner ready). Phase B (real camera) waits on the user |

**User blockers:** (1) Gemini key returns HTTP 402 (prepaid credits depleted): top up billing. (2) SSH to
`arduino@35.1.88.76` needs a key: `ssh-copy-id -i ~/.ssh/scrap_unoq.pub arduino@35.1.88.76` (the key was
generated on the laptop).

**v2 status (2026-10-04):** code merged to `main`. The backend on :8787 runs v2 against `scrap` with R2. Gemini credits ran out again after the vision live check, so the 2 simulated captures (10-03 dinner) failed with `GEMINI_BILLING`. Re-run them with `backend/scripts/retry-failed.mjs` once billing is topped up. The real Uno Q run waits on the SSH key and Gemini billing.
