# Run 6 report (`run6`, 2026-10-30)

**Gemini was out of prepaid credit for the whole run.** Every request came back immediately with:

```text
{"error":{"code":402,"message":"Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing. Learn more at https://ai.google.dev/gemini-api/docs/billing#prepay. ","status":"RESOURCE_EXHAUSTED"}}
```

- **Tasks 1 and 2 could not be done.** Task 3 was done without Gemini, using clearly labeled stand-in masks.
- I didn't add credit (a billing action on your account) and I didn't look for other keys.

**Secret scan clean:**
- 360 commits on all branches, plus every commit message.
- 0 matches for any `.env` key value or the database password.
- The pattern hits are the same known fixtures and `process.env` reads as in Run 5, and none are in Run 6's changes.
- So `run6` was pushed. No PR, no merge, `main` untouched.

| Commit | What |
|---|---|
| `00ab6ce` | Task 1: the blocked confirmation run, documented in `docs/detection-accuracy.md` |
| — | Task 2: nothing to commit (not attempted) |
| `c4c3021` | Task 3: Nutrition5k weight test, `docs/weight-accuracy.md`, new `weight` suite in `./test-all.sh` |
| (this) | Report |

`./test-all.sh` passed before every commit: data 41, vision 106, analytics 83, capture 66, backend 133, frontend 141, tests 26, python 70, forecast 90, **weight 10 (new)**, scripts 31.

## 1. What got done, and what didn't

| Task | Result |
|---|---|
| 1. Confirm the timeout fix | **Not done: Gemini HTTP 402.** The run sent all 24 requests (12 photos × 2 passes). Each failed in 0.1–0.4 s with `GEMINI_BILLING`, with no tokens and no detections. The Run 5 projection (18/0/1) **stays labeled a projection**. `docs/detection-accuracy.md` gained a "Run 6" subsection saying so, with the exact commands to run. |
| 2. Thinking-cap experiment | **Not done** (same cause; I didn't send its requests). **The default is unchanged:** model-default thinking, plus the 1,024 cap only on a retry after a timeout. |
| 3. Nutrition5k weight test | **Done, with one substitution:** the masks come from a colour + depth heuristic → SAM 2.1, not Gemini → SAM. Everything else is as briefed: download, skipped ingredients, sourced pixel → cm² conversion, 50/50 split with seed 42, CSV vs. measured factors, and the depth check. Write-up: `docs/weight-accuracy.md`. |

**Exact errors:**
- **Task 1 runner:**
  - `ANALYSIS PROVIDER UNAVAILABLE: captures fail until it is fixed; ...` with code `GEMINI_BILLING`, on every photo.
  - Then `[detect] run 1: 0 correct, 0 missed, 0 wrong over 0 photos → recall n/a, precision n/a`.
  - Raw: `images/live-test/detect-20261030T223952/runs.json`.
- **Provider message:** the 402 JSON above, captured with one probe.
- **Recheck at 18:54 EDT, before this report** (1 request): still 402.
- **In Task 3, without Gemini:**
  - Our pipeline's own masks were not produced on Nutrition5k.
  - Mixed plates were not tested: without classification, a mask can't be split between foods.
- **My first two mask heuristics were bad.** The first took the background or the plate on 20 of 70 dishes. The second removed real food pieces. Both were caught on overlays and fixed before any error was computed. The third is the one used.

## 2. Decisions made on your behalf

All 13 are in `docs/PROGRESS.md` → Run 6 → "Decisions made on my behalf". The main ones:

1. **No billing action, no other keys:** I stopped Gemini work after the first refused run.
2. **Task 3 used stand-in masks** rather than waiting for Gemini:
   - SAM 2.1 at its default settings, with boxes from colour + depth instead of Gemini.
   - The dishes are single-food (one food ≥ 85% of visible grams), so no classification was needed.
   - Labeled "stand-in" and "Nutrition5k full plates, not leftovers" everywhere.
3. **Pixel → cm²:**
   - 35.9 cm (paper §4.4) with Intel's D435 RGB FOV (69.4° × 42.5°), giving f = 617.2 px and 3.384 × 10⁻³ cm² per pixel.
   - The paper's own figure is 5.957 × 10⁻³ (1.76× larger, method not stated). I report the effect of using it.
4. **Sample:**
   - 7 food types with a clear match in our CSV, 10 dishes each (70, not 60, so each type splits 5/5). Seed 42.
   - At most one dish per physical plate (scans < 300 s apart = one plate).
5. **12 of 70 dishes excluded** after looking at every overlay, **before computing errors:**
   - bowls (8), glass dishes (2), a whole-plate mask (1), 2 missed tomatoes (1);
   - reasons are in `images/nutrition5k/out/excluded.json`;
   - results with them included are reported too.
6. **Scale grams = all visible grams** (the mask covers every visible food). Oils, sauces and seasonings under 10 g were skipped: olive oil 14 dishes, salt 9, pepper 8, mustard 1, vinegar 1.
7. **New offline `weight` suite** in `./test-all.sh`: 10 unit tests for selection, split, geometry and metrics.

## 3. Gemini calls

**26 requests sent out of 180, all refused (HTTP 402).** None returned tokens, so none were billed as model use.

| Task | Requests | What |
|---|---|---|
| 1 | 24 | 12 photos × 2 passes, all refused |
| 1 | 1 | Probe to read the provider's exact error |
| 2 | 0 | Not attempted |
| 3 | 0 | Stand-in masks (SAM only) |
| Report | 1 | Recheck before writing; still 402 |

## 4. Measured detection numbers and timing table

**No new measurement:** Task 1 is blocked.

These are the latest measured numbers (Run 5, unchanged; 12 photos, 23-food menu, `gemini-3.8-flash`, seed 42):

| | correct | missed | wrong | recall | precision |
|---|---|---|---|---|---|
| Run 5 Step A (measured, before the fix) | 17 | 1 | 1 | 94.4% | 94.4% |
| With the fix (**PROJECTED**, not measured) | 18 | 0 | 1 | 100% | 94.7% |
| Run 6 confirmation | — | — | — | **not measured (HTTP 402)** | — |

| Seconds (Run 5 Step A) | avg | median | fastest | slowest |
|---|---|---|---|---|
| Pass 1 | 21.7 | 18.8 | 8.3 | 63.1 |
| Pass 2 (11 photos; IMG_2706 timed out) | 33.3 | 37.7 | 11.3 | 49.0 |
| SAM | 0.5 | 0.5 | 0.3 | 0.7 |
| Total (11 photos) | 34.7 | 38.4 | 14.9 | 50.0 |

The Run 6 column of this table is empty: every request ended in 0.1–0.4 s with a 402. That says nothing about speed.

## 5. Thinking-cap recommendation

**No recommendation: nothing was measured.**
- Per your rule, the default stays as it is: the model's own thinking on the first try, and a 1,024 cap only when retrying a timed-out request.
- The only evidence remains Run 5:
  - an 8,192 cap on every request changed nothing;
  - one 1,024-capped pass 2 on IMG_2706 answered in 14 s and found the pie.
  - That's one request, not a comparison.

Once credits are added, from `tests/` with the SAM worker running (about 27 calls each):

```bash
RUN_LIVE=1 node --env-file=../.env live/detection-runs.mjs --runs 1 --max-gemini 30 --exclude-items 'Halal Rice,Tomatoes,Lettuce'
GEMINI_THINKING_BUDGET=1024 RUN_LIVE=1 node --env-file=../.env live/detection-runs.mjs --runs 1 --max-gemini 30 --exclude-items 'Halal Rice,Tomatoes,Lettuce'
```

## 6. Nutrition5k weight results

**Nutrition5k full plates, not leftovers. Stand-in masks, not Gemini.**

31 test dishes, 7 food types. Factors fitted on 27 other dishes. Details and per-food tables: `docs/weight-accuracy.md`.

| Estimate on the test half | MAE (g) | MAPE | Bias (g) | Without greens (29): MAE / MAPE |
|---|---|---|---|---|
| (a) area × **our CSV factors** | 35.8 | 45% | −1.6 | 35.9 g / 37% |
| (b) area × **factors measured** on the fit half | **20.4** | **33%** | +5.4 | **18.9 g / 22%** |
| (c) **depth** volume × density measured on the fit half | 24.7 | 38% | +0.9 | 22.6 g / 26% |

- **The CSV factors are the weakest link.**
  - Per food they are off by +53% (sweet potato: CSV 2.0 vs. measured 1.45 g/cm²) to −56% (brussels sprouts: 0.5 vs. 0.92; ours is for *shaved* sprouts).
  - Their overall bias is near zero only because these errors cancel.
  - Measured factors roughly halve the error.
- **Depth did not beat area overall** (24.7 vs. 20.4 g). It won only on cauliflower (15.7 vs. 23.4 g).
- **Greens fail every method** (+160% to +220%), on 2 light test dishes.
- **The camera's scale matters as much as the factors:** with the paper's per-pixel area, the CSV route's error becomes MAE 78 g / MAPE 101%. Measured factors aren't affected, because they are fitted through the same conversion.
- **With the 12 excluded dishes put back:** CSV 39.6 g, measured 34.6 g, depth 33.1 g. Bad masks in the fit half pull the measured factors off.
- **Limits:**
  - 2–5 dishes per food per half;
  - single-food plates only;
  - not our camera, not leftovers, not our pipeline's masks;
  - nothing measured in deep bowls.
  - Treat the measured factors as first measurements, not replacements for the CSV.

## 7. What to check first

1. **Add Gemini credit** (AI Studio → your project → billing). Everything Gemini-based is blocked until then, including the live product: captures fail with `GEMINI_BILLING`, and `backend/scripts/retry-failed.mjs` re-runs them after.
2. **Then run Tasks 1 and 2** with the two commands in §5 (about 54 calls).
3. **Then the Gemini → SAM version of Task 3:**
   - the 58 kept dishes with their visible foods as the menu, through `MaskAnalyzer`;
   - about 116 calls;
   - not written yet, because it couldn't be tested. See `docs/weight-accuracy.md` → "What was not done".
4. **The factors CSV:**
   - sweet potato (2.0) and the sprouts factor (0.5, shaved) look wrong for whole pieces;
   - tomatoes (0.8) read low.
   - Decide whether to replace them with measured values after a test on your own camera and real leftovers. I didn't change the CSV.
5. **Look at a few overlays** (`images/nutrition5k/out/overlays/`) to judge the stand-in masks yourself.
