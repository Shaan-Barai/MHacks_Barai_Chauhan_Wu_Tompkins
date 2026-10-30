# Weight accuracy: area × grams-per-cm² vs. a scale (Nutrition5k, Run 6, 2026-10-30)

> **Nutrition5k full plates, not leftovers.** Every number on this page comes from whole, untouched cafeteria plates photographed in a lab rig, weighed on a scale. None of it is from our dining hall, our camera, or leftover food.
>
> **The food masks are a stand-in, not our Gemini → SAM pipeline.** Gemini refused every request this run (HTTP 402, prepaid credits depleted; see "What was not done"). The boxes SAM received came from a colour + depth heuristic instead of from Gemini. SAM 2.1 ran with the pipeline's default settings (`sam2-box-v1`).

## Question

ScrapSaver turns Pixels wasted into **estimated** grams as `area (cm²) × weight_g_per_cm2`, using the per-food factors in `factors/menu_waste_factors_EastQuad.csv`. Those factors were never checked against a scale. This test checks them on plates whose foods were weighed, and asks two more things: does a factor measured on real plates do better, and does depth (volume) beat area?

## Data

**Nutrition5k** (Thames et al., "Nutrition5k: Towards Automatic Nutritional Understanding of Generic Food", CVPR 2021; Google, released under CC BY 4.0). Source: https://github.com/google-research-datasets/Nutrition5k, bucket `gs://nutrition5k_dataset`.
- **Downloaded (into the gitignored `images/nutrition5k/`):** `metadata/` (3 CSV files, 2.3 MB), `dish_ids/` (split lists), and `rgb.png` + `depth_raw.png` for 70 dishes from `imagery/realsense_overhead/` (about 41 MB in total). The 181 GB archive was **not** downloaded. Downloads went through the public `storage.googleapis.com` URLs (no `gsutil` on this machine).
- **Per dish:** a 640 × 480 overhead colour image and an aligned 16-bit depth image from an Intel RealSense D435, plus every ingredient's weight in grams.
- **I checked the depth/colour alignment by eye:** the plate's depth outline falls on the plate's colour outline in every dish I overlaid.

## Method

Code: `tests/weight/n5k.py` (selection, split, geometry, metrics; standard library, unit-tested in `tests/weight/test_n5k.py`, suite `weight` in `./test-all.sh`) and `tests/weight/n5k_image.py` (masks, areas, volumes, evaluation; numpy/scipy/Pillow from `.venv`).

```bash
.venv/bin/python tests/weight/n5k.py select && .venv/bin/python tests/weight/n5k.py download
.venv/bin/python vision/sam/worker.py &          # SAM 2.1 on :8790
cd tests/weight && ../../.venv/bin/python n5k.py masks && ../../.venv/bin/python n5k.py evaluate
```

### 1. Choosing dishes (fixed seed 42)

- **Pool:** cafe-1 dishes that have overhead depth (3,265 dishes).
- **Skipped ingredients:** oils, dressings, sauces and seasonings **under 10 g** (they aren't reliably visible from above). In the 70 sampled dishes these were: olive oil (14 dishes), salt (9), pepper (8), mustard (1), vinegar (1). Their grams are left out of the "scale grams" we compare against.
- **One dominant food per dish:** one ingredient had to be **≥ 85% of the remaining (visible) grams**. With no Gemini, there is no classification step, so the whole food mask can only be assigned to one food. Only 2 sampled dishes had a second visible ingredient (celery root, cherry tomatoes: each under 15%). Scale grams = all visible grams, since the mask covers all visible food.
- **Mapped food types** (Nutrition5k ingredient → our type → the CSV food it is compared with). Only clear matches were used:

  | Nutrition5k ingredient | Food type | CSV food (g/cm²) |
  |---|---|---|
  | brussels sprouts | brussels sprouts | Shaved Brussel Sprouts (0.5) |
  | cauliflower | cauliflower | Roasted Cauliflower (1.0) |
  | mixed greens | greens | Lettuce (0.3) |
  | cheese pizza, pepperoni pizza | pizza | Cheese Pizza / Pepperoni Pizza (1.0) |
  | potatoes, roasted potatoes | potatoes | Oven Roasted Garlic Potatoes (1.6) |
  | sweet potato, yam | sweet potato | Baked Sweet Potatoes (2.0) |
  | cherry tomatoes | tomatoes | Tomatoes (0.8) |

  Dominant foods with no CSV counterpart were not sampled; the most common were almonds (63 dishes), bacon (48), apple (45), carrot (44) and grapes (43). The full list is in `images/nutrition5k/out/sample.json`.
- **Sample:** 10 dishes per food type = 70, chosen with seed 42. Nutrition5k scans some plates repeatedly as food is added, and dish IDs are Unix timestamps, so scans less than 300 s apart count as one plate. At most one dish per plate was taken, so the same plate can't land in both halves.
- **Split:** 50/50 by dish ID within each food type (seed 42): 35 dishes for **fitting** the factors, 35 for **testing**.

### 2. Pixels → cm² (no plate-size assumption)

- **Distance:** 35.9 cm from camera to capture plane (paper §4.4, read at https://ar5iv.arxiv.org/html/2103.03375). The depth images agree: the plate floor measured 35.4–36.9 cm from the camera on the kept dishes (median depth, in the dataset's stated units of 1e-4 m).
- **Lens:** Intel's published RGB field of view for the D435 is 69.4° × 42.5° (± 3°) at 16:9 (https://www.intel.com/content/www/us/en/support/articles/000030385.html, and the D435 product page). The 640 × 480 image is the 4:3 centre of that sensor, so the vertical FOV applies: **f = 240 / tan(21.25°) = 617.2 px**.
- **One pixel at 35.9 cm = (35.9 / 617.2)² = 3.384 × 10⁻³ cm².** Area (cm²) = mask pixels × that.
- **The paper uses a different number:** 5.957 × 10⁻³ cm² per pixel at 35.9 cm (§4.4), 1.76× ours. It doesn't say how it was obtained. I used Intel's lens figures as the brief asked; the effect of the paper's number is shown below. It matters only for the CSV-factor estimates. The measured factors absorb any constant scale, because they are fitted and tested with the same conversion.

### 3. Food masks (stand-in for Gemini boxes)

For each dish (`tests/weight/n5k_image.py`):
1. **Plate** = the region under the image centre that is nearer than 39 cm in depth (the plate on the scale is about 36 cm away; the floor around it about 41 cm). Depth holes inside it are filled.
2. **Plate level Z0** = 85th-percentile depth of the plate's inner part.
3. **Food candidates:** pixels whose shading-independent colour (chromaticity) is far from the plate's colour, or strongly saturated. Also raised pixels (≥ 8 mm above Z0, away from the rim) that differ at least slightly in colour, which catches white foods like cauliflower.
4. **Region filters:**
   - regions under 150 px are dropped;
   - so are regions lying mostly (> 70%) in the outer 20 px of the plate;
   - so are regions whose average colour is within 0.04 of the plate's. Rim shading measured ≤ 0.035 and food ≥ 0.042 on the 22 dishes I checked.
5. **One box per remaining region → SAM 2.1.** Mask = union of SAM masks inside the plate. If SAM returns more than 2.5× its region (SAM took the plate), the region itself is used and the dish is flagged `sam_rejected`.

**Visual check, done before computing any errors:**
- I looked at an overlay of every dish (`images/nutrition5k/out/overlays/`).
- **12 of 70 were excluded** because the mask was plainly wrong:
  - deep bowls of greens: 5;
  - a glass dish on paper: 2;
  - steel bowls of tomatoes: 2;
  - a plain bowl: 1;
  - a mask covering the whole plate: 1;
  - 2 of 4 tomatoes missed: 1.
- Each one and its reason is in `images/nutrition5k/out/excluded.json`. All 12 are bowls or unusual dishes, so **this test says nothing about food in deep bowls.**
- **Left: 27 fit / 31 test dishes.** Results with the 12 included are shown under "Robustness".

### 4. Estimates on the test half

- **(a) CSV factor:** area × the CSV's `weight_g_per_cm2` for the mapped food.
- **(b) Measured factor:** area × k, where k = Σ(area·grams) / Σ(area²) over that food type's fit dishes (least squares through zero).
- **(c) Depth:** volume × a density fitted the same way on the fit half. Volume = Σ over mask pixels of (height above Z0) × (that pixel's own area at its own distance, (Z / f)²). Mask pixels with no depth get the mask's median height.

## Results (test half, 31 dishes; Nutrition5k full plates, not leftovers)

### Factors

| Food type | n fit | CSV g/cm² | **Measured g/cm²** | Measured density g/cm³ |
|---|---|---|---|---|
| brussels sprouts | 5 | 0.5 | **0.92** | 0.58 |
| cauliflower | 4 | 1.0 | **1.07** | 0.56 |
| greens | 3 | 0.3 | **0.34** | 0.22 |
| pizza | 5 | 1.0 | **0.80** | 0.54 |
| potatoes | 4 | 1.6 | **1.26** | 0.84 |
| sweet potato | 4 | 2.0 | **1.45** | 0.81 |
| tomatoes | 2 | 0.8 | **1.89** | 1.39 |

### Errors: estimated grams vs. scale grams

MAE = mean absolute error. MAPE = mean absolute % error. Bias = mean (estimate − scale); negative means it underestimates.

| Food type (n test) | (a) CSV: MAE g / MAPE / bias g | (b) Measured: MAE g / MAPE / bias g | (c) Depth: MAE g / MAPE / bias g |
|---|---|---|---|
| brussels sprouts (5) | 58.2 / 56% / −58.2 | 17.8 / 20% / −17.8 | 20.7 / 19% / −17.8 |
| cauliflower (5) | 23.3 / 26% / +2.5 | 23.4 / 29% / +10.0 | **15.7 / 21% / −2.2** |
| greens (2) | 34.9 / 161% / +34.9 | 42.1 / 191% / +42.1 | 55.2 / 219% / +55.2 |
| pizza (5) | 28.3 / 28% / +10.8 | **19.1 / 19% / −10.8** | 25.1 / 28% / −17.6 |
| potatoes (5) | 17.8 / 21% / +17.8 | **9.5 / 11% / −4.3** | 15.5 / 17% / −10.4 |
| sweet potato (4) | 52.3 / 53% / +52.3 | **10.6 / 11% / +10.6** | 17.5 / 18% / +3.3 |
| tomatoes (5) | 38.6 / 42% / −38.6 | **31.4 / 38% / +31.4** | 39.9 / 49% / +28.8 |
| **Overall (31)** | **35.8 / 45% / −1.6** | **20.4 / 33% / +5.4** | **24.7 / 38% / +0.9** |
| Overall without greens (29) | 35.9 / 37% / −4.1 | **18.9 / 22% / +2.9** | 22.6 / 26% / −2.9 |

The test dishes weighed 9–192 g (scale), mostly 50–120 g.

### What this says

1. **Factors measured on real plates beat our CSV factors:** the overall MAE drops from 35.8 g to 20.4 g, and MAPE from 45% to 33% (22% without greens).
   - The CSV factors are far off for some foods: sweet potato reads +53% (CSV 2.0 vs. 1.45 measured) and brussels sprouts −56% (0.5 vs. 0.92). The CSV's 0.5 is for *shaved* sprouts; these were whole.
   - For tomatoes the CSV is −42%. The measured tomato factor rests on only 2 fit dishes and still misses by 38%.
2. **The CSV factors' overall bias is near zero (−1.6 g), but only because opposite errors cancel.** Per food they are off by +53% to −56%. A near-zero total says nothing about any one food.
3. **Depth did not beat area overall:** MAE 24.7 g vs. 20.4 g. It won only for cauliflower (15.7 vs. 23.4 g), the tallest, most irregular food here. The depth camera's holes (missing pixels) and the plate-level estimate add error. On this data, area × a measured factor is the better simple method.
4. **Greens are not measurable this way:** both test dishes were light (15 g and 38 g) leaves spread thin, and every method was off by 160–220%. The sample is 2 dishes.
5. **Scale uncertainty dominates the CSV route:** with the paper's per-pixel area (5.957 × 10⁻³ cm²) instead of Intel's lens figures, the CSV estimates become 1.76× larger. Their overall error grows to MAE 78.2 g, MAPE 101%, bias +68.6 g (+90%). So the CSV route is only as good as the camera calibration. The measured factors don't have this problem, because they are fitted through the same conversion they are used with. Our hall camera's calibration (the card method, `docs/camera-calibration-checklist.md`) measures its own scale, so it is not affected by which of these two numbers is right.

### Robustness: all 70 dishes, no exclusions

When none are excluded, 65 dishes have a non-empty mask (32 fit / 33 test). Overall:
- (a) CSV: MAE 39.6 g, MAPE 49%, bias +1.9 g;
- (b) measured: 34.6 g, 46%, −24.6 g;
- (c) depth: 33.1 g, 46%, −21.6 g.

The bad masks (bowls) mostly hurt the measured factors, because a wrong mask in the fit half shifts the factor. The ranking between (b) and (c) flips here, so the "depth doesn't help" finding holds only for plates with good masks.

## Limits (read before quoting any number)

- **Full plates, not leftovers.** Leftovers are thinner, smeared, mixed and partly eaten. Grams per cm² of leftovers can differ a lot from a served portion's (e.g. a half-eaten potato vs. a whole one).
- **Not our pipeline's masks.** The masks are a colour + depth heuristic refined by SAM, built because Gemini was unavailable. Our real pipeline (Gemini boxes + SAM) may mask better or worse. Our real pipeline also normalizes images to 1024²; here SAM saw the native 640 × 480.
- **Not our camera or our hall.** The rig is a lab setup at a fixed 35.9 cm, with depth. Our hall camera is a webcam at 43–45 cm without depth.
- **Small samples:**
  - 2–5 test dishes per food, and 2–5 fit dishes per factor;
  - tomatoes: 2 fit dishes; greens: 2 test dishes.
  - One odd dish moves a food's numbers a lot. Treat the per-food factors as rough first measurements, not replacements.
- **Single-food plates only.** Dishes were chosen so one food is ≥ 85% of the visible grams, because without Gemini nothing could split a mask between foods. Mixed plates were not tested.
- **12 of 70 dishes excluded** after looking at the masks (before computing errors): all bowls, glass dishes or a missed segmentation. Nothing here covers deep bowls.
- **The camera scale is uncertain:** Intel's lens spec (± 3°) and the paper's per-pixel area disagree by 1.76×. I used Intel's, as the brief asked. This affects only the CSV-factor comparison (see point 5).
- **Food types are approximate matches:** whole roasted brussels sprouts vs. our "Shaved Brussel Sprouts", plain potatoes vs. "Oven Roasted Garlic Potatoes", and so on.
- **Depth:** the RealSense images have holes (missing pixels), filled with the mask's median height. The plate level is a percentile estimate. Food overhanging the plate edge is measured against the plate floor.
- **One split, one seed.** A different split would move the per-food numbers. No confidence intervals were computed; with n ≤ 5 per food they would be wide.

## What was not done

- **Our pipeline (Gemini → SAM) was not run on these dishes.**
  - Every Gemini request this run returned `402 RESOURCE_EXHAUSTED: Your prepayment credits are depleted`.
  - With credits restored, the next step is to send each kept dish's visible foods as the menu through `MaskAnalyzer` (as `tests/live/detection-runs.mjs` does). Then re-run `evaluate` on those masks. That costs about 2 calls per dish, so about 116 calls for the 58 kept dishes.
  - Not written yet, because it could not be tested.
- **No multi-food plates** (see Limits).

## Files

- `images/nutrition5k/out/sample.json`: the 70 dishes, split, skipped ingredients, mapping (gitignored).
- `images/nutrition5k/out/measurements.json`: per-dish mask pixels, area, plate level, volume and flags.
- `images/nutrition5k/out/excluded.json`: the 12 excluded dishes and their reasons.
- `images/nutrition5k/out/weight_results.json`: factors, errors, and per-dish estimates for the test half.
- `images/nutrition5k/out/overlays/`: one overlay per dish (green = mask, blue = plate outline, red = boxes).

Dataset credit: Nutrition5k, Google Research, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Thames, Karpur, Norris, Xia, Panait, Weyand, Sim, CVPR 2021.
