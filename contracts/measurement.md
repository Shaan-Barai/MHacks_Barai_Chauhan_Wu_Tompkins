# Current measurement contract: Pixels wasted

Owner: Agent 1. User decision recorded October 3, 2026. This specifies the
next measurement implementation; existing runtime types and analyses still
need a coordinated migration.

## Ordered analysis flow

1. **Classification:** Gemini identifies visible food against the applicable
   hall/date/service menu. Return stable item IDs, region associations where
   available, and explicit unknown/ambiguous outcomes. Classification does
   not supply final quantity measurements.
2. **Segmentation:** Generate leftover-food masks for the classified regions.
   Validate them and map provider outputs into the normalized image's pixel
   coordinate space. The planned model family is Meta SAM; the
   [MVP AI plan](../MVP_AI.md) proposes SAM 2.1 Small with Gemini boxes first,
   plus detector alternatives and SAM 3 text prompting for evaluation. The
   exact checkpoint and execution host remain provisional.
3. **Counting:** Application code counts foreground pixels in each validated
   binary mask. It counts the union of eligible food masks for the capture
   total, preventing overlap from inflating the result. Each capture event is
   included once in a reporting total.

```text
item_pixels_wasted = count(foreground pixels assigned to the item)
capture_pixels_wasted = count(foreground pixels in union(eligible food masks))
total_pixels_wasted = sum(capture_pixels_wasted over unique eligible captures)
```

The primary label is **Pixels wasted**, with units **pixels**. It describes
visible leftover-food area in the agreed normalized geometry. It does not
claim grams, food volume, serving equivalents, or the fraction originally
served. Mask boundaries are AI estimates; pixel counting is deterministic.

## Required validation and provenance

- Decode masks and validate dimensions, encoding, bounds, label association,
  and alignment with the analyzed image before counting.
- If a provider returns a cropped mask, map its crop into the full normalized
  canvas before counting. If it returns a soft mask or contours, define and
  version the threshold or rasterization rule. These choices remain open.
- Counts are nonnegative integers within image bounds. Resolve category
  overlap or flag item attribution for review; capture totals count the union.
- Group incompatible coordinate spaces, resolutions, perspective, and plate
  geometry separately. Do not sum differently scaled raw-upload pixel areas.
- Track classification and segmentation status separately. A successful
  classification with failed segmentation has no valid pixel measurement.
  Failed, missing, malformed, and incomplete masks are unavailable or clearly
  partial. A validated empty-food mask gives zero pixels for the capture.
- Preserve image and mask references, geometry, menu version, separate stage
  model/prompt versions, processing-rule version, and quality flags. If masks
  are retained, store their bytes in external object storage. SpacetimeDB
  contains durable references and small metadata/counts, never mask blobs.
- Keep unknown edible leftovers in an unclassified bucket. They can contribute
  to the total when their mask is valid, but cannot be attributed to a named
  menu item. Non-food objects do not contribute.

## Baselines and recommendations

Uneaten-serving baselines are unnecessary for Pixels wasted. A missing, zero,
or exceeded baseline must not exclude an otherwise valid mask-derived count.

The earlier request to use mean percentage wasted when waste is present for
recommendations remains an auxiliary requirement with an unresolved
denominator. If retained, calculate it from compatible mask/reference data
and label it as a reference-area comparison. It does not establish the
percentage of an individual's original food and must not gate primary pixel
totals. Model-guessed percentages and piece counts do not satisfy the selected
measurement flow.

Recommendations should cite the measured per-food pixel totals and capture
coverage. Demo records and simulated attendance remain explicitly labeled.

## Implementation handoff

- Agent 1 coordinates shared runtime types and sample migration; this context
  update does not rename or change current payload fields.
- Agent 3 defines normalized image geometry; hardware placement is deferred.
- Agent 4 implements classification, mask generation/validation, and counting.
- Agents 2 and 5 coordinate schema and durable mask-reference persistence.
- Agent 6 aggregates counts; Agent 7 displays Pixels wasted without the legacy
  waste-unit conversion; Agent 8 checks exact mask arithmetic and failures.
- Existing scalar-area smoke tests and count/percentage evaluations do not
  demonstrate mask-counting correctness. Required verification includes a
  known foreground count, valid empty mask, crop alignment, overlap union,
  malformed mask, stage failure, missing baseline, and capture idempotency.
