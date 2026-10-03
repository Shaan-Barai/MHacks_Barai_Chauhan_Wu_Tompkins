# MVP AI plan: Gemini classification and Meta SAM segmentation

Recorded October 3, 2026. Owner: Agent 1 for this planning document.
Status: researched proposal; no segmentation model has been installed or tested.

## Recommended first prototype

**Normalized dish image → Gemini food classification and boxes → SAM 2.1
Small masks → validated foreground pixel counts → Pixels wasted**

Use Meta's SAM 2.1 for the planned segmentation stage. Start evaluation
with **SAM 2.1 Hiera Small** (`sam2.1_hiera_small.pt`) and boxes returned
alongside Gemini's classifications. Keep the detector replaceable. If Gemini
misses or poorly localizes leftovers, compare **Grounding DINO** on the same
images before adding it to the runtime.

**Scope update:** SAM 3 is deferred and excluded from MVP implementation and
evaluation at the user's request.

These are engineering recommendations, not measured food-accuracy claims.
The exact checkpoint and execution host remain provisional until evaluation.
This task creates a plan only: no dependencies, model weights, runtime fields,
or inference code are added. Uploaded/replayed images remain the input; camera
placement, conveyor integration, and [DepthAnythingV2 volume work](AI.md) are
deferred. [The measurement contract](contracts/measurement.md) governs counts.

## Do SAM models need bounding boxes?

SAM 2.1 can use point prompts as well as boxes. Boxes are the planned starting
prompt for this MVP.

| Model | Prompt options and relevance | Proposed use |
| --- | --- | --- |
| Original SAM | Point/box prompts and automatic mask generation. Automatic masks do not provide our menu-item classification. [Official repository](https://github.com/facebookresearch/segment-anything). | Historical comparison; no need to start a new integration here. |
| SAM 2 / SAM 2.1 | Image segmentation with point/box prompts; automatic mask generation is also available. SAM 2.1 supplies updated Tiny, Small, Base Plus, and Large checkpoints. [Official repository](https://github.com/facebookresearch/sam2). | Start with Small and box prompts; compare larger checkpoints only if errors justify it. |

SAM 2.1 Small is a manageable baseline for the existing separate classification
and segmentation design. The official SAM 2 setup specifies Python ≥3.10,
PyTorch ≥2.5.1, and TorchVision ≥0.20.1. Its published speed results use an
A100; they do not establish latency on our machine. [SAM 2 setup and benchmarks](https://github.com/facebookresearch/sam2).

Do not automatically sum every mask from an automatic generator: object parts,
whole objects, and background regions can overlap. Food selection and semantic
attribution still need validation.

## Bounding-box options

Gemini continues to classify against the relevant menu in every option below.
A dedicated detector would localize its food labels, not replace that step.

| Option | Why consider it | Decision for this MVP |
| --- | --- | --- |
| Gemini, using the existing configurable gateway | Google's image-understanding documentation includes object detection and normalized boxes. [Official documentation](https://ai.google.dev/gemini-api/docs/image-understanding#object-detection). | First trial: request stable menu-item IDs and one or more food-region boxes in the classification response. Least additional model setup; localization quality must be tested. |
| Grounding DINO, initially GroundingDINO-T / Swin-T | Text-conditioned open-set detection with published pretrained weights. [Official repository](https://github.com/IDEA-Research/GroundingDINO). | First dedicated detector to compare if Gemini boxes are inadequate. Use simple visual food descriptions associated explicitly with menu-item IDs. |
| YOLO-World, initially a Small checkpoint | Open-vocabulary detection with a prompt-then-detect design for efficient use of a chosen vocabulary. [Official repository](https://github.com/AILab-CVC/YOLO-World). | Speed-oriented alternative to benchmark if detection latency becomes a bottleneck. Do not assume its published speed or food quality transfers to our setup. |

This detector-plus-segmenter approach has precedent: the authors' **Grounded
SAM 2** repository supplies Grounding DINO + SAM 2 image demos and SAM 2.1
support. It demonstrates integration, not reliable leftover-food measurement.
[Grounded SAM 2 examples](https://github.com/IDEA-Research/Grounded-SAM-2).

## Proposed image-processing flow

1. **Prepare one image.** Use the capture module's existing
   `topdown-normalized-v1` image (currently 1024 × 1024). Both stages receive
   that same image, orientation, and crop. Preserve its geometry/version and
   object reference. Resizing alone does not make different plate scales or
   perspectives comparable; flag incompatible geometry.
2. **Classify and localize.** Ask Gemini for visible menu-item IDs,
   unknown/ambiguous regions, and boxes around the actual leftovers. Permit
   multiple regions for one item, such as scattered fries. Do not ask for
   pixel quantities or original-serving percentages. Validate the structured
   response, allowed IDs, region IDs, and box coordinates.
3. **Convert coordinates explicitly.** Google's box convention is
   `[ymin, xmin, ymax, xmax]` on a 0–1000 scale. Convert it to SAM's pixel-space
   XYXY convention for the exact analyzed image of width `W` and height `H`:

   ```text
   sam_box = [xmin * W / 1000, ymin * H / 1000,
              xmax * W / 1000, ymax * H / 1000]
   ```

   Reject nonfinite, reversed, zero-size, or out-of-range boxes. Store the
   original and converted coordinates for debugging. Other detectors need
   their own adapters; never assume they use Gemini's format.
   [Google box format](https://ai.google.dev/gemini-api/docs/image-understanding#object-detection),
   [SAM 2 predictor interface](https://github.com/facebookresearch/sam2/blob/main/sam2/sam2_image_predictor.py).
4. **Segment each region.** Encode the image once using `SAM2ImagePredictor`,
   then predict for its boxes. Start with `multimask_output=False`. If multiple
   candidates are evaluated, select one per region; alternative masks are not
   additional food instances. The predictor supports foreground/background
   points for refinement. [Official predictor](https://github.com/facebookresearch/sam2/blob/main/sam2/sam2_image_predictor.py).
5. **Produce reproducible binary masks.** Proposed initial settings:
   `return_logits=False`, logit threshold `0.0`, no small-component removal,
   and no hole filling. Version these settings. The official predictor returns
   masks at the supplied image's dimensions. Preserve small grains and crumbs;
   do not count overlay colors or JPEG artifacts.
   [Mask output and threshold behavior](https://github.com/facebookresearch/sam2/blob/main/sam2/sam2_image_predictor.py).
6. **Validate and assign pixels.** Check dimensions, alignment, food
   association, and plate/cutlery/background leakage. Union multiple regions
   of the same item. Resolve overlap between different foods or flag ambiguous
   attribution; do not award the same pixel to two items. If the union is
   confidently edible but its item label is unclear, it may contribute to an
   unclassified food total.
7. **Count and persist.** Count assigned foreground pixels per item and the
   union of eligible food masks per capture. Save mask assets through the
   backend's object-storage adapter; SpacetimeDB receives durable references,
   counts, geometry, provenance, and quality/status metadata. Preserve capture
   idempotency and expose the primary label **Pixels wasted**.

## Failure and food-specific review rules

- A box is a prompt, never a pixel measurement. Good classification cannot
  recover food that the localization stage missed.
- A SAM mask can select the whole plate, one piece of a scattered food, or a
  mixture of foods. Compare overlays with representative leftovers, including
  rice, sauce, crumbs, overlapping foods, and food similar in color to plates.
- Do not treat a model score as calibrated food accuracy. Quality thresholds
  and any point refinement policy must be evaluated, then versioned.
- A missing detection, failed request, empty candidate, or invalid mask does
  not establish an empty plate. Require a successful, explicit empty-food
  assessment before recording a zero-pixel capture. Partial coverage remains
  visibly partial; it must not appear as a complete total.
- Use a matching composite menu item for an inseparable mixed dish, or mark
  its attribution ambiguous. Unknown edible food remains separate from
  non-food material.
- Baseline photos and serving-area ratios do not gate pixel counts. The
  earlier conditional mean-percentage recommendation request remains an
  auxiliary item with an unresolved denominator, as recorded in the
  [measurement contract](contracts/measurement.md).

## Runtime and contract proposal

Keep Gemini access in the existing server-side TypeScript vision gateway.
Propose a small Python SAM worker under `vision/sam/`, owned by Agent 4, with a
vision adapter called by Agent 5's backend. Load the model once, bound image
size/concurrency, and isolate or serialize predictor image state so concurrent
captures cannot reuse each other's embeddings. Choose the host after checking
available hardware; no local GPU capability or real-time performance is assumed.

Before implementation, Agent 1 publishes the shared payload migration:

| Record | Proposed additions |
| --- | --- |
| Classification region | Capture/menu version, region ID, allowed menu-item ID or unknown, visual label, box and coordinate convention, classification status/model/prompt version |
| Segmentation result | Region association, full-canvas mask reference, dimensions/geometry version, checkpoint/code revision, prompt source, processing settings, stage status and quality flags |
| Count result | Assigned item pixels, capture union pixels, completeness/review status, counting-rule version, exclusion reasons |

Use a lossless binary PNG mask as the initial stored format, with foreground
value 255 and background 0; validate it when decoding. Keep masks, image bytes,
and optional debug overlays in external storage. Do not send encoded masks in
SpacetimeDB rows or subscriptions. Agent 5 owns storage access and upload
finalization; the worker does not introduce its own bucket credentials.

These are proposed shapes, not changes to `contracts/types.ts`. Existing
scalar-area and count/percentage paths must be migrated together; their prior
smoke tests do not verify this pipeline.

## Evaluation and implementation order

1. **Fix the contract and execution target.** Agents 1, 3, and 4 agree on
   geometry, mask serialization, coordinate conversion, and worker interface;
   Agents 2 and 5 agree on provenance persistence. Pin the chosen code revision
   and checkpoint. Determine hardware and access before estimating latency.
2. **Test segmentation independently.** Prepare a proposed small evaluation
   set of 20–30 manually annotated dish images covering clear foods, scattered
   pieces, residue, mixed/unknown foods, empty plates, and non-food objects.
   Keep a held-out subset. First supply manually checked boxes to SAM 2.1
   Small to measure segmentation errors without detector errors.
3. **Test the complete path.** Run Gemini classification/boxes on the same
   images. Compare localization omissions and resulting masks against the
   manual-box baseline. Evaluate Grounding DINO if localization dominates
   errors. Select the simplest SAM 2.1 path that meets
   agreed criteria, without tuning on the held-out subset.
4. **Connect one vertical slice.** Agent 4 implements the selected adapter;
   Agent 5 handles processing states/storage/persistence; Agents 6 and 7
   aggregate and display counts. Preserve the original image and mask so the
   demonstration can show what was counted.
5. **Verify before calling it ready.** Agent 8 checks known mask arithmetic,
   duplicate/overlapping regions, XY/YX conversion, image/crop alignment,
   empty and failed analysis, missing baselines, and repeated ingestion.
   Feature owners address failures in their own modules.

Report mask IoU/Dice, absolute pixel-count error, relative count error only
when the annotated count is nonzero, missed food area, non-food false positives,
per-food results, exclusions, latency, and memory on the actual host. Empty
plates need false-positive pixel counts rather than division by zero. Separate
Gemini classification mistakes, box mistakes, and mask mistakes.

Agree on acceptable errors and latency before the final held-out evaluation.
No universal food-accuracy percentage, acceptable threshold, model benchmark,
or serving/volume conversion is established by this planning document.
