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
