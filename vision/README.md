# vision — Agent 4: Gemini classification and waste measurement

Self-contained Node 20 + TypeScript package. Turns a capture image plus its
menu context into a contract-valid `AnalysisAttempt` + `FoodMeasurement[]`
in **pixels** (see `contracts/types.ts`; AGENTS.md §7 math is canonical),
counting only the dish being scanned (BIG-PLAN v2, target-dish counting), and
owns the server-side Gemini gateway that Agent 6 reuses for suggestions.
Pixels stay the measurement. IT_4 adds an optional **camera calibration**
(`calibration.ts`) and a **physical stage** (`area.ts`): calibrated area
(cm²) per food, always labeled an estimate.
Grams, CO2e and water are derived from these by `analytics/`, not here.

```
vision/
  src/
    maskPipeline.ts analyzeCaptureWithMasks(): the measurement path (below)
    localize.ts     Gemini prompt v4: numbered menu, per-piece boxes, target dish
    targetDish.ts   dish region (box cut, speck removal, convex-hull fill, dilation) + clip
    masks.ts        box conversion, mask validation, smallest-first pixel counting
    overlay.ts      segmented overlay JPEG (pixel legend + optional per-food suffix)
    samClient.ts    SAM 2.1 worker client (vision/sam/)
    calibration.ts  IT_4 camera calibration (reference-area-v1, C920s intrinsics, geometric height)
    area.ts         IT_4 calibrated area (area-calibrated-v1), pure
    gateway.ts      Gemini transport (live/mock, timeout, bounded retries, ApiError)
    dishMatch.ts    same-dish judgment for the capture bridge
    prompt.ts       menu sanitizing + legacy classification prompt
    validate.ts / measurement.ts / analyze.ts / leftovers.ts   legacy/research helpers
    image.ts        bytes / read-URL -> Gemini inline-data formatting
    contracts.ts    copy of consumed contracts/types.ts types
  sam/                      Python SAM 2.1 worker (:8790) + requirements.txt
  scripts/                  live smoke + research scripts (real Gemini calls)
  fixtures/responses.json   canned model responses (mock mode + tests)
  test/                     node --test suite (fixtures and fakes only, no live calls)
```

## Legacy usage (`analyzeCapture`, Gemini area estimates; not the measurement path)

```ts
import { createGeminiGateway, analyzeCapture } from '@scrap/vision';

const gateway = createGeminiGateway(); // reads env; mock mode if no key

const { attempt, measurements } = await analyzeCapture(gateway, {
  eventId: 'cap_01J9ABCD',
  attemptId: 'att_01J9ABCE01',
  image: { kind: 'bytes', bytes, mimeType: 'image/jpeg' },
  // or: { kind: 'url', url: temporaryReadUrl } from Agent 5's storage adapter
  geometry: { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1', plateDiameterPx: 900 },
  menu: { menuId, menuVersion, items },     // MenuItem[] for this hall/date/service only
  baselines,                                 // ReferencePortion[] from Agent 2
  estimateMissingBaselines: false,           // opt-in Gemini baseline estimates
});
```

- `attempt.status` is `'succeeded' | 'needs_review' | 'failed'`. Failures and
  invalid model output are explicit (`attempt.error` is a contracts `ApiError`)
  and produce **no** measurements — never silent zero waste.
- Every measurement has `method: 'gemini_area_estimate'` and the `ai_estimate`
  flag. Missing/invalid baseline ⇒ no percentage + `unavailableReason` +
  `missing_baseline`. `rawWasteFraction` is preserved unclamped; above 1 it is
  flagged `above_baseline` (display percent capped at 100) and the attempt is
  marked `needs_review`. Baselines estimated by Gemini (either a
  `ReferencePortion` with source `gemini_estimate` or an opt-in in-response
  estimate) carry `gemini_estimated_baseline`.
- Unknown/non-menu food becomes a measurement with `itemId: null` and
  `unavailableReason: 'unknown_item'`; empty plates succeed with the
  `empty_plate` flag and zero measurements (an empty plate does not prove which
  items were served).

### Reusable text generation (Agent 6)

```ts
const text = await gateway.generateText(prompt, {
  systemInstruction, temperature, maxOutputTokens, timeoutMs,
});
```

Transport only: normalized errors (`GatewayError.apiError`), timeout, and
bounded retries. Suggestion prompts and business logic stay in `analytics/`.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | _unset_ | Server-side only. **Unset ⇒ mock mode.** |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Model id passed to `@google/genai`. |
| `GEMINI_TIMEOUT_MS` | `30000` | Per-request timeout (AbortSignal). |
| `GEMINI_MAX_RETRIES` | `2` | Bounded retries after the first attempt (retryable errors only). |
| `GEMINI_RETRY_BASE_DELAY_MS` | `500` | Exponential backoff base (500, 1000, …). |
| `GEMINI_PASSES` | `2` | Localization passes per capture (`1` or `2`); equals the Gemini calls per capture. |
| `SAM_WORKER_URL` | `http://127.0.0.1:8790` | SAM 2.1 worker (`vision/sam/`). |
| `SAM_TIMEOUT_MS` | `60000` | Per-request SAM worker timeout. |
| `WORKER_TOKEN` | _unset_ | Sent as `X-Worker-Token` to the SAM worker (it requires it when its own `WORKER_TOKEN` is set). |
| `CAMERA_FX_PX` / `CAMERA_FY_PX` | _unset_ | Measured focal lengths (px at the calibration image's resolution) via `intrinsicsOverridesFromEnv()`; source `checkerboard`. |

All options can also be passed to `createGeminiGateway()` directly; explicit
options win over env.

## Mock mode

When `GEMINI_API_KEY` is unset (or a `mockTransport` is injected), the gateway
never touches the network. The default mock returns a valid empty-plate
classification and clearly labeled fixture text; tests inject responses from
`fixtures/responses.json`. Mock output is never presented as a live result.

## Prompt versioning

The measurement path stamps `LOCALIZE_PROMPT_VERSION` (currently
`scrap-localize-v4`, `src/localize.ts`; `+closeup` for two passes) on every
`AnalysisAttempt` together with the model id, the menu version, the SAM
model/settings, and the counting rule (`target-dish-v1`). The legacy
`analyzeCapture` uses `PROMPT_VERSION` (`scrap-classify-v1`, `src/prompt.ts`).
Bump a version whenever its prompt text or response schema changes
meaningfully, so stored results remain traceable.

Untrusted-input handling: menu names/descriptions are sanitized (control
characters/backticks stripped, length-capped) and embedded as fenced JSON data
with an instruction that the block is data only; the response schema constrains
`itemId` to the supplied menu IDs; and `validate.ts` re-checks everything
(shape, allowed IDs, finite non-negative areas, duplicate assignment, total
area vs. plate area) before any measurement is computed.

## Running tests

```sh
cd vision
npm install
npm test   # tsc build + node --test dist/test/*.test.js
```

All fixture-driven (no credentials needed, no live Gemini or SAM calls).

## Classification → segmentation → Pixels wasted (`analyzeCaptureWithMasks`)

The measurement path (contracts/measurement.md, MVP_AI.md, BIG-PLAN v2 §7):

```ts
const r = await analyzeCaptureWithMasks(gateway, createSamWorkerClient(), {
  eventId, attemptId,
  image: { bytes, mimeType: 'image/jpeg' },     // the normalized capture (1024² center crop)
  geometry: { widthPx: 1024, heightPx: 1024, coordinateSpace: 'topdown-normalized-v1' },
  menu: { menuId, menuVersion, items },         // this hall/date/service only
  geminiPasses: 2,                              // optional; default env GEMINI_PASSES, else 2
  renderOverlay: true,                          // optional, default true
});
r.attempt;       // AnalysisAttempt with `segmentation` (regions, countStatus, capturePixelsWasted)
r.measurements;  // FoodMeasurement[] (method 'mask_pixel_count', remainingAreaPx = pixels)
r.masks;         // [{ regionId, png }] counted region masks (after the dish clip) to store
r.itemMasks;     // [{ measurementId, png, count }] exclusive per-bucket masks (back maskCount)
r.targetDish;    // TargetDishInfo (below)
r.overlay;       // { jpeg, widthPx, heightPx, mimeType: 'image/jpeg', version: 'overlay-v2' } | null
r.diagnostics;   // { overlayError? }
r.localization;  // { passes, geminiCalls, passBoxes, failedPasses, mergedBoxes }
```

1. **Gemini (`localize.ts`, prompt `scrap-localize-v4`).** One structured
   call per pass returns `{ target_dish, pieces }`. The **target dish** is the
   plate or bowl being scanned: the one most centered and most fully in frame
   (the camera is overhead), with `dish_type`, a 0–1000 `box_2d` around its
   rim, and `fully_visible`. Each piece has `ingredient`, `menu_id` (1..N from
   the numbered menu `n. name — visible components`, 0 = no match), a
   per-piece `box_2d` (each carrot slice / pepper strip / floret; rice one box
   per clump), and `on_target_dish`. The prompt states: *"Count food only on
   the target dish. Food on other plates, bowls, trays or the table belongs to
   other dishes and must be marked as not on the target dish. Each dish is
   counted in its own photo."* Menu text is sanitized and declared data, not
   instructions. Gemini never reports quantities. A v3 bare-array answer is
   still accepted (no target dish; every piece counts as on it).
2. **Two passes (default, `fef1065`).** Pass 2 adds a "look closely at mixed
   piles" line; both run in parallel. Boxes from both passes are merged: where
   two overlap by IoU > 0.5 they are one piece and the smaller box (with its
   on/off-dish mark) is kept (`d24ce1b`). The target dish comes from pass 1
   (pass 2 if pass 1 has none); `targetDish.passAgreementIoU` reports how well
   the two passes agree. **Gemini calls per capture = passes (2 by default)**;
   the old separate plate-box call is gone (it was 3).
3. **Other-dish food is dropped.** Boxes marked `on_target_dish: false` become
   skipped regions with `error.code = 'OTHER_DISH'` (`details.reason =
   'other_dish'`). They never count toward any item or the capture total.
4. **SAM 2.1, one request** (`samClient.ts`): target-food boxes, other-dish
   boxes (for the overlay and diagnostics only), and the target-dish box, on
   the same image (one embedding; split into 128-box chunks only if needed).
   Masks are validated: exact size, strictly 0/255, nonempty, count matches.
5. **Target-dish clip (`targetDish.ts`, `dish-region-v3`).** The SAM dish
   mask is cut to the Gemini dish box plus a margin (max(dilation, 5% of the
   box's longer side)), so a mask that bled onto a neighbour cannot grow the
   region. Specks are dropped, but **every significant piece is kept**
   (≥ max(0.05% of the frame, 2% of the largest piece)): a fork or food lying
   across the dish splits the dish mask into several large pieces. The
   **convex hull** of those pieces fills the holes food leaves in the dish mask
   and the rim notches where food crosses the rim (plates and bowls are
   convex). Then it is **dilated by max(2, round(1% of the longer image side))
   px = 10 px on 1024²** (square). The region must cover 2–95% of the frame
   and at least 50% of the frame-clamped dish box (a round dish fills ~78%).
   Every food mask is clipped to it; a mask left empty becomes a skipped region
   `OUTSIDE_TARGET_DISH`. **No dish, no valid dish mask, SAM failure, or an
   implausible/incomplete region ⇒ no clipping, attempt flag
   `target_dish_unavailable`, counts kept.**
6. **Counting rule `target-dish-v1`** (`COUNTING_RULE_VERSION`): steps 3 and 5,
   then `smallest-first-v1` (`masks.ts countPixels`): smallest masks claim
   their pixels first, every pixel goes to at most one bucket (menu item or
   the unclassified bucket), capture total = union of the clipped masks = sum
   of the buckets.
7. **Overlay (`overlay.ts`, `overlay-v2`).** The analyzed image at its own
   size: counted food tinted per item (fixed colour per menu position,
   unclassified grey), not-counted other-dish food hatched neutral grey, the
   target dish outlined in cyan (or its Gemini box dashed amber when no region
   was usable). Legend in pixels only: `Pixels wasted N px (AI masks) · target
   dish outlined`, one `food: N px` line per item, and `Other dish (not
   counted): N px`. `sharp` loads lazily; failure gives `overlay: null` +
   `diagnostics.overlayError`.

### Target-dish result fields (stable)

| Field | Meaning |
| --- | --- |
| `targetDish.found` | Gemini named a target dish with a usable box |
| `targetDish.dishType`, `fullyVisible`, `box` | `plate` / `bowl` / `other`, rim cut off or not, `RegionBox` (Gemini 0–1000 + pixel XYXY) |
| `targetDish.passAgreementIoU` | IoU of the two passes' dish boxes (two-pass, both found) |
| `targetDish.clipApplied` | food masks were clipped to the dish region |
| `targetDish.clipUnavailableReason` | `no_food`, `not_found`, `bad_target_dish`, `bad_dish_type`, `legacy_array`, `dish_box_invalid`, `segmentation_failed`, `dish_mask_invalid`, `dish_mask_empty`, `region_too_small`, `region_too_large`, `region_incomplete` |
| `targetDish.regionPx`, `dilatePx` | dish region size and dilation (px) |
| `targetDish.excludedBoxes` | food boxes Gemini placed on another dish (after the merge) |
| `targetDish.otherDishPx` | not-counted food pixels outside the target dish (other-dish masks + clipped-off pixels, minus counted pixels) |
| `targetDish.clippedPx` | target-food mask pixels the clip removed (part of `otherDishPx`) |

Persistable without schema changes: `attempt.qualityFlags` carries
`neighbor_food_excluded` (other-dish boxes were dropped, or the clip removed
≥ 0.1% of the frame) and `target_dish_unavailable`; excluded boxes are
`segmentation.regions` with `segmentationStatus: 'skipped'` and error code
`OTHER_DISH` / `OUTSIDE_TARGET_DISH`. Neither flag excludes a capture from
aggregates. The two flag values are **pending in `contracts/types.ts`**;
until the coordinator adds them, vision emits them via the exported
constants `NEIGHBOR_FOOD_EXCLUDED` / `TARGET_DISH_UNAVAILABLE`.

### Stage outcomes

- Classification failure (every pass failed/invalid): `failed`,
  `countStatus: 'unavailable'`, no SAM call. One failed pass falls back to
  the other.
- Explicit empty plate (every usable pass returned no pieces): `succeeded`,
  `empty`, 0 px, `empty_plate`, no SAM call.
- All food on other dishes: `succeeded`, `empty`, 0 px, `empty_plate` +
  `neighbor_food_excluded` (a real zero for this dish; the neighbour counts
  in its own capture).
- All target food clipped away (Gemini and the clip disagree): `needs_review`,
  `empty`, 0 px.
- Some masks invalid: `needs_review`, `partial` (lower bound). Worker down /
  every mask invalid: `failed`, `unavailable`. Never silently zero.
- `calibration` is no longer produced (BIG-PLAN v2, V1); the `calibration`
  input option is accepted and ignored for compatibility.

`analyzeCapture` (Gemini-guessed areas) and `assessLeftovers`
(counts/percents) remain as legacy/research helpers, not the measurement path.

## Countable vs uncountable leftovers (`assessLeftovers`)

`assessLeftovers(gateway, { image, labels })` (`src/leftovers.ts`) follows the
team spec: for each food, Gemini (1) classifies it with one of the supplied
labels, (2) decides from that classification whether the leftovers are
**countable** (separate pieces, e.g. fries) or **uncountable** (one portion
eaten into, e.g. a burger), then (3) returns a **piece count** for countable
food or the **percent of a whole serving remaining** for uncountable food.
The schema orders the fields so the countable decision comes first; output
mixing count and percent, unknown labels, non-integer counts, or percents
outside 0–100 is rejected (`VISION_INVALID_RESPONSE`, retryable). The model
receives only the image and the labels.

Blind live check (`npm run eval:leftovers [runs]`): reads a local `images/`
folder at the repo root (gitignored — evaluation photos are not committed),
re-encodes each image without metadata, shuffles them under anonymous ids,
and compares the answers with the file names afterwards.

**2026-10-03, `gemini-3.8-flash`, 5 images × 3 runs:** label and
countable/uncountable decision correct 15/15; answers stable across runs.

| File (never sent) | Gemini (3 runs) |
| --- | --- |
| burger50 | uncountable, 80 / 80 / 78 % left |
| burger60 | uncountable, 80 / 75 / 78 % left |
| burger90 | uncountable, 88 / 88 / 85 % left |
| fries10 | countable, 13 / 13 / 13 left |
| fries20 | countable, 27 / 25 / 26 left |

If the file-name numbers are % remaining and fry counts, burger90 is close
but burger50/60 read ~20–30 points high and are not told apart; fries are
overcounted by ~30%. By eye, fries10 shows about 13 fries, so the labels may
be approximate. Not yet wired into the backend pipeline or dashboard.

## Live target-dish check (2026-10-04)

`node --env-file=../.env scripts/target-dish-smoke.mjs <outDir> [images]`
(needs `GEMINI_API_KEY` and the SAM worker). Defaults: `test2/IMG_2697` and
`IMG_2701` (both have neighbouring plates in frame) normalized like capture
(1024² center crop), the demo dinner menu with Gemini descriptions, two-pass
localization. Prints the target dish, whether the clip applied, other-dish
boxes/pixels, counted pixels per food and the Gemini calls used; writes
`<name>_overlay.jpg` + `results.json`. `MAX_GEMINI_CALLS` (default 2 per
image + 1) aborts a runaway run.

Run on 2026-10-04 (`GEMINI_MODEL` from `.env`, SAM 2.1 Small on MPS, 2 Gemini
calls per photo):

| Photo | Target dish | Other dish (not counted) | Counted (Pixels wasted) | vs ground_truth.csv |
| --- | --- | --- | --- | --- |
| IMG_2697 | plate (cut off), clip applied, region 686,220 px | 1 box, 13,918 px (Brussels sprouts on the neighbouring plate) | Sweet Potatoes 83,656; Roasted Cauliflower 77,338; Ham 28,802 = 189,796 | 3/3 correct, nothing extra |
| IMG_2701 | plate, clip applied (first run, `dish-region-v1`; the v2 region, checked SAM-only, is the full bowl, 595,990 px, and still contains the stew) | 1 box, 13,707 px (cheese bread on the neighbouring plate) | 4 Bean Stew 17,472 | 1/1 correct, nothing extra |

Before v2 these photos counted the neighbours' sprouts (13,919 px) and bread
(13,707 px). The first v2 run exposed a bug in `dish-region-v1` (kept only
the largest piece of the dish mask; on IMG_2697 the fork split the plate, so
the half-plate region clipped 216,760 px of real ham and sweet potato);
`dish-region-v2` keeps every significant piece and rejects regions under 50%
of the dish box; `dish-region-v3` also unions the ellipse inscribed in the dish box
(grown by the dilation), so a SAM dish mask that misses part of a tilted or
edge-touching bowl (IMG_2695, D1) cannot clip food Gemini put on the target dish. These are phone photos with several dishes in frame, not
images from the mounted camera.

`scripts/waste-impact.mjs <imagesDir> <../factors/menu_waste_factors_EastQuad.csv> [outDir]`
(research only) runs the same pipeline on a folder of photos and prints
pixels and **relative impact points** (`points = px/1000 × weight_g_per_cm2 ×
factor`; co2Points C, waterPoints W, impactPoints 0.19C + 1.50W;
nutritionPoints separate). Points are unitless, not grams, kg CO2e, litres or
dollars.

## Live smoke test

```sh
npm run smoke    # builds, loads ../.env, makes real Gemini calls
```

`scripts/smoke.mjs` checks: live mode; `generateText`; a short tip at
`maxOutputTokens: 220` finishes untruncated; `analyzeCapture` on a top-down
plate (default `capture/fixtures/replay/images/dinner-1003-salmon-rice.jpg`)
against the demo-seed menu and baselines; a bad key → `GEMINI_AUTH_FAILED`
without retries. Optional args: `[image.jpg] [serviceId]`.

**Last run: 2026-10-03, `gemini-3.8-flash`, all checks passed**
(recorded in `contracts/decisions.md`). Inputs were AI-generated synthetic
plates — this verifies the provider path, not measurement accuracy.

Live-run findings now handled in code: Google returns HTTP 400 for an invalid
key (mapped to `GEMINI_AUTH_FAILED`); text requests disable thinking
(`thinkingBudget: 0`) because thinking tokens count against
`maxOutputTokens`; a `MAX_TOKENS` finish is rejected as
`GEMINI_TRUNCATED_RESPONSE` rather than returning half an answer. An
above-baseline item no longer turns the attempt into `needs_review`: the
measurement carries `above_baseline` and aggregates exclude it, while the
plate's other items still count.

## IT_4: camera calibration and calibrated area

See [IT_4.md](../docs/plans/IT_4.md) §2 (I2, I3, I6, I8) and §10, and `contracts/types.ts` (IT_4 section).
Everything below is exported from `@scrap/vision`. Vision never computes grams, CO2e or water: the
backend gets those from `analytics/` and can pass legend text back through `labelSuffix`.

Depth Anything V2 (volume) was removed on 2026-10-04 (user decision): there is no depth worker,
depth client, volume method, plate plane or bowl rule any more. Legacy rows from the brief depth
trial are read as area estimates by the backend.

### Calibration (`calibration.ts`, method `reference-area-v1`)

```ts
const r = await runCalibration({
  imageBytes,                 // normalized EXACTLY like captures (1024² center crop today)
  mimeType: 'image/jpeg',     // optional
  knownAreaCm2: CREDIT_CARD_AREA_CM2,      // 46.21; any user value > 0
  referenceLabel: 'credit card',           // untrusted text, sanitized, sent as data
  gateway,                    // createGeminiGateway()
  sam: createSamWorkerClient(),
  intrinsicsOverrides: intrinsicsOverridesFromEnv(),   // optional
});
if (r.ok) {
  r.calibration;        // CalibrationFields = CameraCalibration minus calibrationId/hallId/cameraId/createdAt/
                        //   imageObjectId/overlayObjectId/referenceMaskObjectId/error, status 'succeeded'
  r.referenceMaskPng;   // binary PNG → referenceMaskObjectId
  r.overlay;            // { jpeg, ... } | null → overlayObjectId (association 'calibration_overlay')
  r.diagnostics;        // Gemini box/confidence, SAM score, raw mask px, box fill
} else {
  r.error; r.flags;     // ApiError + e.g. ['reference_not_found']; status 'failed'
}
```

1. Gemini (`scrap-calib-ref-v1`, 1 call) returns `{found, box_2d, confidence, fully_visible}`.
   The answer is validated strictly (`validateCalibrationText`).
2. SAM segments the box. `reference-mask-v1` cuts the mask to the box + 2%, drops specks, and
   takes the **convex hull**, so holes from glare or printing and a fork across the card are
   closed. The reference must be a flat, convex object such as a card, sheet of paper or coaster.
3. `k = knownAreaCm2 / N_ref`. Geometric camera height `Z = √(fx·fy) · √k`.
4. Flags: `reference_touches_edge` (mask on the border or Gemini says cut off),
   `reference_low_confidence` (Gemini low, SAM score < 0.85, fill < 35% of box, N < 1,000 px, or
   > 60% of the frame). `reference_not_found` fails the run.

`c920sIntrinsics(W, H, overrides?)`: nominal `f = (√(1920²+1080²)/2)/tan(39°) = 1360.2 px` at
1920×1080, scaled by `s = max(W/W0, H/H0)` for a center-crop-and-resize from the source frame
(`sourceFrame`, default 1920×1080). This gives **1289.7 px for the 1024² normalized capture**
and 906.8 px at 1280×720. Principal point at the centre, fx = fy. Source `nominal-fov`.
Overrides `fxPx/fyPx/cxPx/cyPx` give source `configured`, or `checkerboard` via
`intrinsicsOverridesFromEnv()`. **A plain W/1920 scaling would be wrong for the square crop.**

### Physical stage in the pipeline

```ts
const r = await analyzeCaptureWithMasks(gateway, sam, {
  ...input,
  physical: {
    calibration: activeCalibration,  // PhysicalCalibration {calibrationId, widthPx, heightPx, cm2PerPx} | null
  },
  labelSuffix: (bucket) => bucket.physical ? formatFromAnalytics(bucket) : null,  // e.g. "38 g · 1.1 kg CO2e · 18 L water"
});
r.measurements[i].physical;   // PhysicalEstimate {calibrationId, method: 'area-calibrated-v1', areaCm2}; pixels unchanged
r.attempt.calibrationId; r.attempt.physicalMethod;   // set when applied
r.physical;  // { status: 'applied'|'unavailable'|'not_requested', reason?, method?, calibrationId? }
```

- `areaCm2 = pixels × k` (`computeAreaEstimate(pixels, {calibrationId, cm2PerPx})`, `area.ts`),
  with the food treated as lying on the base plane.
- `reason`: `no_calibration` (null calibration), **`incompatible_geometry`** (calibration
  `widthPx×heightPx` ≠ image), `analysis_unavailable`, `no_measurements`. In each case
  measurements carry no `physical`. Never zero.
- **Analytics rule:** grams = `areaCm2 × weight_g_per_cm2`; CO2e and water follow from grams.

`createSamWorkerClient(url?, timeoutMs?, token?)` sends `X-Worker-Token` when a token is set
(env `WORKER_TOKEN`), and a 401 becomes `SEGMENTATION_UNAUTHORIZED`.

### Overlay legend suffix (I8)

`renderOverlay({..., labelSuffix})` and `analyzeCaptureWithMasks({..., labelSuffix})` append the
callback's text after each food's pixels: `Ancho Flank Steak: 12,345 px · 38 g · 1.1 kg CO2e ·
18 L water`. The text is sanitized, and a throwing callback is ignored. Lines that would overflow
the image width are truncated with "…": the **food name is shortened first**, so the numbers stay
visible (`fitLegendText`, `layoutLegend`). Buckets carry `physical` for the callback.
