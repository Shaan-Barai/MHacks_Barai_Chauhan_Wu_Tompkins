# Shared contracts

Owner: Agent 1 (coordinator). Everything in this directory is the interface
other modules build against. Change it only through Agent 1.

## Files

- `types.ts` — entity and error type definitions (TypeScript, dependency-free).
- `samples.json` — one valid sample record per entity, usable as fixtures.
- `decisions.md` — recorded stack decisions and open questions.

## Units and terminology

- **Pixel areas.** Every area is measured in pixels inside the shared
  normalized top-down coordinate space `topdown-normalized-v1`
  (defined by Agent 3; observation and reference images get the same
  normalization). Never compare raw pixels from differently scaled images.
- **"Waste units" in `UI.md` = observed estimated leftover area (pixels).**
  Dashboard copy may say "waste units" for friendliness, but the stored and
  aggregated quantity is always `remainingAreaPx` summed per
  AGENTS.md §7. Attendance normalization is labeled
  **observed leftover area per simulated attendee**.
- All measurements produced by Gemini are **AI estimates** and carry the
  `ai_estimate` quality flag; attendance is always **simulated** in the
  prototype. Both labels must survive into storage and UI.

## Measurement rules (summary — AGENTS.md §7 is canonical)

```
raw_waste_fraction  = remainingAreaPx / baselineAreaPx   (baseline finite, > 0)
display_waste_percent = 100 * clamp(raw_waste_fraction, 0, 1)
overall_waste_percent = 100 * sum(remainingAreaPx) / sum(baselineAreaPx)
```

- Missing/invalid baseline ⇒ no percentage; set `unavailableReason`. Never a guessed zero.
- `raw_waste_fraction > 1` ⇒ flag `above_baseline`, exclude from ordinary aggregates.
- Unknown items keep their area estimate but are excluded from menu percentages.
- Failed/invalid analysis is excluded and its exclusion count displayed — it is
  never counted as zero waste.

## Error format

Every API error — HTTP responses and stored failures — uses the `ApiError`
envelope in `types.ts`: `{ code, message, details?, retryable }`. Codes are
SCREAMING_SNAKE and stable; messages are plain language safe for dining staff.

## Idempotency

`CaptureEvent.eventId` is the ingestion idempotency key. Retries update the
same event and add analysis attempts; they never create a second observation.
