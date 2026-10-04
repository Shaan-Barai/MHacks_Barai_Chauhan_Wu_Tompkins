# Known limitations

Honest boundaries for the hackathon prototype (BIG-PLAN v2 + IT_4, database `scrap`). Update as modules land.

## Product

- **Pixels wasted is the stored measurement.** It counts pixels inside AI-drawn masks of visible
  leftover food. It is not weighed mass. There is no plate-size calibration (plates come in several
  sizes) and no dollars.
- Pixel counts are not size-corrected: the same food looks larger on a plate closer to the camera. Keep
  the camera height fixed and compare captures from the same setup.

### Estimated grams, CO2e and water (IT_4 camera calibration, [calibration.md](calibration.md))

- Grams, kg CO2e and litres of water are **estimates** from a camera calibration (a reference object of
  user-entered area gives cm² per pixel) times per-food factors. Nobody has weighed any food. They are
  null without an active compatible calibration, factor or density, never 0.
- **Area method (default):** `area = pixels × k` treats food as a flat layer on the tray. Plate rims,
  food height and perspective near the frame edge are ignored. `weight_g_per_cm2` is a typical spread,
  not a measured one.
- **Depth Anything V2 metric depth on food is unvalidated.** On close top-down phone photos (test2/,
  22–30 cm), DAv2 Metric Indoor Small read distances 3–5× too far (`depth_scale_disagrees`) and put food
  at or below the plate surface. Every food fell back to area (`negative_heights_clipped` +
  `depth_invalid`). The calibration scale fixes only the global factor, not local error. The volume
  method stays **off by default** until a live check under the mounted C920s, with an object of measured
  volume, is recorded.
- **Thin foods** (rice spread flat, sauces, crumbs) are millimetres high, at or below depth noise. Their
  volumes are noise even when depth works.
- **Bowls and liquids:** the bowl floor is hidden, so soup volume is unknown (`bowl_volume_unreliable`,
  grams by area). Top-down area is a weak proxy for liquid weight in any case.
- **Autofocus:** the C920s autofocus changes the focal length. `uno_q_camera.py` locks focus with
  `v4l2-ctl` (best effort). If `v4l2-ctl` is missing or the control fails, the capture proceeds with a
  warning and `focus.lock != "locked"` in its metadata, and its estimates may be off.
- **Nominal C920s intrinsics:** f ≈ 1360 px at 1920 wide comes from the 78° diagonal FOV spec, not a
  checkerboard calibration. It affects the camera heights and the DAv2 footprint. It does not affect the
  area method's cm² (k comes from the reference directly). Override with `CAMERA_FX_PX`/`CAMERA_FY_PX` if
  measured.
- A calibration holds for one camera, height, focus and resolution. Moving any of them needs a new one.
  The CLI cannot detect that the camera moved.
- The only calibration photo in the repo is **synthetic** (a drawn card). No real credit-card frame
  from the C920s has been taken yet.
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
- The "production" stack is the team Mac (`deploy/local.sh`, [deploy.md](deploy.md)): reads are public,
  mutations need `SCRAP_INGEST_TOKEN` (bridge, scripts, demo.py) or an admin session (dashboard). A public
  custom domain via Cloudflare Tunnel is documented but not set up. `demo.py --only deploy` warns while
  `SCRAP_PROD_URL` is unset.
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
