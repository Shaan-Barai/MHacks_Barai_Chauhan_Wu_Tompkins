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
| `GEMINI_MODEL` | `gemini-2.5-flash` | Model id passed to `@google/genai`. |
| `GEMINI_TIMEOUT_MS` | `30000` | Per-request timeout (AbortSignal). |
| `GEMINI_MAX_RETRIES` | `2` | Bounded retries after the first attempt (retryable errors only). |
| `GEMINI_RETRY_BASE_DELAY_MS` | `500` | Exponential backoff base (500, 1000, …). |

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

33 tests, all fixture-driven (no credentials needed, no live Gemini calls).

## Live smoke test — documented, NOT yet run

No Gemini API key has been provisioned, so **no live call has been made**; all
verification above is mock/fixture based. Once a key exists:

1. `export GEMINI_API_KEY=...` (never commit it; optionally set `GEMINI_MODEL`).
2. From `vision/` after `npm run build`, run a one-off script that
   `createGeminiGateway()` (should report `mode === 'live'`), calls
   `gateway.generateText('Reply with the word OK.')`, then `analyzeCapture`
   with a real top-down test photo (`kind: 'bytes'`) and the sample menu from
   `contracts/samples.json`.
3. Confirm: structured JSON parses and validates, `attempt.model` matches the
   configured model, areas are plausible for the image, and a deliberately bad
   key produces `GEMINI_AUTH_FAILED` without retries.
4. Record the result (date, model, outcome) in `contracts/decisions.md` via
   Agent 1 before claiming live verification anywhere.
