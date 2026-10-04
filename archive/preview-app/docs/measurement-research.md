# Food-waste measurement research

Researched October 3, 2026. This is a design assessment based on primary research and official product documentation. It includes no live Gemini benchmark, camera experiment, or new dashboard implementation.

**Subsequent user decision, October 3, 2026:** use Gemini for classification
first, then obtain a segmentation mask and count foreground pixels in code.
The primary metric is **Pixels wasted**. The serving-equivalent definitions
and reference-photo experiment below are historical research, not the current
measurement contract. See [the current contract](../../contracts/measurement.md).
The mask model/provider remains to be selected; camera placement is deferred.

## Earlier requested direction (primary metric superseded)

Use total servings wasted as the primary reporting quantity. Use mean percentage wasted among observations where waste is present for recommendations. Defer camera placement and conveyor integration.

The working interpretation of servings is **estimated standard-serving equivalents**: leftovers totaling four quarter-portions represent one standard serving. An item-serving equivalent is not a complete meal or a count of diners. Totals describe observed/uploaded records, not all waste in the hall.

For item i in observation j:

```text
e_ij = estimated edible leftover quantity / quantity in one standard serving of item i
total_servings_wasted = sum(e_ij) over eligible observations and items
conditional_mean_standard_serving_percent_i = 100 * mean(e_ij where e_ij > threshold)
```

Both quantities must use the same measurement basis. Mass divides by mass, volume by compatible volume, and piece counts by comparable standard piece counts. A visual portion score is an estimate. An area ratio remains an area-based proxy if no calibrated quantity mapping exists.

The conditional percentage describes a standard serving. To describe the fraction of a diner's original portion, use their actual original quantity as the denominator instead. These are different metrics when portions vary. The implementation contract must settle this distinction before updating analytics. If no eligible positive-leftover observations exist, the conditional mean is unavailable; it is not zero.

Standard-serving equivalents can exceed one when a diner leaves more than a standard portion. Do not automatically cap them at one. This proposed semantic change would require revising the existing area-ratio review rules; current code has not been changed.

Recommendations should include positive-leftover sample size, total wasted-serving equivalents, exclusions, and reporting window. For example, 0.25, 0.50, and 0.75 standard servings remaining sum to 1.50 servings and have a conditional mean of 50% of a standard serving. This does not identify how often everyone taking that food wastes it.

## Measurement options

| Method | What it can measure | Main limitation | Prototype fit |
| --- | --- | --- | --- |
| Tared scale and food-specific standard portion weights | Edible leftover mass and standard-serving equivalents | Mixed-food total weight does not reveal each item's weight; separate weighing or a separately validated allocation method is needed | Best physical reference, even if used only for validation |
| Counts of similarly sized pieces | Equivalent portions of nuggets, slices, rolls, and similar foods | Broken pieces need fractional estimates; unsuitable for amorphous foods | Simple first case |
| Calibrated reference photographs | Estimated fraction of a standard portion | Arrangement, occlusion, thickness, and food type still affect judgment | Proposed first upload-only experiment |
| Paired before-and-after photographs | Visual fraction of the actual portion remaining | Does not resolve 2D thickness ambiguity by itself | Helpful if pairing is available |
| Segmentation masks normalized to a known plate | Reproducible visible area instead of a verbally guessed pixel number | Visible surface area is not mass or volume | Useful intermediate measurement |
| Measured depth / RGB-D imaging | Food volume, potentially mass after food-specific calibration | Extra hardware, segmentation, and calibration work | Future route if visual estimates prove inadequate |

An ordinary monocular depth estimate can infer likely shapes, but it is not a measured metric depth map. A known plate size establishes scale without revealing hidden food thickness.

For physically measured percentage of an original serving, weigh the edible food before and after and compute `100 * leftover_mass / original_served_mass`. For a percentage of a standard serving, compute `100 * leftover_mass / standard_serving_mass`. Plate/container tare and non-edible material must be handled explicitly. The new serving metric removes the need to know item popularity to calculate observed totals; it does not remove the need to estimate leftover quantity.

## What has already been tried

### Commercial camera-and-scale systems

[Winnow's official FAQ](https://www.winnowsolutions.com/faqs) describes photographing discarded food while a connected scale records its weight. AI supplies the category. This is directly relevant precedent for combining recognition with a physical quantity measurement. Vendor descriptions establish the system design; they are not independent accuracy validation.

### Reference-photo estimation in schools

The 2016 [Promeal photographic validation study](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0163970) used weighed half/full reference portions and overhead plus angled images. Trained humans assessed servings and leftovers on 448 plates containing 57 food items. Leftover food-item estimates were within the study's ±25% acceptance range in 72% of cases in Iceland and 65% in Sweden. These are human estimates under that protocol, not Gemini accuracy figures. This supports testing reference photos while showing substantial residual error.

### University dining-hall segmentation

A 2025 [university dining-hall preprint](https://arxiv.org/abs/2507.14662) trained U-Net-family models on before/after photos of five meal types. Its evaluation compares predicted pixels with annotated masks. The authors explicitly discuss missing depth, stacked food, and difficult stew residue. Strong segmentation agreement should not be interpreted as the same accuracy for physical waste quantity. This closely matches the original pixel-based proposal but preserves its main measurement limitation.

### Measured depth and food-specific calibration

A 2024 [RGB-D portion-estimation paper](https://openrepository.aut.ac.nz/bitstreams/ece5863a-82d8-49a5-b8e8-b7a07728c019/download) combined food volume with experimentally calibrated food-specific volume-to-weight models. Its abstract reports errors of 5.07% for rice and 3.75% for chicken in the tested setting. The scope is controlled portion estimation, not unrestricted mixed plate-waste analysis. It is evidence for depth plus calibration, not a transferable error guarantee for this prototype.

## What the research says about Gemini

The 2025 [FoodNExTDB VLM evaluation](https://arxiv.org/html/2504.06925v1) tested Gemini 2.0 Flash and other models. Gemini's expert-weighted recall fell from 85.79% for broad categories to 50.00% when category, subcategory, and cooking style all had to match. It also performed worse with multiple food products than with one. This tests recognition, not leftover quantity, and does not benchmark newer Gemini versions or a menu-constrained prompt. It supports checking category errors separately from portion errors.

Google's [image-understanding documentation](https://ai.google.dev/gemini-api/docs/image-understanding) describes detection and contour segmentation, with a newer model example. The model-specific [Gemini 3 guide](https://ai.google.dev/gemini-api/docs/gemini-3) says Gemini 3 Pro and Gemini 3 Flash do not support pixel-mask segmentation and recommends Gemini 2.5 Flash with thinking disabled for that workload. Support must therefore be checked for the exact pinned model and API; do not generalize a capability to every Gemini version.

The sources reviewed do not establish the accuracy of free-form Gemini serving fractions on messy dining-hall leftovers. An outline or mask improves auditability of visible area, but does not independently recover food mass. A valid JSON response and the model's self-reported confidence do not validate numerical correctness.

## Earlier proposed first experiment (not selected)

1. Select three to five menu items, including countable food, rice/pasta, and a sauce or mixed dish.
2. Define each standard serving through measured portions for calibration. Photograph 0, 0.25, 0.50, 0.75, 1.00, and an above-standard portion. Keep plate type and photo framing consistent.
3. Ask Gemini to identify the menu item and compare leftovers with these references. Allow unknown, unclear, and above-standard results. Use quarter-serving estimates initially; finer decimal display would not establish finer accuracy.
4. Use separate held-out plates with known weighed quantities to evaluate serving-equivalent error. Include rearranged portions with the same weight, mixed/occluded foods, and negligible residue. Keep different photos of the same physical portion in one split to avoid an overly optimistic test.
5. Report food identification accuracy, mean absolute error in serving equivalents, systematic over/underestimation, aggregate-total error, and exclusion rate by food. Repeat identical inputs to assess model variability. Choose acceptable error thresholds based on the intended staff action.
6. Show recommendations using the requested conditional mean and its sample size, with total servings as supporting evidence. Keep unsuccessful measurements visible. Do not extrapolate uploaded samples to hall-wide totals.

This experiment requires labeling and calibration, not custom model training. Its results would determine whether reference-photo estimates are adequate or whether weighing/depth is necessary.
