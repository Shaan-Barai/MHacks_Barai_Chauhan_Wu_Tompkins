# Known limitations

Honest boundaries for the hackathon prototype (BIG-PLAN v2, database `scrap`). Update as modules land.

## Product

- **Pixels wasted is the only measurement.** It counts pixels inside AI-drawn masks of visible leftover
  food. It is not weighed mass, volume, cost, or carbon. There is no plate-size calibration (plates come
  in several sizes), so the prototype reports no grams, kg CO2e, litres or dollars.
- Pixel counts are not size-corrected: the same food looks larger on a plate closer to the camera. Keep
  the camera height fixed and compare captures from the same setup.
- **Relative impact points** (`pixels / 1000 × weight_g_per_cm2 × factor`) are unitless. They only rank
  foods against each other (beef weighs more than rice). Nutrition points are separate and never in the
  impact score.
- **Target-dish counting** depends on Gemini picking the right plate (the most centered, most fully
  visible one). Food on other plates is dropped and the remaining masks are clipped to the plate's
  region. If the plate can't be found, nothing is clipped and the attempt is flagged
  `target_dish_unavailable`, so neighbouring food may be counted.
- Attendance is **simulated** in a configurable range; it is not meal-swipe data. Portions served in the
  seed are **demo** counts.
- One camera, manual or `--auto` capture; no conveyor trigger. The bridge's same-dish check (Gemini)
  decides when a new plate arrives; an `unsure` answer merges frames, so a dish can be missed rather than
  counted twice.
- Gemini confidence is **not** calibrated measurement accuracy.

## Architecture

- Images go to Cloudflare R2 (`OBJECT_STORAGE_PROVIDER=r2`); `local-dev` (backend filesystem) remains for offline runs and tests.
- SpacetimeDB runs locally (standalone); no hosted deployment. Reducers have no caller auth: the backend is the only intended client on a trusted machine.
- Schema changes are published additively in place. `menu_item` holds only the live menu version;
  superseded items live in `menu_item_revision`. Items replaced before that table existed (the 10-03
  version-1 items in `scrap`) are gone, so old measurements for them show an unresolved item.
- The dashboard reads through the backend API (polling on navigation), not live SpacetimeDB subscriptions.
- Upload to object storage and SpacetimeDB registration are **separate** steps, not one atomic transaction.

## Verification

- CI proves fixture/unit agreement only (no key or database in CI).
- The v1 live E2E (2026-10-03) used `simulate-camera` with real phone photos (`test2/`); see
  verification-report.md. The v2 live run on the real Uno Q waits for Gemini billing (HTTP 402).
- A handful of photos is not an accuracy measurement. A hand-annotated set with a held-out split is still
  required (MVP_AI.md).
- Agent 8 reports defects; feature owners fix their own modules.

## Data / privacy

- Do not commit real diner photos, swipe records, or API keys.
- Treat menu text and model output as untrusted input.
