# Prototype decisions

## Current measurement direction: 2026-10-03

- Latest user decision: **Gemini CLASSIFICATION first → SEGMENTATION MASK → programmatic count of Pixels wasted**. The primary metric is counted foreground pixels, with units pixels. This supersedes primary servings, serving percentages, piece counts, and Gemini-guessed numeric areas in the historical entries below.
- The canonical shared context now lives in the parent `AGENTS.md`, `contracts/measurement.md`, and `contracts/decisions.md`. This nested directory retains the earlier synthetic preview and its historical decisions.
- The segmentation provider/model is still to be selected. The classification result supplies food labels; the quantity must be calculated from validated masks in code. Store reproducible mask provenance, normalize dimensions/geometry, and count overlapping foreground pixels once.
- Baselines are auxiliary and cannot block valid pixel counts. Unknown edible food has a separate unclassified bucket. Failed/missing masks are unavailable; only a successfully validated empty mask establishes zero pixels.
- The earlier conditional mean-percentage recommendation request remains auxiliary pending a defined compatible reference denominator. It does not gate Pixels wasted and must not be a free-form Gemini percentage guess.
- Camera placement and conveyor integration remain deferred. No runtime analysis, fixture, or dashboard migration is implemented by this context-only assignment.

## 2026-10-03: seven-day public UI preview

- The application root is `/Users/mike/mhacks/mhacks`. The parent contains the Git repository and the original product/UI plans; it is not a second application.
- This assignment implements a synthetic UI preview, not the full capture → Gemini → R2 → SpacetimeDB workflow. The existing SpacetimeDB starter is preserved.
- One writer fills coordinator, data, analytics, dashboard, and integration-verification roles sequentially. Ownership maps to `contracts/`, `data/`, `analytics/`, `frontend/`, `tests/integration/`, `docs/`, and coordinator-owned root scripts/configuration. Existing module assembly remains `spacetimedb/src/index.ts`; bindings remain `src/module_bindings/`.
- The preview follows the parent `UI.md` palette and three-column layout using React and Tailwind. It skips onboarding and live menu uploads because this assignment is to test the UI with fake records. Menus display the fixture; settings export it as CSV.
- “Last seven days” means September 27–October 3, 2026, inclusive, in America/Detroit. Breakfast/lunch/dinner produce 21 services. The default reporting range is these seven days; longer periods show their actual available coverage.
- All records are synthetic. Capture counts, simulated attendance, and successful/excluded analyses remain separate. Numerical values are fixture examples of AI-estimated pixel area, not live Gemini output or physical mass.
- One versioned JSON fixture, `frontend/demo-data.json`, contains menus, compatible baseline metadata, capture results, and stable attendance. It contains no photographs, credentials, signed URLs, or live database records. `data/generate-demo.mjs` regenerates it reproducibly.
- Canonical area-weighted aggregation lives in `analytics/`. Unknown foods, invalid/missing baselines, above-baseline estimates, incompatible geometry, review results, and failures are excluded. Empty plates do not create servings for foods absent from the image.
- Suggestions in this preview are labeled rule-based demo suggestions, with supporting item shares and sample counts. Gemini transport is not implemented by this assignment.
- The user selected a public shareable link. A Cloudflare Quick Tunnel exposes only the built static preview and is temporary: both its server and tunnel processes must keep running. A persistent hosting deployment remains a separate setup step.
- The user supplied `SPACETIMEDB_URI`, `SPACETIMEDB_MODULE`, `SPACETIMEDB_TOKEN`, and plural `OBJECT_STORAGE_CONTAINERS` as the desired environment contract. R2 is the selected image provider. The preview requires no secrets. The starter client accepts the supplied SpacetimeDB names plus legacy template aliases. Local secret files remain user-managed.
- The inspected parent `.env` still used singular `OBJECT_STORAGE_CONTAINER`; configuration must match the intended plural name before an R2 adapter is implemented. The configured database name also differs from `spacetime.json`; choose one live target before a persistence test.

## Remaining live-integration work

Implement menu/baseline tables and reducers, an R2 upload/finalization/read adapter, server-side Gemini validation, capture idempotency, persisted attendance, authenticated orchestration, and live dashboard subscriptions. Verify provider credentials and behavior with non-private test images. No provider smoke test is represented by fixture validation.

## 2026-10-03: Scrap Saver interface revision

- The active assignment is a UI revision. This checkout contains the preview contract, generator, and analytics, but no React dashboard source or preview build scripts. Rebuild the preview around those existing records without adding live integrations.
- One writer fills roles 1, 6, 7, and 8 sequentially: shared contracts/root scripts first, analytics second, frontend third, verification/docs last. No concurrent file owners or generated-binding changes are needed.
- The user's new visual requirements replace the old `UI.md` palette/layout: Times New Roman, black and white, short plain-language text, no emoji or em dash, and the name Scrap Saver. Navigation has Dashboard, Menus, Schedule, and Settings. There is no right sidebar or closing summary card.
- Trend buckets are daily only. Lookbacks are 1, 7, 30, and 90 calendar days inclusive of the selected end date. The chart and downloadable daily records identify synthetic data and missing coverage.
- Today/week/month cards show an arithmetic mean of eligible plate percentages. Each nonempty plate uses its total eligible remaining area divided by its total compatible serving baseline area. A confirmed successful clean plate contributes 0% to this plate average, without inventing any menu-item servings or baselines. Failed, review, invalid, contradictory, and incomplete plates are excluded. The existing serving area-weighted `wastePercent` remains separate and unchanged.
- Food labels resolve menu display names; internal IDs stay internal. A readable slug fallback supports legacy IDs such as `item_hall-main_2026-10-03-lunch+margherita-flatbread`.
- Schedule recommendations are selected by calendar date and meal, grounded in the same day's demo records, and labeled as demo suggestions. Missing data produces no recommendation. Daily evidence and its source replace filler.
- Settings support disjoint recurring day-of-week schedules plus named dated events, including additional meals. A dated event replaces the recurring schedule for that date. Settings are validated and saved in this browser only; no backend settings persistence exists yet. Editing meal times does not reassign historical demo captures.
- Manual menu edits are saved locally and displayed in Menus. They do not silently rewrite the fixture menu/baseline context used for historical calculations. No menu connection or mock success is shown.

## 2026-10-03: wasted-serving metrics and measurement research (primary metric superseded)

- The user replaces the primary percentage-wasted reporting with "total servings wasted". Their explicit exception is recommendations, which use mean percentage wasted conditional on waste being present. These requirements supersede the earlier metric priorities when implementation proceeds.
- Camera-location and conveyor-placement work is deferred. This assignment researches measurement methods suitable for uploaded/replayed images and records requirements; it does not implement new dashboard or provider behavior.
- Working interpretation for research: total servings means the sum of fractional standard-serving equivalents, so four quarter-portions count as one serving. This interpretation needs to be made explicit in the implementation contract; it does not mean the count of plates with leftovers or complete meals.
- The conditional recommendation mean is calculated per menu item over successfully assessed positive-leftover observations. Unknown, failed, and unmeasurable observations remain excluded with visible counts; absent food is not evidence of a known zero-waste serving. A small-residue threshold remains to be specified.
- The percentage denominator remains an open implementation decision. With only a standard-portion reference, the available quantity is percent of a standard serving remaining. Percent of an individual's original serving requires that original amount to be known. Recommendations must name the denominator actually used and show their sample size.
- Measurement proposals and primary-source findings are recorded in `docs/measurement-research.md`. Calibrated reference photographs are a proposed first experiment, not a selected or verified production measurement method. No physical mass conversion, Gemini model selection, or acceptable error threshold is approved by this research alone.
- Existing synthetic fixtures and calculations have not been recalculated by this assignment. Update their contracts and historical metric labels deliberately when implementing the new definitions.
