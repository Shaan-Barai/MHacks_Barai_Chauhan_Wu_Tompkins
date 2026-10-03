# Shared contracts

Owner: Agent 1 (coordinator). Everything in this directory is the interface
other modules build against. Change it only through Agent 1.

## Files

- `types.ts` — entity and error type definitions (TypeScript, dependency-free).
  Additive `PortionsServed` / `MaskPixelCount` types support the per-portion
  recommendation benchmark; mask inference remains pending.
- `samples.json` — one valid sample record per entity, usable as fixtures.
- `decisions.md` — recorded stack decisions and open questions.
- `measurement.md` — current classification → segmentation → pixel-count contract and migration scope.

## Units and terminology

- **Pixel areas.** Every area is measured in pixels inside the shared
  normalized top-down coordinate space `topdown-normalized-v1`
  (defined by Agent 3; observation and reference images get the same
  normalization). Never compare raw pixels from differently scaled images.
- **Pixels wasted** is the primary UI label and its unit is **pixels**.
  First Gemini classifies food, then a segmentation stage produces masks;
  application code counts their foreground pixels. The total uses the union
  of eligible food masks per capture and unique captures per reporting window.
  Existing "waste units" scaling is legacy behavior to migrate.
- Segmentation boundaries remain **AI estimates**, even though counting mask
  pixels is deterministic. Preserve that uncertainty and provenance in storage
  and UI. Attendance is always **simulated** in the prototype.

## Measurement rules (summary — AGENTS.md §7 is canonical)

```
pixels_wasted_i = count(foreground pixels assigned to food item i)
capture_pixels_wasted = count(foreground pixels in the union of eligible food masks)
total_pixels_wasted = sum(capture_pixels_wasted for unique eligible captures)
```

- A baseline is not required for valid Pixels wasted. Missing/above-baseline
  flags apply to optional ratios, not to eligibility of a validated mask count.
- Unknown edible leftovers may contribute to an unclassified pixel bucket;
  they cannot be assigned to a named menu item.
- Failed/invalid segmentation is unavailable and its exclusion count displayed.
  Only a successfully validated empty-food mask establishes zero wasted pixels.
- Mask dimensions/alignment and threshold/rasterization rules are validated
  and versioned. Incompatible geometries are grouped separately. Overlap is
  resolved for item assignment and counted once in the capture total.
- `types.ts` and existing samples describe the pre-migration implementation.
  The new optional mask-count provenance and served-portion records are additive;
  the downstream portion calculator rejects legacy estimates. The rest of the
  coordinated mask-pipeline migration is required before live mask counting is claimed.

## Error format

Every API error — HTTP responses and stored failures — uses the `ApiError`
envelope in `types.ts`: `{ code, message, details?, retryable }`. Codes are
SCREAMING_SNAKE and stable; messages are plain language safe for dining staff.

## Idempotency

`CaptureEvent.eventId` is the ingestion idempotency key. Retries update the
same event and add analysis attempts; they never create a second observation.
