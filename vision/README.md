# vision — Agent 4: Gemini classification and waste measurement

Self-contained Node 20 + TypeScript package. Turns a capture image plus its
menu/baseline context into a contract-valid `AnalysisAttempt` +
`FoodMeasurement[]` (see `contracts/types.ts`; AGENTS.md §7 math is canonical),
and owns the server-side Gemini gateway that Agent 6 reuses for suggestions.

```
vision/
  src/
    gateway.ts      Gemini transport (live/mock, timeout, bounded retries, ApiError)
    prompt.ts       versioned classification prompt + structured-output schema
    validate.ts     strict validation of untrusted model output
    measurement.ts  canonical §7 pixel-area math and flags
    analyze.ts      analyzeCapture() orchestration
    image.ts        bytes / read-URL -> Gemini inline-data formatting
    contracts.ts    verbatim copy of consumed contracts/types.ts types
  fixtures/responses.json   canned model responses (mock mode + tests)
  test/                     node --test suite (fixtures only, no live calls)
```

## Usage

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
| `PLATE_DIAMETER_PX` | `900` | Fallback plate diameter (px of the analyzed image) for `configured-default` calibration. |
| `SAM_WORKER_URL` | `http://127.0.0.1:8790` | SAM 2.1 worker (`vision/sam/`). |

All options can also be passed to `createGeminiGateway()` directly; explicit
options win over env.

## Mock mode

When `GEMINI_API_KEY` is unset (or a `mockTransport` is injected), the gateway
never touches the network. The default mock returns a valid empty-plate
classification and clearly labeled fixture text; tests inject responses from
`fixtures/responses.json`. Mock output is never presented as a live result.

## Prompt versioning

`PROMPT_VERSION` (currently `scrap-classify-v1`, `src/prompt.ts`) is stamped on
every `AnalysisAttempt` together with the model id and the menu/baseline
versions used. Bump it whenever the prompt text or response schema changes
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

The primary pipeline (contracts/measurement.md, MVP_AI.md):

1. `localize.ts` — Gemini returns menu item IDs (or `unknown`), visual
   labels, and `[ymin, xmin, ymax, xmax]` 0–1000 boxes; explicit
   `plateEmpty`/`ambiguous`; no quantities. Invented IDs are rejected.
2. `masks.ts` `geminiBoxToPixels` — convert to pixel XYXY on the exact image.
3. `samClient.ts` — the SAM 2.1 worker (`vision/sam/`) segments every box in
   one call (`Segmenter` seam; tests inject a fake).
4. `masks.ts` `decodeBinaryMask` — exact size, strictly 0/255, nonempty.
5. `masks.ts` `countPixels` (rule `union-v1`) — per-item unions; pixels
   contested by two items go to the unclassified bucket; capture total = union.

Returns the attempt (with `segmentation` and `calibration`),
`mask_pixel_count` measurements, the mask PNGs for the backend to store,
and (BIG-PLAN D2/D7) `calibration`, `overlay`, and `diagnostics`. Stage outcomes
(classification failure, explicit empty plate, partial, worker down) are
distinct and never become zero pixels. `analyzeCapture` (Gemini-guessed
areas) and `assessLeftovers` (counts/percents) remain as legacy/research
helpers, not the measurement path.

### Plate calibration and segmented overlay (BIG-PLAN D2, D7)

```ts
const r = await analyzeCaptureWithMasks(gateway, createSamWorkerClient(), {
  ...input,
  calibration: { defaultPlateDiameterPx: 900 }, // optional; { enabled: false } skips the fit
  renderOverlay: true,                           // optional, default true
});
r.calibration;   // PlateCalibration (contracts/types.ts), also r.attempt.calibration
r.overlay;       // { jpeg: Uint8Array, widthPx, heightPx, mimeType: 'image/jpeg', version: 'overlay-v1' } | null
r.diagnostics;   // { calibrationError?, plateRimPoints?, pixelsOutsideDish?, overlayError?, ... }
```

- **`plate-fit-v1`** (`src/calibration.ts`, ported from
  `scripts/waste-impact.mjs`): Gemini boxes the single plate/bowl holding the
  food (prompt `scrap-plate-v1`, requested concurrently with classification),
  SAM masks that box, a circle is fitted to the mask's outer rim (outermost
  pixel per row/column, frame-edge points ignored, one robust refit dropping
  points > 4% of r away), `plateDiameterPx = round(2r)`,
  `cm2PerPx = (26.7 / plateDiameterPx)^2`. Flags: `plate_cut_off` (Gemini
  says the rim is cut off or the circle leaves the frame),
  `bowl_size_assumed` (bowl). Plausibility: >= 1% of the image masked,
  >= 20 rim inliers and >= 30% of rim points, centre inside the frame,
  diameter between 25% of the short side and 2.5x the long side.
- **Fallback `configured-default`** with flag `calibration_default` whenever
  Gemini/SAM fail, the answer is invalid, the fit is implausible, analysis was
  unavailable, or calibration is disabled. Diameter = option
  `defaultPlateDiameterPx` > env `PLATE_DIAMETER_PX` > **900 px** (the
  normalized capture is a 1024² center crop; 900 px is the plate size the
  vision fixtures assume). Calibration never throws and never drops a capture.
- **Counts are unchanged.** Pixels wasted still uses `smallest-first-v1` on
  the full canvas; food outside the fitted dish is NOT subtracted (the script
  did clip). It is reported as `diagnostics.pixelsOutsideDish` so the effect
  can be checked before any rule change (which would bump the counting rule
  version). Rationale: a mis-fitted circle would silently delete real food,
  and the camera frames one dish per capture.
- **Overlay** (`src/overlay.ts`, `overlay-v1`): the analyzed image at its own
  size with each exclusive food bucket tinted in a fixed per-menu-position
  colour (unclassified = grey), the fitted rim in cyan, and a legend strip
  below (calibration header + total, then `food: N px`). JPEG quality 88.
  `sharp` is loaded lazily; a missing module or undecodable image gives
  `overlay: null` + `diagnostics.overlayError`. Rendered for complete,
  partial, and empty-plate captures; null when nothing was countable.
- Localize prompt `scrap-localize-v3`: every numbered menu line is
  `n. name — description` (the demo menu's descriptions are Gemini
  visible-component text); descriptions are sanitized (control chars,
  newlines, backticks stripped; 300-char cap) and the system instruction
  states that menu text is data, not instructions.

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
