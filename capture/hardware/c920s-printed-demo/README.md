# C920s printed demo stand

**Nine printed pieces and two plastic ties.** This replaces the plywood material
assumption with a modular plastic version of the tabletop camera bridge. Push the
pieces together, lay the C920s lens down in the cradle, and secure the camera with
the ties. No added metal hardware is needed. The camera's original clip stays
attached and uses the open notch.

The stand supplies its own camera height on a table. It is a provisional demo
design; assembly should be straightforward once the pieces are printed and fitted.
Printing is the slow part, and its duration has not been estimated in a slicer.

## Printing at the Duderstadt Center

The official [Prusa MK4s page](https://sites.google.com/umich.edu/groundconnections/fabrication-underground/prusa-mk-4)
lists a 250 × 210 × 220 mm build volume and PLA as the primary material. Each of
these models fits inside a 200 mm cube, so the individual parts fit that nominal
printer envelope. The [3DP-TIPS page](https://sites.google.com/umich.edu/groundconnections/fabrication-underground/3dp-tips)
also lists Prusa XL printers. Use one colour of PLA for this demo.

These listings confirm equipment and the normal material type, not an available
printer slot, filament supply or hackathon access. The MK4s page describes training,
class reservations and faculty-approved billing. Confirm the event's access with
Fab staff before relying on a print today. Plastic ties are not confirmed in stock.

## Files and quantities

Download `c920s-print-package.zip` for the STLs, assembled STEP model, this guide,
preview and print manifest. Set your slicer's units to **millimetres**.

| STL file | Print quantity | Bounds in supplied orientation, mm |
| --- | ---: | --- |
| `foot.stl` | 2 | 180 × 57 × 42 |
| `upright.stl` | 4 | 22 × 22 × 190 |
| `bridge_left.stl` | 1 | 91 × 186 × 26 |
| `bridge_right.stl` | 1 | 91 × 186 × 26 |
| `camera_cradle.stl` | 1 | 30 × 100 × 70 |
| `fit_coupon_socket.stl` | 1 before the full stand | 80 × 28 × 8 |
| `fit_coupon_peg.stl` | 1 before the full stand | 24 × 24 × 12 |

The STEP assembly includes approximate camera, ties, table and plate references;
those references are **not** print parts. Use the individual STLs for printing.
The fit coupons are extra test pieces and are not part of the nine-piece stand.

## Preparation

1. Print the two small fit coupons first. The socket coupon has holes with
   **0.2, 0.3 and 0.4 mm total clearance**, ordered from the smallest to largest
   hole. Test with the square peg. Aim for an easy sliding fit without noticeable
   rocking; the default stand clearance is 0.3 mm total, or 0.15 mm per side.
2. If the default fit is unsuitable, edit `fit_clearance` in `model.py` and
   regenerate the STLs before printing the stand. The coupon checks square post
   fits; separately check the rectangular bridge/cradle joint after printing.
3. Start with the shop's PLA profile. A provisional setup is a 0.4 mm nozzle,
   0.24 mm layers, four walls and 20–30% infill. These are starting settings,
   not a tested print recipe. Inspect the layer preview and the actual supports.
4. The files already sit on the build plane in proposed orientations: feet flat,
   uprights vertical, bridge halves on their broad sides and cradle on its edge.
   Use a brim for the narrow upright pieces and leave brim space around the parts.
   Clear any support from the accessible sockets. The enclosed beam cavity needs
   a bridging check; avoid supports trapped inside it. A shop operator may choose
   a different orientation or profile after inspecting the slice.
5. Read the slicer's total time and filament estimate before starting. Nine
   structural pieces will require several print jobs on a small bed. No G-code
   is supplied because the actual printer and approved profile are still unknown.

## Quick assembly

1. Set the two feet on a level table, with their long rails running front to
   back. Position the post centres approximately 400 mm apart.
2. Insert one upright into each foot, then a second upright on top of each first
   section. Seat the square shoulders fully. Each joint has 25 mm engagement.
3. Slide the two bridge tongues into opposite ends of the camera cradle. The
   cradle's flat camera deck faces up. Lower the two bridge pegs into the top
   upright sockets and seat their shoulders.
4. Lay the C920s lens down over the open centre notch. Fold/position its attached
   clip to clear the notch. Use two plastic ties through the paired slots, one
   around each end of the camera. Tighten gently without covering the lens or
   privacy shutter; open the shutter.
5. Leave USB cable slack and restrain it to the bridge so it cannot pull the
   camera. Support the assembled frame while checking joint fit, camera contact,
   wobble and the live view. Centre a plate under the camera before the demo.

The joints are slip fits with supporting shoulders, not locking snaps. They
are intended for a stationary demo. Disassemble the stand to move it. If a joint
is loose, adjust and reprint it before relying on the stand.

## Dimensions and verification

- Approximate lens height: **441 mm above the table**.
- Side post spacing: **400 mm centre to centre**.
- Foot length: **180 mm front to back**.
- Reference plate diameter: **280 mm**.
- Camera body and clip are approximate reference geometry; actual fit and
  live framing need checking with the C920s.

Digital checks passed for valid single component solids, closed STL meshes,
consistent mesh winding, print-envelope bounds, no volumetric intersections
between structural pieces, and STEP export/import. See `validation.json`.
These checks do not establish strength, tipping resistance, printed joint fit,
camera restraint, successful printing or an available printer slot. No physical
print or load test has been performed.

`model.py` builds the CAD with CadQuery 2.6.1; `make_preview.py` renders the actual
model. This work adds hardware design files only and changes no application
contracts, dependencies or capture software. The earlier plywood design remains
available in `../c920s-plywood-demo/` as a fabrication alternative.
