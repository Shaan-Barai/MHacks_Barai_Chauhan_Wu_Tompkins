# Fast demo mount for the Logitech C920s

Superseded for the current request: the user requires no added metal and local
fabrication materials. Use the [plywood demo stand](../c920s-plywood-demo/README.md).
This purchased-stand concept is retained as prior work.

Use a **ready-made desk-clamp webcam stand with a flexible arm and 1/4-inch
camera mount**. Setup is one table-clamp knob, the camera screw, and aiming the
head downward. Prepare the camera/arm connection before arriving at the demo.
No bespoke printing, wall drilling, or custom clamp fabrication is needed.

The provisional mounting surface is a table/shelf edge. A plain wall without
an accessible edge needs a different fixing; the previous wall-bracket concept
remains in `../c920s-wall-mount/`.

## CAD files

- `demo-mount-layout.step`: editable placement assembly with generic clamp,
  flexible arm, approximate C920s, table and dish reference solids.
- `model.py`: parametric placement source, using CadQuery 2.6.1.
- `preview.png`: drawing rendered from the CAD assembly's triangulated geometry.
- `validation.json`: valid-solid and STEP import/export checks.

**The model represents a setup, not manufacturing instructions for a printed
clamp.** Use purchased metal mounting hardware. The generic stand geometry is
not a manufacturer model; its jaw opening, arm bend, head travel and camera-clip
clearance are provisional. No new application contracts or dependencies change.

## Quick setup

1. Clamp the stand to a firm, accessible table edge within its specified opening.
2. Screw the C920s' existing tripod socket onto the stand's camera screw.
3. Bend/position the arm above the plate and tilt the camera vertically down.
4. Check the live image: keep the whole plate inside the application's centred
   square crop. Leave slack in the USB cable, then secure it along the arm.

The illustrated lens is **398 mm above the table** and the reference dish is
280 mm across. These are starting placement assumptions, not guaranteed framing.
Position the camera using the live preview and keep its view fixed for captures.
Test that the stand stays put after releasing it; a flexible arm can move when
the table or USB cable is disturbed.

For a hardware example, [InnoGear's 25-inch flexible webcam stand](https://www.innogear.com/products/innogear-ws089-25-inch-webcam-stand)
lists C920s compatibility, a 1/4-inch mount and a maximum 46 mm clamp opening.
That listing was marked sold out when checked; it is a reference for the type
of stand to buy or borrow, not a promise of immediate availability.
[Logitech's setup guide](https://www.logitech.com/assets/65985/2/c920s-web-qsg.pdf)
shows the tripod thread on the camera's existing clip.

Verification: every CAD component is a valid solid; the STEP assembly reimports
with matching component count and total volume. Physical stand fit, stability,
actual camera-clip dimensions and live framing still need checking.
