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

At 90 s, every photo succeeded. A few still needed a retry: IMG_2697 used 3, 5 and 3 calls in the three runs, against 2 for a photo with no retries. A timed-out photo is reported as failed, never as an empty plate. Still, in production a 30 s timeout drops scans or falls back to a single pass. **Recommendation, not applied:** raise `GEMINI_TIMEOUT_MS` to about 60–90 s for the scan pipeline.

## Gemini calls used for this page

16 (stopped first attempt) + 77 (3 runs) + 4 (23-food check) = **97**.
