# Demo walkthrough

Audience: dining-hall staff or hackathon judges. Goal: show the full Scrap loop (camera → R2 +
SpacetimeDB → Gemini + SAM → waste impact → dashboard) without overstating what the numbers mean.

## Before you start

1. Start the stack as described in [runbook.md](runbook.md#start-big-plan-demo-r2--scrap-bigplan). That means
   SpacetimeDB, the SAM worker on :8790, the backend on :8787 against `scrap-bigplan` with R2, and the
   frontend on :5173. The demo dinner menu (23 foods) and demo portions are seeded.
2. Decide which capture path you will show:
   - **Real camera:** the Uno Q with the C920s (`capture/uno-q/README.md`). These dishes are labeled `camera`.
   - **No board:** `npm run simulate-camera`. It writes real `test2/` plate photos into the same inbox layout
     the board uses. These dishes are labeled **`replay`**, so don't call them live camera captures.
3. Keep the copy honest:
   - **Pixels wasted** is the raw measurement: pixels inside AI-drawn masks of the leftover food.
   - **Grams, CO2e, water and $ are estimates.** They come from a plate-size calibration (26.7 cm plate)
     and per-food weight/impact factors.
   - **Portions served are demo values.** Nutrition lost is a separate number and is **not** part of the
     $ score.

## Script (about 6 minutes)

### 1. Context (30 s)

> A camera above dish return photographs each finished plate. Gemini names the leftover foods from
> tonight's menu and boxes them. SAM 2.1 draws a mask for each food, and our code counts the pixels.
> A plate-size calibration turns pixels into estimated grams, and per-food factors turn grams into
> CO2e, water and a dollar impact score.

### 2. Capture (1.5 min)

Real board: `python3 capture/uno-q/laptop_capture.py --target arduino@BOARD --auto`, plus the bridge
in `--watch` mode (see [BRIDGE.md](../BRIDGE.md)).

No board: one command writes 3 photos and runs one bridge pass.

```bash
cd capture
npm run simulate-camera -- --count 3 --service svc_hall-main_2026-10-03_dinner --state-dir /tmp/scrap-demo-state
```

Point out:

- Each photo is published into the inbox all at once: a `<uuid>/photo.jpg` and a `metadata.json` with a
  checksum, written to a hidden folder and then renamed. The bridge re-checks the checksum.
- `✓ dish … → cap_… (succeeded)`: the photo is normalized to 1024², uploaded to **R2** through a short-lived
  upload URL, and registered in SpacetimeDB. The backend then runs Gemini (2 localization passes) → SAM →
  pixel count → plate calibration → overlay. That takes about 15–20 s per plate locally.
- Run the same command again and nothing new is ingested: each dish is counted once.

### 3. What is stored where (1 min)

- **R2 holds the bytes:** the normalized photo, one mask PNG per food, and the segmented overlay JPEG.
- **SpacetimeDB holds references only.** For example, use
  `spacetime sql --server local scrap-bigplan "SELECT object_key, provider, association_kind FROM image_object"`.
  `image_object` is a private table, so you need the owner token.
  - `capture_event`, `analysis_attempt`, `food_measurement` and `attempt_calibration` hold the pixel counts,
    the plate calibration and the overlay's object ID.
  - No image bytes are stored there.

### 4. Dashboard (2 min)

Open http://localhost:5173 and choose 2026-10-03.

1. **Headline cards:** total waste (estimated g and pixels), CO2e, water, and waste impact $, all labeled
   estimates.
2. **Foods to target:** ranked by estimated grams wasted **per portion served** (the portions are demo
   counts).
3. **Most wasted:** ranked by total estimated grams. Items without an impact factor show "no impact factor",
   never 0.
4. **Nutrition lost** is a separate labeled note, not part of the $ score.
5. **Plates:** toggle each plate between the original photo and the segmented overlay. The legend shows each
   food's color.

### 5. AI recommendation (1 min)

Read the **AI recommendation** card. Its bullets cite numbers shown on the dashboard, for example
"Baked Sweet Potatoes: 1.4 g wasted per portion". It mentions how few plates were analyzed and doesn't
claim a cause. If Gemini is unavailable, the card says it is a **rule-based fallback**.

### 6. Honesty (30 s)

- A failed or partial segmentation is shown as unavailable, never as zero waste.
- Food that isn't on the menu goes into a separate bucket ("Food not on the menu"). It is never assigned to
  a menu item.

## Reference run (2026-10-03, live)

Three `test2` photos went through `simulate-camera` and the bridge into `scrap-bigplan` with R2. All
three succeeded with a `plate-fit-v1` calibration.

| Photo | Foods found | Est. waste |
| --- | --- | --- |
| IMG_2695 | stir fry and sticky rice | 93 g |
| IMG_2697 | sweet potatoes, cauliflower, ham, and 13.9k px of food not on the menu | 204 g |
| IMG_2701 | bean stew and cheese bread | 40 g |

Dashboard total: 413,044 px, about 337 g (estimated). The most-wasted food and the top food to target
were both Baked Sweet Potatoes. The recommendation came from Gemini. Details are in
[verification-report.md](verification-report.md).

## After the demo

Record anything that diverged in [verification-report.md](verification-report.md). Coordinate fixes
with the owning agent; Agent 8 does not edit feature modules.
