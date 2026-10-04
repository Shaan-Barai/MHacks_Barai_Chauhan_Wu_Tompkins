# Demo walkthrough

Audience: dining-hall staff or hackathon judges. Goal: show the full Scrap loop (camera → R2 +
SpacetimeDB `scrap` → Gemini + SAM → pixels and relative impact → dashboard) without overstating what
the numbers mean.

**Quickest path:** `python3 demo.py` (or `python3 demo.py --simulate` without the board) runs every
step below in order and pauses between them, so you can narrate. The script below is what to say.

## Before you start

1. Start the stack: `deploy/local.sh up` ([deploy.md](deploy.md)) starts SpacetimeDB, the SAM worker on
   :8790, and the backend serving the dashboard on :8787 in production mode (also at
   https://<your domain> once the Cloudflare Tunnel runs). Writes then need `SCRAP_INGEST_TOKEN`, which demo.py reads from `.env` or
   `deploy/.run/local-secrets.env`. The dev setup in [runbook.md](runbook.md#start-full-stack-r2--scrap--gemini--sam)
   (frontend on :5173) works too. Run `cd backend && npm run seed -- --live-dinner` once: it seeds the 26-food dinner menus
   (2026-10-01..03 and today), demo portions, and leaves old analyses on the menu version they used.
2. Decide which capture path you will show:
   - **Real camera:** the Uno Q with the C920s (`capture/uno-q/README.md`, [BRIDGE.md](../BRIDGE.md)) into
     today's dinner (`svc_hall-main_<today>_dinner`). These dishes are labeled `camera`.
   - **No board:** `npm run simulate-camera`. It writes real `test2/` plate photos into the same inbox layout
     the board uses. These dishes are labeled **`replay`**, so don't call them live camera captures.
3. Keep the copy honest:
   - **Pixels wasted** is the measurement: pixels inside AI-drawn masks of the leftover food on the
     scanned plate.
   - **Grams, kg CO2e and litres of water are estimates.** They exist only for captures analysed with
     an active **camera calibration** (a credit card of known area on the tray; [calibration.md](calibration.md)).
     They come from `area = pixels × cm²/px` and per-food weight factors (area method only; there is
     no volume). Otherwise they show "—", never 0. Never show dollars.
   - **Relative impact points** weigh pixels by each food's density and environmental factors
     (`points = pixels / 1000 × weight_g_per_cm2 × factor`; CO2 points, water points, and impact points
     from 0.19·C + 1.50·W). They are unitless and only compare foods with each other: a pixel of beef
     counts for more than a pixel of rice.
   - **Nutrition points** are a separate number and never part of the impact score.
   - **Portions served are demo values.**

## Script (about 6 minutes)

### 1. Context (30 s)

> A camera above dish return photographs each finished plate. Gemini names the leftover foods from
> tonight's menu, boxes them, and marks which plate is the one being scanned. SAM 2.1 draws a mask for
> each food and for that plate; our code drops food on other plates, clips the masks to the scanned
> plate, and counts the pixels. Per-food factors turn pixels into relative impact points.

### 1b. Camera calibration (1 min)

`python3 demo.py --only calibration` shows the hall's active calibration. With none active, it offers to
take one: the credit card under the board, or the **synthetic** card fixture with `--simulate`.

> We lay a credit card, 46.21 cm², on the tray. The AI finds it and counts its pixels: about 38,000. So
> one pixel is about 0.0012 cm². From the camera's focal length that also says the camera hangs about
> 45 cm above the tray, which we can check with a tape measure. Focus is locked, because autofocus would
> change the scale. If the camera moves, we recalibrate.

Point out k and the camera height, and check the height against a tape measure. A wrong height means
the card was not fully segmented: retake the frame.

### 2. Capture (1.5 min)

Real board: `python3 capture/uno-q/laptop_capture.py --target arduino@BOARD --auto`, plus the bridge
in `--watch` mode for `svc_hall-main_<today>_dinner` (see [BRIDGE.md](../BRIDGE.md)).

No board: one command writes 3 photos and runs one bridge pass.

```bash
cd capture
npm run simulate-camera -- --count 3 --service svc_hall-main_2026-10-03_dinner --state-dir /tmp/scrap-demo-state
```

Point out:

- Each photo is published into the inbox all at once: a `<uuid>/photo.jpg` and a `metadata.json` with a
  checksum, written to a hidden folder and then renamed. The bridge re-checks the checksum.
- The bridge asks Gemini whether consecutive frames show the same plate, so each physical plate becomes
  one capture.
- `✓ dish … → cap_… (succeeded)`: the photo is normalized to 1024², uploaded to **R2** through a short-lived
  upload URL, and registered in SpacetimeDB. The backend then runs Gemini (2 localization passes + target
  dish) → SAM → target-dish clip → pixel count → overlay. That takes about 15–20 s per plate locally.
- Run the same command again and nothing new is ingested: each dish is counted once.

### 3. Neighbouring plates (30 s)

If a second plate is in the frame, open its capture's overlay: food on the other plate is drawn as
excluded, and the attempt carries `neighbor_food_excluded`. That plate gets counted when it is the
centered plate in its own capture. If the scanned plate can't be found, nothing is clipped and the
attempt carries `target_dish_unavailable` instead.

### 4. What is stored where (1 min)

- **R2 holds the bytes:** the normalized photo, one mask PNG per food, and the segmented overlay JPEG.
- **SpacetimeDB `scrap` holds references only.** For example:
  `spacetime sql --server local scrap "SELECT object_key, provider, association_kind FROM image_object"`.
  `image_object` is a private table, so you need the owner identity.
  - `capture_event`, `analysis_attempt`, `capture_count` (counting rule `target-dish-v1`),
    `segmentation_region`, `food_measurement` hold the pixel counts; `attempt_calibration` holds the
    overlay's object ID (its calibration column stays empty in v2).
  - Points are never stored: analytics derives them from pixels when the dashboard asks.
  - No image bytes are stored there.

### 5. Dashboard (2 min)

Open http://localhost:5173 and choose the dinner dates.

1. **Headline cards:** total Pixels wasted and the relative impact points, labeled relative, plus
   **Estimated CO2e** (kg) and **Estimated water** (L) with coverage ("from 1 of 7 calibrated plates").
   Plates analysed before the calibration have no estimate. Food labels show
   `38 g · 1.1 kg CO2e · 18 L water (est.)`, and the overlay legend carries the same suffix.
   `python3 demo.py --only area,stats --events cap_…` prints the same numbers in the terminal.
2. **Foods to target:** ranked by **pixels wasted per portion served** (sum of pixels ÷ sum of portions;
   the portions are demo counts).
3. **Most wasted:** ranked by total pixels. Items without an impact factor show "no impact factor",
   never 0.
4. **Nutrition** is a separate labeled note, not part of the impact score.
5. **Plates:** toggle each plate between the original photo and the segmented overlay. The legend shows each
   food's color and any excluded neighbour food.

### 6. AI recommendation (1 min)

Read the **AI recommendation** card. Its bullets cite numbers shown on the dashboard (pixels per portion,
impact points). It mentions how few plates were analyzed and doesn't claim a cause. If Gemini is
unavailable, the card says it is a **rule-based fallback**.

### 7. Honesty (30 s)

- A failed or partial segmentation is shown as unavailable, never as zero waste.
- Food that isn't on the menu goes into a separate bucket ("Food not on the menu"). It is never assigned to
  a menu item and has no per-portion rate.
- Pixel counts are exact for the mask; the mask itself is an AI estimate. Plates at different distances
  from the camera are not size-corrected.

## Reference runs

- 2026-10-03 (v1 pipeline, `scrap-bigplan`, retired): three `test2` photos through `simulate-camera`,
  413,044 px in total. Its gram and dollar figures came from the old plate calibration and are no longer
  reported. See [verification-report.md](verification-report.md).
- v2 live results (`scrap`, target-dish counting, the real Uno Q) are recorded in
  [verification-report.md](verification-report.md) when they are run.
- 2026-10-04 (IT_4, synthetic card calibration, k = 0.001213 cm²/px, 44.9 cm): a test2 plate gave
  Vegetable Stir Fry Blend 91,894 px → 111.4 cm² · 89 g and Sticky Rice 74,900 px → 90.8 cm² · 145 g,
  totalling 0.30 kg CO2e and 138 L water (estimates; iPhone photo, not the calibrated C920s).

## After the demo

Record anything that diverged in [verification-report.md](verification-report.md). Coordinate fixes
with the owning agent; Agent 8 does not edit feature modules.
