# Duderstadt plywood camera stand — earlier sheet-wood option

The latest requested design is the [3D-printed version](../c920s-printed-demo/README.md).
This sheet-wood package remains available as an alternative.

**Five plywood pieces and two plastic ties.** Slide together a tabletop bridge,
lay the C920s face down over the camera notch, and secure its two ends with the
ties. The camera's lens and privacy shutter stay clear. Keep its original folding
clip attached and position it in the open notch. No added metal hardware, camera
screw, purchased stand, wall fixing, or table clamp is required.

The freestanding design supplies the camera height itself, so it does not depend
on a nearby wall, shelf, divider, or mounting edge. It is a bench/demo prototype.

## What is confirmed at the Dude

[Fabrication Underground](https://www.dc.umich.edu/fabrication-underground/),
room B430, lists laser cutting of compatible laser-safe wood products and a
woodshop with saws, hand tools and drills. This supports a sheet-wood build.
The site does **not** confirm current plywood stock, plastic-tie stock, or an
available machine slot. Ask staff what material is actually available before
cutting. No material availability is claimed by this CAD package.

The published Fab walk-in hours are **Monday–Friday, 9 am–6 pm, closed weekends**.
The page also requires equipment certification/reservation. It says account
setup after training can take 1–2 business days. Special hackathon access is
unverified; normal hours alone do not establish access on Saturday, October 3.

## Fabrication files

- `plywood-demo-stand.step` — assembled stand, approximate camera, plastic tie
  paths, table and plate reference geometry.
- `side.step` — make two identical side panels.
- `bridge.step` — make one top bridge.
- `key.step` — make two identical wooden retaining keys.
- `plywood-cut-layout.dxf` / `plywood-cut-layout.svg` — 1:1 sheet outlines in mm;
  the packed layout is 850 × 600 mm. Rearrange the parts for the actual stock and
  machine bed if needed. Use only the **CUT** layer/group for cutting.
- `slot-fit-coupon.dxf` — a 90 × 36 mm coupon with slots 5.8, 6.0, 6.2 and
  6.4 mm wide for the default stock. Cut this first and check with the actual wood.
- `model.py` — parametric CAD and cut-file generator, using CadQuery 2.6.1 and
  ezdxf. Set `sheet_thickness` to the measured stock thickness and tune
  `slot_clearance` after the coupon; rerun before cutting the full stand.
- `preview.png` and `validation.json` — preview and digital verification.

The default is **6 mm plywood**, with 0.25 mm total slot clearance. This is a
provisional material choice, not a statement that 6 mm plywood is stocked.
The CAD dimensions describe finished geometry; kerf compensation has not been
applied. Let the shop's workflow and fit coupon determine the cut offset.
Use staff-approved laser-safe sheet stock and their machine settings. Do not
substitute thin cardboard at the same dimensions and assume equal stiffness.

## Dimensions and setup

| Feature | Default dimension |
| --- | --- |
| Bridge top | 440 mm span × 100 mm depth |
| Side-panel spacing | 400 mm centre to centre |
| Side-panel feet | 240 mm front to back |
| Height under bridge | 430 mm |
| Camera lens above table, approximate | 433 mm |
| Sheet thickness | 6 mm, to be measured |
| Camera clearance notch | 70 × 42 mm, open at rear edge |
| Tie paths | Two, 66 mm apart, through four slots |

1. Place the two side panels upright, parallel, on a level table.
2. Lower the bridge over their top tabs until it rests on the shoulders.
3. Slide one wooden T-key through each top tab to retain the bridge. Keys are
   retaining stops; their fit needs checking on the actual cut pieces.
4. Place the C920s lens down over the central notch. Fold/position the existing
   clip so it clears the notch. Thread two **plastic** ties through the paired
   slots and around the camera's ends; gently tighten. Keep the lens and shutter
   free, and open the shutter. The CAD's camera shape is approximate.
5. Leave slack in the USB cable and secure it to the bridge so cable tension
   does not pull the camera. Check the stand's wobble and the live camera view
   before releasing it. Centre a plate beneath the lens.

The plate reference is 280 mm across. The 433 mm camera height and 400 mm side
spacing are starting assumptions for keeping the stand outside the centred
square crop. Verify framing on the real camera. Support the hub and Uno Q
separately. The design has not been physically load-tested or assembled.

## Verification and handoff

Digital checks cover valid component solids, STEP import/export round-trip,
no volumetric intersections between plywood pieces, no overlapping pieces in
the cutting layout, closed DXF cutting loops and sheet-layout bounds. These
checks do not confirm local material stock, access, wood stiffness, joint fit,
camera-body contact, tie restraint or live framing.

This package is the earlier sheet-wood design for the user's no-metal/local-fabrication
constraint. It changes no application contracts, capture software, root
dependencies or database files. Earlier metal-stand and wall concepts are
retained as previous options.
