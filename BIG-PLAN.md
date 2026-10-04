# BIG-PLAN: camera → R2/SpacetimeDB → Gemini+SAM → waste impact → dashboard

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
| Waste factors (C, W, O, score) | CSV + README; the score still includes nutrition | `menu_waste_factors.csv`, `menu_waste_factors_README.md` |
| Portions served + Pixels-wasted-per-portion | Implemented (pixels only) | `analytics/src/portions.ts`, `data/src/portionsServed.ts` |
| Dashboard | Simplified ScrapSaver redesign. No impact, no per-portion headline, no images | `frontend/` |
| AI suggestions | Pixel/portion-grounded suggestions | `analytics/src/*Suggestions.ts` |

## 2. Decisions (the coordinator records them in `contracts/decisions.md`)

- **D1. Score without nutrition.** `waste_impact_usd_per_kg = 0.19·C + 1.50·W`. C = kg CO2e/kg and
  W = m³ freshwater/kg, from `menu_waste_factors.csv`. Nutrition (O, nutrient-days/kg) moves to
  `menu_nutrition_factors.csv`. It is reported separately as "nutrition lost" and never added to the score.
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
- **D6. Demo menu and dummy portions.** The demo dinner menu uses the 23 foods in
  `menu_waste_factors.csv`. Descriptions are the `gemini_visible_components` text from
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
export interface WasteFactor {      // one row of menu_waste_factors.csv
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
| **A** | Factors & analytics (Agents 2+6) | `data/`, `analytics/`, `menu_waste_factors*.{csv,md}`, new `menu_nutrition_factors.csv` | Split CSV (no nutrition in score); README rewrite; typed factor table + `slug` lookup in `data/`; dinner demo menu (23 foods, Gemini descriptions) + dummy portions in the seed; `analytics` `computeWasteImpact`, item impact rows, per-portion ranking, totals, nutrition-lost (separate); recommendation facts + prompt + fallback; unit tests with hand-calculated numbers |
| **B** | Vision (Agent 4) | `vision/` | Port `plate-fit-v1` calibration and overlay rendering from `waste-impact.mjs` into `vision/src` (library API returning `PlateCalibration` + overlay JPEG bytes). Use menu descriptions in the localize prompt. Set up the local SAM 2.1 worker venv (`.venv`, gitignored) and run a live smoke test on `test2/` photos. Tests use fakes |
| **D** | Backend + DB (Agents 2/5) | `backend/`, `db/` | Persist the calibration per capture (schema, additive). Store overlay JPEGs in R2 + `image_object` (`overlay`). Endpoints in §3. Seed the dinner menu + demo portions into SpacetimeDB. Wire `analytics` impact/recommendation. Tests |
| **E** | Dashboard (Agent 7) | `frontend/`, `UI.md` | New dashboard: headline cards **Total waste** (est. g + pixels), **CO2e**, **Water**, **Waste impact $**. **Foods to target** (waste per portion), **Most wasted** table, nutrition lost as a separate labeled note, **Plates** gallery (original ↔ segmented toggle, per-food legend), **AI recommendation** card. Mock data first, then the live API. Tests |
| **F** | Capture + E2E + docs (Agents 3/8) | `capture/`, `tests/`, `docs/`, `BRIDGE.md`, `ARDUINO.md` | Verify Uno Q → inbox → bridge → backend against the new pipeline. Add a `simulate-camera` script that writes `test2/` photos into an inbox-shaped dir (same layout and metadata as `laptop_capture.py`) so the full path runs without the board. Live E2E: inbox → R2 → SpacetimeDB → Gemini+SAM → overlay in R2 → dashboard API. Demo walkthrough update |

**Order:** M → C (contracts) → A, B, E start in parallel against the §3 shapes → D starts once A's
analytics API and B's vision API are exported (stubs allowed earlier) → F runs the live end-to-end
once D lands → C does the final review, updates README/AGENTS, and merges `big-plan` → `main`.

## 5. Acceptance checks

1. A photo dropped into the inbox (real Uno Q or `simulate-camera`) yields exactly one capture event.
   R2 holds the photo, overlay and masks. SpacetimeDB has `image_object` + `capture_event` +
   `analysis_attempt` + `food_measurement` rows with references only.
2. Gemini runs before SAM. Pixel counts come from validated masks. The calibration is persisted or
   flagged as the default.
3. `menu_waste_factors.csv` scores exclude nutrition, and the README documents `0.19·C + 1.50·W`.
   Nutrition lives in its own file/section.
4. The dashboard shows total waste (est. g + pixels), CO2e, water, impact $, foods to target by waste
   per portion, most wasted, plate images (original + segmented), and an AI recommendation citing
   shown numbers. Demo portions and estimates are labeled.
5. Every package builds and its tests pass. Live-vs-fixture verification is reported honestly.

## 6. Status tracker

| WS | State | Last update | Notes |
| --- | --- | --- | --- |
| M | running | 2026-10-03 | 22 conflicts. The frontend base is main's redesign |
| C | contracts published | 2026-10-03 | §3 types in `contracts/types.ts`, D1–D8 in `contracts/decisions.md` |
| A | not started | | |
| B | not started | | |
| D | not started | | |
| E | not started | | |
| F | not started | | |
