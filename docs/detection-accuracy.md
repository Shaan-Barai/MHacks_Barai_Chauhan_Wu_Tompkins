# Detection accuracy (measured 2026-10-28)

This page records what was measured, on what, and with which settings, because these numbers will be cited. "Detection" means: **which menu foods the pipeline says are on the scanned plate**, scored against a hand-labeled list. It does not score pixel counts or mask quality.

## Headline (REAL photos, current pipeline, current 26-food test menu)

| | correct | missed | wrong | recall | precision |
|---|---|---|---|---|---|
| Run 1 | 17 | 1 | 4 | 94.4% | 81.0% |
| Run 2 | 17 | 1 | 4 | 94.4% | 81.0% |
| Run 3 | 17 | 1 | 4 | 94.4% | 81.0% |
| **Mean (range)** | | | | **94.4% (94.4–94.4%)** | **81.0% (81.0–81.0%)** |

- **Run-to-run variation was zero.** All 3 runs returned the same foods on every photo. The gateway sends a fixed seed (42) with temperature 0, so with these settings the result is reproducible, not a lucky or unlucky draw.
- The live run of 2026-10-25 (the one first scored at 94.4% / 81.0%) gave the same detections.
- The base is small: 12 scored photos with 18 labeled foods, from one dining hall's dinner, labeled by our team. One photo changes recall by 5.6 points.

**Recall** = correct ÷ (correct + missed): the labeled foods the pipeline found. **Precision** = correct ÷ (correct + wrong): the foods it reported that were really there.

## Timing and the pass 2 timeout (Run 5, 2026-10-29)

Same 12 photos, the 23-food menu of that dinner, `gemini-3.8-flash`, seed 42, temperature 0, 2 passes, 90 s timeout, 2 retries. In memory, with no Supabase or R2 writes (`tests/live/detection-runs.mjs`).

**How the times were taken:**
- Every Gemini attempt is timed inside the gateway (`onCall`). Each pass's time runs from its first try to the end of its last. SAM requests are timed separately. A photo's total is the wall clock of the whole ingest.
- **The two passes are sent at the same time** (`Promise.allSettled`; measured on every photo), so a photo takes about as long as its slower pass plus about 1 s.
- **Request settings:** no `maxOutputTokens`, and **no thinking setting (the model's default)**. JSON schema output. The image is the normalized 1024 × 1024 JPEG.

### Per-pass times (seconds; timeouts listed, not averaged)

| | Step A: before (model default), 12 photos | | | | Attempt 1: thinking cap 8192 on every request, 11 photos | | | |
|---|---|---|---|---|---|---|---|---|
| | avg | median | fastest | slowest | avg | median | fastest | slowest |
| Pass 1 | 21.7 | 18.8 | 8.3 | 63.1 | 21.3 | 17.0 | 7.2 | 61.5 |
| Pass 2 | 33.3 | 37.7 | 11.3 | 49.0 | 31.8 | 35.4 | 11.7 | 49.1 |
| SAM | 0.5 | 0.5 | 0.3 | 0.7 | 0.4 | 0.4 | 0.3 | 0.7 |
| Total | 34.7 | 38.4 | 14.9 | 50.0 | 33.3 | 36.5 | 14.7 | 50.5 |

- **Timeouts:**
  - Step A, pass 2: 1 of 12 timed out (IMG_2706, 3 tries × 90 s = 271.5 s). That photo is left out of the pass 2 and total rows.
  - Attempt 1, pass 2: 1 of 11 timed out, IMG_2706 again (3 × 90 s).
  - Attempt 1 stopped before IMG_2707 at its call cap.
- **Accuracy:**
  - Step A: 17 correct, 1 missed (the IMG_2706 pie), 1 wrong (IMG_2703 + Sticky Rice); recall 94.4%, precision 94.4%. This is identical to Run 4.
  - Attempt 1: the same detections on the 11 photos it ran (15/1/1 over 11).
- **What the time depends on (attempt 1, 10 photos, both passes finished):**
  - It follows **thinking tokens**: correlation 0.87 for pass 1 and 0.74 for pass 2.
  - It follows the number of boxes (0.43 / 0.34) and answer tokens (0.43 / 0.37) only weakly.
  - It does **not** grow with the number of labeled foods (−0.22 / 0.00).
  - Typical passes think 450–2,900 tokens and answer 130–1,800 tokens, with 1–27 boxes.
- **Pass 2 takes about 1.9× as long as pass 1** (median of the per-photo ratios), even with similar token counts. For example, IMG_2701 took 10.3 s vs. 19.6 s at 868 vs. 846 thinking tokens. The two requests differ only by the one close-up line and are sent together. I did not find why.

### Per photo (Step A times, plus tokens from attempt 1)

| Photo | Labeled foods | Pass 1 s | Pass 2 s | SAM s | Total s | Pass 1 thinking / answer tokens, boxes | Pass 2 thinking / answer tokens, boxes |
|---|---|---|---|---|---|---|---|
| IMG_2695 | 2 | 14.8 | 11.3 | 0.6 | 16.2 | 790 / 1,296, 19 | 604 / 1,038, 18 |
| IMG_2696 | 1 | 15.6 | 41.7 | 0.3 | 42.4 | 1,482 / 195, 2 | 2,686 / 195, 2 |
| IMG_2697 | 3 | 19.7 | 39.9 | 0.6 | 41.4 | 1,332 / 1,748, 26 | 1,948 / 1,028, 23 |
| IMG_2698 | 2 | 17.9 | 35.6 | 0.7 | 37.2 | 1,174 / 1,164, 17 | 864 / 1,814, 27 |
| IMG_2699 | 2 | 14.4 | 27.9 | 0.5 | 29.1 | 859 / 1,036, 15 | 784 / 1,028, 15 |
| IMG_2700 | 1 | 22.6 | 47.8 | 0.6 | 49.2 | 1,777 / 1,305, 19 | 2,111 / 1,364, 20 |
| IMG_2701 | 1 | 11.5 | 20.9 | 0.3 | 21.6 | 868 / 198, 2 | 846 / 200, 2 |
| IMG_2702 | 1 | 21.1 | 37.7 | 0.3 | 38.4 | 2,152 / 199, 2 | 1,348 / 197, 2 |
| IMG_2703 | 1 | 31.2 | 49.0 | 0.4 | 50.0 | 2,892 / 775, 11 | 1,471 / 780, 11 |
| IMG_2704 | 1 | 8.3 | 14.3 | 0.3 | 14.9 | 552 / 132, 1 | 448 / 131, 1 |
| IMG_2706 | 1 | 63.1 | **timed out** (3 × 90) | 0.4 | 272.4 | 7,707 / 258, 3 | — (timed out) |
| IMG_2707 | 2 | 20.5 | 40.7 | 0.5 | 41.8 | not run in attempt 1 | not run in attempt 1 |

**Step A's own token and box counts were lost:** the runner crashed after scoring, before writing its results (`ReferenceError: Cannot access 'stat' before initialization`; fixed). Its times survive because each was printed as the photo finished. The token columns therefore come from attempt 1, which sent the same request plus a thinking cap that none of these photos reached (all ≤ 2,892 thinking tokens < 8192). Attempt 1's times match Step A's within a few seconds.

### Cause of the IMG_2706 timeout: runaway thinking

**Diagnostic:** IMG_2706 alone, both passes, a 300 s timeout and no retries (2 calls):

| | Thinking tokens | Answer tokens | Boxes | Time | Finish |
|---|---|---|---|---|---|
| Pass 1 | 7,707 | 258 | 3 | 64.9 s | STOP |
| Pass 2 | **28,718** | 199 | 2 | **227.6 s** | STOP |

- Given 228 s, pass 2 **found the pie**: 1 correct, 0 missed, 0 wrong on that photo.
- It is **not** runaway output (199 answer tokens), **not** too many boxes (2), and **not** the image size (1024²).
- It **is** unbounded thinking. With the fixed seed, an identical retry thinks just as long, so all 3 tries time out.
- **The fallback exists.** When one pass fails, the other pass's boxes are used alone. But pass 1's answer on this photo has no pie on the scanned plate, so the pie was missed only because pass 2 never finished.

**Attempt 1: a general cap of 8192 thinking tokens on every request did not help.**
- IMG_2706's pass 2 still timed out 3 × 90 s.
- The other photos never come near 8192, so nothing else changed (same detections, similar times).

**Probe: the same pass 2 request with thinking capped at 1024** (`tests/live/pass-probe.mjs`, 1 call). It answered in **14.0 s** with 172 answer tokens (no thinking tokens reported), finish STOP. It found the **Chocolate Coconut Cream Pie on the scanned plate**, plus two pieces on another dish.

### Fix (applied)

- **A timed-out image → JSON request is retried with thinking capped at 1024 tokens** (`vision/src/gateway.ts`; `GEMINI_TIMEOUT_RETRY_THINKING_BUDGET`, default 1024; `off` = identical retries). Tests: `vision/test/gateway.test.ts`.
- **First attempts keep the model's default thinking**, exactly as in Step A, so the 11 photos that never time out are unchanged. Their measured results are the Step A rows above.
- The general cap from attempt 1 is not the default. It remains available as an option (`GEMINI_THINKING_BUDGET`, unset).

**Not measured end to end:** the full pipeline on IMG_2706 with this retry. That run needs 3 calls (pass 1, a pass 2 that times out, then the capped retry), and Task 1 had 2 left of its 55.
- What is measured is that the exact retry request returns in 14 s with the pie.
- Expected result: IMG_2706 scores 1 correct (the pie; extras on this photo are never wrong), so 18 correct, 0 missed, 1 wrong overall (recall 100%, precision 94.7%). **This is a projection, not a measurement.**
- Expected time on IMG_2706: 90 s (the timed-out first try) + 0.5 s backoff + about 14 s, so about 105 s instead of 272 s.

**Gemini calls for this section:** 26 (Step A) + 2 (diagnostic) + 24 (attempt 1) + 1 (probe) = **53**.

## Per-meal menu (Run 4, 2026-10-28)

**Question:** in a real hall the pipeline knows which meal a photo comes from, so it should offer only that meal's foods. What happens to the score when each photo gets only its own meal's menu?

### What the records say about where each photo came from

| Record | Hall | Meal | Station |
|---|---|---|---|
| `images/ground_truth.csv` | not recorded | not recorded | not recorded |
| Photo files (`test2/IMG_2695–2707.jpeg`, EXIF creation time) | not recorded | **all 12 taken 2026-10-03 between 19:47:57 and 19:53:55 local time: one dinner service** | not recorded |
| Test menu (`data/src/seed/generate.ts`, `factors/`) | "the test dining hall's dinner menu" (East Quad factor files) | dinner | per food (e.g. Halal, Pizziti), but no photo is linked to a station |

- **Meal: recorded.** All 12 photos come from one 6-minute window of one dinner, so they share one meal menu. No grouping had to be guessed.
- **Station: not recorded anywhere.** A per-station menu would need a photo → station column in `ground_truth.csv` (or a station field on the capture). I did not infer stations from the labeled foods: that would use the answer to choose the menu.
- **That dinner's menu: 23 foods.** On the night of the photos the repo's dinner menu was the 22 dishes on the hall's nutrition sheet plus Baked Sweet Potatoes: the dinner factor table (today `factors/menu_waste_factors_EastQuad.csv`) was uploaded at 20:14 that evening (`97e7864`), and the 2026-10-03 experiment used it. Halal Rice, Tomatoes and Lettuce were added at 03:04 the next morning (`4f23615`) "for the live demo". None of the three is on the hall's sheet, and nothing records them as served on 2026-10-03.

### Result: each photo given its own meal's (23-food) menu

| Menu offered to the pipeline | Runs | Correct | Missed | Wrong | Recall | Precision |
|---|---|---|---|---|---|---|
| 26-food demo menu (Run 3; the live test's menu) | 3 (identical) | 17 | 1 | 4 | 94.4% | 81.0% |
| **23-food menu of that dinner (Run 4, current pipeline)** | **1** | **17** | **1** | **1** | **94.4%** | **94.4%** |
| 23-food menu, 2026-10-03 experiment (older pipeline) | 2 | 36 (of 2 × 18) | 0 | 3 | 100% | 92.3% |

Same 12 photos, ground truth, scoring rules and settings as the Run 3 runs (model `gemini-3.8-flash`, seed 42, temperature 0, 2 passes, `GEMINI_TIMEOUT_MS=90000`). The script was `tests/live/detection-runs.mjs --runs 1 --exclude-items 'Halal Rice,Tomatoes,Lettuce'`: in memory, with no Supabase or R2 writes. Raw output (gitignored): `images/live-test/detect-20261028T220417/runs.json`.

### Per photo

| Photo | Labeled | 26-food menu (Run 3, every run) | 23-food menu (Run 4) |
|---|---|---|---|
| IMG_2695 | Stir fry, Sticky Rice | correct | correct |
| IMG_2696 | Cheese Pizza (any pizza) | + **Cheese Bread** (1 wrong) | correct |
| IMG_2697 | Ham, Cauliflower, Sweet Potatoes | correct | correct |
| IMG_2698 | Stir fry, Sticky Rice | correct | correct |
| IMG_2699 | Sticky Rice, Stir fry | correct | correct |
| IMG_2700 | Panzanella Salad | + **Lettuce** (1 wrong) | correct |
| IMG_2701 | 4 Bean Stew | correct | correct |
| IMG_2702 | Pepperoni Pizza | **Cheese Bread** instead (1 missed, 1 wrong) | correct |
| IMG_2703 | Stir fry | + **Halal Rice** (1 wrong) | + **Sticky Rice** (1 wrong; same as the 2026-10-03 experiment) |
| IMG_2704 | Pepperoni Pizza (any pizza) | correct | correct |
| IMG_2706 | Chocolate Cream Pie (+ unknown, extras not wrong) | correct | **pie missed** (1 missed): Gemini's second pass timed out on all 3 attempts (90 s each), and the first pass alone reported only Cheese Pizza |
| IMG_2707 | Cauliflower & Baked Potato | correct | correct |

- **Per-meal menus help precision here:** 4 wrong → 1, at the same recall. Three of the four Run 3 errors disappear: the two involving foods not served that night, and Cheese Bread on IMG_2702.
- **Cheese Bread also vanished from IMG_2696**, although it is on both menus. So part of the effect is that changing the menu list changes the fixed-seed answer, not only that extra foods attract detections. The runs do not separate the two.
- **IMG_2706 is a new miss, and it looks like a timeout effect, not a menu effect.** I re-ran IMG_2706 alone (4 calls) and got the same result: pass 2 timed out 3 times, the pie was missed, and Cheese Pizza was reported. With the 26-food menu, both passes finished and the pie was found.
- **One run, not three.** Run 3 found zero run-to-run variation with these settings, and the IMG_2706 re-run repeated exactly, but this menu was measured once. The base is still 12 photos with 18 labeled foods.
- **IMG_2703** gets an extra rice with both menus (Halal Rice or Sticky Rice). Re-checking whether rice is on that plate is still the open labeling question.

### Is "menu = the foods served at that hall/meal" the pipeline's default? Yes, already

In production, `IngestionService` resolves the menu from the capture's service (hall + date + meal) with `repo.getMenuByService(serviceId)`, and rejects a service from another hall (`backend/src/services/ingestionService.ts:172`). Gemini only ever sees that service's menu items. Nothing narrows further by station, since captures carry no station. **I made no code change:** the 26-food figure comes from the **test** menu, which includes three foods the hall did not serve that night. A hall that uploads each meal's real menu gets per-meal behavior today.

The live test (`tests/live/images.test.mjs`) still uses the 26-food demo menu, and its regression baseline stays the Run 3 measurement.

## Why it is lower than the "100% / 92.3%" recorded earlier

The 100% / 92.3% came from the 2026-10-03 experiment (`experiments/experiment_summary.csv`, git `b62ed8c`): 36 correct, 0 missed, 3 wrong over **2 runs × 12 photos**. Since then two things changed.

1. **The test menu grew from 23 to 26 foods.** Commit `4f23615` (2026-10-04) added Halal Rice, Tomatoes and Lettuce to the demo dinner, which the live test uses as its menu. **This is the main cause of the drop.** Three of the four errors involve the new foods or changed when they were added:
   - IMG_2700: an extra "Lettuce" detection (a new food).
   - IMG_2703: "Halal Rice" (a new food) where only stir fry is labeled. The experiment reported Sticky Rice there instead, which was also scored wrong.
   - IMG_2702: "Cheese Bread" instead of Pepperoni Pizza (1 missed + 1 wrong).

   **Confirmation run:** the same pipeline and settings on IMG_2700 and IMG_2702 with the 3 foods removed (the original 23-food menu). Result: Panzanella Salad only, and Pepperoni Pizza only. Both are correct: 2 correct, 0 missed, 0 wrong, 4 Gemini calls. IMG_2703 was not re-run (the Phase 2 budget was 100 calls).
   - **We did not separate the two possible mechanisms:** Gemini choosing a newly available food, or the menu list being renumbered so the same fixed seed produces a different answer. Either way, the gap is not random variation.
   - **A projection, not a measurement:** if IMG_2700 and IMG_2702 behave as in the check, and IMG_2703 still reports some rice as in the experiment, the current pipeline on the 23-food menu would give 18 correct, 0 missed, 2 wrong: 100% recall / 90.0% precision. That is close to the experiment's 92.3%.
2. **The pipeline changed** between the experiment and now: two Gemini localization passes merged by IoU (`fef1065`), target-dish counting (`639ce19`), the fixed Gemini seed (`4e0d55d`) and localization prompt v2 → v4. These are not shown to change detection on these photos. The remaining two errors (below) also appeared in the experiment.

**Unchanged:** the model (`GEMINI_MODEL = gemini-3.8-flash`, also used in the experiment), the ground truth (`images/ground_truth.csv` is identical to git `b62ed8c`), and the scoring rules (`tests/support/scoring.mjs`, a port of `vision/scripts/score-experiment.py` that reproduces the experiment's 36/0/3 exactly).

**What we changed:** nothing in the pipeline or the menu. Removing real menu foods to raise a score would be gaming the test. The live test's regression baseline (`tests/support/scoring.mjs`) is now the measured 26-food result above. The old 23-food figure is kept as `BASELINE_23_FOOD_EXPERIMENT`, labeled as not comparable.

## Per-photo errors (identical in all 3 runs)

| Photo | Labeled | Detected | Missed | Wrong | Note |
|---|---|---|---|---|---|
| IMG_2696 | Cheese Pizza (any pizza counts) | Cheese Pizza, **Cheese Bread** | 0 | 1 | Also seen in experiment run 1 |
| IMG_2700 | Panzanella Salad | Panzanella Salad, **Lettuce** | 0 | 1 | Gone with the 23-food menu |
| IMG_2702 | Pepperoni Pizza | **Cheese Bread** | 1 | 1 | Correct with the 23-food menu |
| IMG_2703 | Vegetable Stir Fry Blend | Vegetable Stir Fry Blend, **Halal Rice** | 0 | 1 | The experiment reported Sticky Rice here (also "wrong" against the label). Rice may be on the plate but unlabeled; worth re-checking the label |

The other 8 scored photos (IMG_2695, 2697, 2698, 2699, 2701, 2704, 2706, 2707) were fully correct in every run. IMG_2705 (pasta, not on the menu) is never scored.

## Exactly what was measured

- **Script:** `tests/live/detection-runs.mjs` (new). It runs the same path as the live image test, without the database or object storage:
  - replay upload → backend ingestion;
  - Gemini classify + boxes (2 passes);
  - SAM 2.1 hiera-small masks (local worker, MPS);
  - target-dish counting;
  - scoring.

  It uses an in-memory repository, a temporary folder for storage, and no recommendation call.
- **Settings:**
  - `GEMINI_MODEL=gemini-3.8-flash`, seed 42 (default), temperature 0, 2 passes (default), 2 retries (default);
  - **`GEMINI_TIMEOUT_MS=90000`**: the default is 30000, see below;
  - menu: the 26-food dinner from `factorDinnerItems()` with Gemini visible-component descriptions.
- **Scoring rules** (agreed 2026-10-03):
  - names are mapped to menu names;
  - on IMG_2696 and IMG_2704 any pizza counts;
  - IMG_2705 is not scored;
  - on IMG_2706 extra detections are not wrong;
  - detections under 1% of the plate's counted food pixels are ignored;
  - unclassified food is never a detection.
- **Raw outputs (gitignored):**
  - `images/live-test/detect-20261028T055315/runs.json` (3 runs);
  - `images/live-test/detect-20261028T061850/runs.json` (the 23-food check).

## Also found: Gemini timeouts at the default setting

The first attempt (default 30 s timeout) was stopped after 4 photos. IMG_2696 and IMG_2697 each failed both passes on `GEMINI_TIMEOUT` after 3 attempts (6 calls each) and would have been unscored. The 2026-10-25 live run also spent 5 calls on IMG_2696.

At 90 s, every photo succeeded. A few still needed a retry: IMG_2697 used 3, 5 and 3 calls in the three runs, against 2 for a photo with no retries. A timed-out photo is reported as failed, never as an empty plate. Still, in production a 30 s timeout drops scans or falls back to a single pass. **Applied in Run 4:** the default `GEMINI_TIMEOUT_MS` is now 90000 (`vision/src/gateway.ts`, checked by `vision/test/gateway.test.ts`). Even 90 s is not always enough: with the 23-food menu, IMG_2706's second pass timed out on all 3 attempts, twice (see "Per-meal menu").

## Gemini calls used for this page

Run 3: 16 (stopped first attempt) + 77 (3 runs) + 4 (23-food check) = **97**.
Run 4: 26 (23-food per-meal run) + 4 (IMG_2706 re-run) = **30**.
