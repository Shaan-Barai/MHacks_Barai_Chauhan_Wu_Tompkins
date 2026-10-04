# Simple Logitech C920s wall mount — concept

For the current no-metal/local-fabrication request, use the newer
[plywood demo stand](../c920s-plywood-demo/README.md). This wall concept is retained
as prior work.

One fixed bracket, four wall screws, one camera screw. The camera's existing
clip/hinge provides small aiming adjustments; the bracket adds no moving joints.
The mount is a separate hardware concept and changes no capture software or
image-normalization contracts.

## Files

- `c920s-wall-mount.step` — bracket solid for importing into CAD software.
- `c920s-wall-mount.stl` — bracket only, in millimetres, oriented with the wall
  plate's back on the print bed. Approximate print envelope: 120 × 90 × 208 mm.
- `assembly-with-camera-reference.step` — bracket plus an approximate camera
  envelope, for explaining the installation. Do not print the camera reference.
- `model.py` — parametric source; change `P["arm_reach"]` to alter the reach.
- `dimensions.svg` — dimensioned front, side, and camera-end views.
- `drill-template.svg` — 1:1 wall-hole layout; print at actual size and verify
  the 50 mm calibration line before using it.
- `preview.png` — rendered concept preview from the exported CAD geometry.
- `validation.json` — solid, STEP round-trip, and STL mesh checks.

## Dimensions and hardware

| Feature | Concept dimension |
| --- | --- |
| Wall plate | 90 mm wide × 120 mm high × 8 mm thick |
| Arm | 200 mm reach from plate's front; 40 mm wide × 8 mm thick |
| Wall-to-front-face distance | 208 mm |
| Underside triangular brace | 12 mm wide; attached to plate and arm |
| Camera mounting tab | 40 mm wide × 60 mm high × 8 mm thick |
| Wall holes | Four Ø5.5 mm clearance holes; 60 × 90 mm centre spacing |
| Camera hole | Ø6.8 mm clearance; 20 mm above tab's bottom edge |
| Lens position in preview | Approximately 245 mm from the wall; provisional |

Hardware: four approximately 5 mm wall screws with flat washers and anchors
appropriate to the actual wall; one metal **1/4-20 camera screw**, plus a washer.
A 1/2-inch screw has about 4.7 mm protrusion through the 8 mm tab before adding
washers. Check the camera socket depth and use washers or a shorter screw so
the screw clamps the camera without bottoming out. The holes are clearance
holes, not printed threads. The wall screws are pan/round-head with washers,
not countersunk screws.

## Installation

1. Hold the bracket where the lens can look straight down at the dish area.
   Select height using a live preview and the application's centred square crop.
2. Mark the four wall holes, drill for the chosen wall fixing, then screw down
   the bracket with washers. The screws remain accessible beside the narrow arm.
3. Rotate the C920s and its existing clip together by 90° so its tripod base
   rests against the vertical camera tab and its lens faces down.
4. Pass the camera screw through the tab from the wall side into the existing
   tripod socket. Keep the webcam's folding clip attached. Gently set its hinge
   so the lens points vertically down, then confirm the full plate is visible.
5. Secure the USB cable along the arm with removable ties and leave a short
   slack loop near the camera. Support the hub and Uno Q separately.

The vertical camera tab matters: a C920s sitting normally on a horizontal
shelf faces forwards. Rotating its tripod base against this tab turns the
camera down without requiring a separate ball head.

## Fabrication and remaining checks

The intended prototype is a single PETG print. Starting slicer settings:
0.2 mm layers, 5 perimeters, 40–50% infill, with support under the projecting
camera tab. The supplied STL puts the large flat wall plate on the bed; inspect
the generated supports and the tall arm in the slicer. These are starting
settings, not a demonstrated load rating.

This is a **concept, not a load-tested bracket**. Its camera fit, printed
strength, long-term creep, wall fixings, and view framing need a physical check.
The user's C920s is confirmed; the 200 mm arm reach is a provisional choice for
simplicity. Measure wall-to-dish position before fabricating. The preview's clip
dimensions are a simplified envelope, not verified manufacturer geometry.
Keep the camera and mount outside the image crop; mount rigidly and use the same
view geometry for observation and reference images.

Logitech documents a 94 mm body width, 29 mm body height, 24 mm depth, 162 g
weight, and tripod mounting in its [C920s specifications](https://support.logi.com/hc/en-za/articles/360023303514-C920s-HD-Pro-Webcam-Technical-Specifications).
Its [setup guide](https://www.logitech.com/assets/65985/2/c920s-web-qsg.pdf)
locates the 1/4-inch tripod thread on the bottom of the existing clip. Socket
engagement depth and clip clearance still need checking on the physical camera.

## Regeneration and verification

Use a separate Python environment with `cadquery==2.6.1`; run `python model.py`.
The source exports native solid STEP data and triangulated STL data using
[CadQuery's export interfaces](https://cadquery.readthedocs.io/en/latest/importexport.html).
`preview-mesh.json` is generated from the same solids for the visual preview.

The automated checks verify one valid CAD solid, a STEP import/export round
trip, consistent STL winding, watertight edges, and close agreement between
solid and mesh volumes. They do not test physical load capacity or camera fit.
No application interfaces, dependencies, or existing project files were changed.
