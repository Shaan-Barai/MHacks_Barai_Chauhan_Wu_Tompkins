"""Simple fixed C920s wall bracket; dimensions in millimetres.

Run with CadQuery 2.6.1. Outputs STEP, STL, drawing geometry, and validation.
The camera is an approximate clearance reference, not a manufacturer CAD model.
"""

from pathlib import Path
import json
import math
import struct

import cadquery as cq

HERE = Path(__file__).resolve().parent
P = {
    "wall_width": 90.0,
    "wall_height": 120.0,
    "thickness": 8.0,
    "arm_reach": 200.0,  # from front of wall plate to outside of camera tab
    "arm_width": 40.0,
    "arm_bottom": 20.0,
    "gusset_width": 12.0,
    "gusset_bottom": -54.0,
    "tab_height": 60.0,
    "tab_bottom": -32.0,
    "camera_hole_height": -12.0,
    "camera_hole_diameter": 6.8,
    "wall_hole_diameter": 5.5,
    "wall_hole_pitch_y": 60.0,
    "wall_hole_pitch_z": 90.0,
}


def box(x, y, z, dx, dy, dz):
    return cq.Workplane("XY").box(dx, dy, dz).translate((x, y, z))


def cylinder_x(x, y, z, radius, length):
    return cq.Workplane("YZ", origin=(x, y, z)).circle(radius).extrude(length)


def bracket(p=P):
    t, reach, w = p["thickness"], p["arm_reach"], p["arm_width"]
    end = t + reach
    plate = box(t / 2, 0, 0, t, p["wall_width"], p["wall_height"])
    plate = plate.edges("|X").fillet(4)
    arm = box(t + reach / 2, 0, p["arm_bottom"] + t / 2, reach, w, t)
    # Small overlaps make the gusset's connections robust to CAD tolerances.
    rib = (
        cq.Workplane("XZ")
        .polyline([(t - 0.4, p["gusset_bottom"]),
                   (t - 0.4, p["arm_bottom"] + 0.4),
                   (end - 14, p["arm_bottom"] + 0.4)])
        .close().extrude(p["gusset_width"])
        .translate((0, p["gusset_width"] / 2, 0))
    )
    tab = box(end - t / 2, 0, p["tab_bottom"] + p["tab_height"] / 2,
              t, w, p["tab_height"])
    tab = tab.edges("|X").fillet(2)
    result = plate.union(arm).union(rib).union(tab)
    for y in (-p["wall_hole_pitch_y"] / 2, p["wall_hole_pitch_y"] / 2):
        for z in (-p["wall_hole_pitch_z"] / 2, p["wall_hole_pitch_z"] / 2):
            result = result.cut(cylinder_x(-1, y, z, p["wall_hole_diameter"] / 2, t + 2))
    result = result.cut(cylinder_x(end - t - 1, 0, p["camera_hole_height"],
                                   p["camera_hole_diameter"] / 2, t + 2))
    return result.clean()


def camera_reference(p=P):
    """Rotated 90 degrees: tripod base against tab; lens points along -Z.

    Body width 94, height 29, depth 24 follow Logitech's specifications.
    Clip geometry and placement are provisional fit-check envelopes.
    """
    end = p["thickness"] + p["arm_reach"]
    parts = {
        "camera_clip_reference": box(end + 11, 0, -8, 22, 36, 38),
        "camera_body_reference": box(end + 36.5, 0, 0, 29, 94, 24).edges("|Z").fillet(4),
        "camera_lens_reference": cq.Workplane("XY", origin=(end + 36.5, 0, -15))
            .circle(8).extrude(3),
    }
    return parts


def mesh(shape):
    vertices, triangles = shape.val().tessellate(0.25, 0.18)
    return {
        "vertices": [[round(v.x, 4), round(v.y, 4), round(v.z, 4)] for v in vertices],
        "triangles": [list(t) for t in triangles],
    }


def inspect_stl(path):
    """Check indexed mesh closure independently of the CAD solid validator."""
    data = path.read_bytes()
    count = struct.unpack_from("<I", data, 80)[0]
    assert len(data) == 84 + count * 50
    edges, vertices, directed = {}, set(), {}
    volume = 0.0
    for i in range(count):
        values = struct.unpack_from("<12fH", data, 84 + i * 50)
        tri = [tuple(round(v, 4) for v in values[j:j + 3]) for j in (3, 6, 9)]
        vertices.update(tri)
        a, b, c = tri
        cross = (b[1] * c[2] - b[2] * c[1],
                 b[2] * c[0] - b[0] * c[2],
                 b[0] * c[1] - b[1] * c[0])
        volume += sum(a[k] * cross[k] for k in range(3)) / 6
        for j in range(3):
            u, v = tri[j], tri[(j + 1) % 3]
            key = tuple(sorted((u, v)))
            edges[key] = edges.get(key, 0) + 1
            directed[(u, v)] = directed.get((u, v), 0) + 1
    assert all(n == 2 for n in edges.values()), "STL has an open or nonmanifold edge"
    assert all(directed.get((v, u), 0) == n for (u, v), n in directed.items()), "STL winding mismatch"
    assert volume > 0
    return {"triangles": count, "vertices": len(vertices), "watertight": True,
            "consistent_winding": True, "volume_mm3": round(volume, 2)}


def export():
    mount = bracket()
    shape = mount.val()
    assert shape.isValid() and len(shape.Solids()) == 1
    cq.exporters.export(mount, str(HERE / "c920s-wall-mount.step"))
    # The STL is intentionally the bracket only. Lay the back of the wall plate
    # on the bed; original +X becomes printer +Z. Support the end-tab overhang.
    printable = mount.rotate((0, 0, 0), (0, 1, 0), -90).translate((60, 45, 0))
    cq.exporters.export(printable, str(HERE / "c920s-wall-mount.stl"),
                        tolerance=0.15, angularTolerance=0.12)
    references = camera_reference()
    assembly = cq.Assembly(name="Scrap_C920s_wall_mount_concept")
    assembly.add(mount, name="bracket", color=cq.Color(0.17, 0.48, 0.42))
    for name, part in references.items():
        assembly.add(part, name=name, color=cq.Color(0.2, 0.23, 0.25))
    assembly.save(str(HERE / "assembly-with-camera-reference.step"))
    # Mesh data is derived from the CAD model, not a separately drawn approximation.
    scene = [{"name": "bracket", "kind": "bracket", **mesh(mount)}]
    scene += [{"name": name, "kind": "lens" if "lens" in name else "camera", **mesh(part)}
              for name, part in references.items()]
    (HERE / "preview-mesh.json").write_text(json.dumps(scene, separators=(",", ":")))
    imported = cq.importers.importStep(str(HERE / "c920s-wall-mount.step")).val()
    assert imported.isValid() and len(imported.Solids()) == 1
    assert math.isclose(imported.Volume(), shape.Volume(), rel_tol=1e-7)
    bounds = shape.BoundingBox()
    report = {
        "parameters_mm": P,
        "cad": {"valid_solid": True, "solid_count": 1, "step_roundtrip": True,
                "volume_mm3": round(shape.Volume(), 2),
                "bounding_box_mm": [round(bounds.xlen, 3), round(bounds.ylen, 3), round(bounds.zlen, 3)]},
        "stl": inspect_stl(HERE / "c920s-wall-mount.stl"),
        "not_verified": ["physical C920s clip fit", "wall anchors", "printed load capacity", "view framing"],
    }
    assert math.isclose(report["stl"]["volume_mm3"], shape.Volume(), rel_tol=0.002)
    (HERE / "validation.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["cad"]))
    print(json.dumps(report["stl"]))


if __name__ == "__main__":
    export()
