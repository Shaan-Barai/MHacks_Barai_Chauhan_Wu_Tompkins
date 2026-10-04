# AI measurement plan

Recorded October 3, 2026. Owner: Agent 1 for this planning document.

## Current workflow

**Gemini food classification → segmentation mask → Pixels wasted**

Gemini classifies visible food against the applicable menu. The proposed
[Meta SAM segmentation stage](MVP_AI.md) produces masks of the leftover food.
Application code counts foreground
pixels in validated masks, counting overlaps once. The primary metric remains
**Pixels wasted**, as defined in [the measurement contract](../../contracts/measurement.md).

## Future extension: DepthAnythingV2 volume data

**Classification → segmentation mask → DepthAnythingV2 depth map → food
height above the plate → estimated volume**

This is a future plan only. Do not implement depth inference, download model
weights, add dependencies, change runtime contracts, or replace the current
pixel metric as part of this documentation task. Camera placement and conveyor
integration remain deferred.

The proposed camera/image-processing workflow is:

1. Classify the food and obtain its segmentation mask first.
2. Run DepthAnythingV2 on the corresponding RGB image to produce a dense
   depth map: one estimated depth value for every image pixel. Keep the
   original scene available to the depth model; use the mask to select the
   food pixels for measurement afterward. This is one image inference, not a
   separate model request for each pixel.
3. Align the depth map and masks to the same image coordinates. Preserve crop,
   resize, orientation, and camera-calibration transforms.
4. For every foreground food pixel, estimate the food surface's height above
   the plate underneath it. Use a calibrated empty-plate surface or known
   plate geometry as the reference. Camera-to-food depth alone is not food
   thickness; a curved plate or bowl needs its own reference surface.
5. Convert each sample's footprint into physical area using camera geometry
   and a known scale. Multiply its food height by that area, then sum the
   contributions for each food and for the whole capture. Count overlapping
   food regions once.

## Depth and volume calibration

DepthAnythingV2's standard checkpoints estimate **relative depth**. The project
also provides **metric-depth checkpoints**, whose inference output is described
as a depth map in meters. Physical volume requires metric depth or a validated
conversion from relative depth; an arbitrary relative-depth value cannot be
treated as millimeters. Metric predictions still need validation for close-up
food and plate geometry. See the [official project](https://github.com/DepthAnything/Depth-Anything-V2)
and [metric-depth documentation](https://github.com/DepthAnything/Depth-Anything-V2/tree/main/metric_depth).

Before implementation, select the checkpoint and establish camera intrinsics,
physical scale, plate-surface calibration, and image-to-plate mapping. A known
plate diameter helps establish physical area but does not alone resolve a
relative depth map's scale and offset. Do not subtract independently normalized
relative-depth maps of a full plate and an empty plate.

For a calibrated, approximately perpendicular top-down view, the intended
volume approximation is:

```text
food_height_mm(p) = max(0, empty_plate_depth_mm(p) - food_surface_depth_mm(p))
pixel_volume_mm3(p) = food_height_mm(p) * footprint_area_mm2(p)
food_volume_mm3 = sum(pixel_volume_mm3(p) over the food's assigned mask)
food_volume_ml = food_volume_mm3 / 1000
```

This assumes the depth convention increases away from the camera and both
depths use one calibrated physical coordinate system. For tilted/perspective
views, reconstruct surface points using camera intrinsics, map them to a plate
coordinate grid, and integrate height over physical grid-cell area. Directly
adding camera-ray depths does not calculate volume.

The approximation treats food as height columns above the plate. Hidden
undersides, cavities, gaps, and occluded foods can bias the result. Significant
negative heights, invalid depth, or missing calibration must produce a review
or unavailable result rather than silently becoming zero-volume food.

## Future data and verification

Retain Pixels wasted alongside an optional **AI-estimated leftover volume**
with explicit units. Volume remains an estimate and does not imply mass,
servings, cost, or environmental impact without further calibration.

Future records should identify the capture, menu item, mask, depth checkpoint,
calibration version, geometry transforms, integration method, units, and
quality flags. Store retained depth maps and masks in external object storage;
SpacetimeDB holds durable references, metadata, and scalar results.

Before enabling volume reporting, compare estimates with known-volume objects
and representative food portions. Check empty plates, different heights,
equal volumes arranged differently, mask overlap, image/depth alignment, plate
curvature, and invalid depth. Record per-food errors and exclusions. No depth
model, calibration, or volume accuracy has been tested by this planning task.
