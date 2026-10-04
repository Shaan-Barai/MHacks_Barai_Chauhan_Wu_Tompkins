"""Placement CAD for a purchased clamp/gooseneck webcam stand; millimetres.

This is generic reference geometry, not fabrication drawings for a clamp.
Use a ready-made metal stand for the demo. No custom printed parts required.
"""
from pathlib import Path
import json
import math

import cadquery as cq

HERE = Path(__file__).resolve().parent
P = {"table_thickness": 25.0, "camera_lens_height": 398.0,
     "straight_stem_length": 315.0, "bend_radius": 90.0,
     "horizontal_length": 150.0, "arm_diameter": 14.0,
     "plate_diameter": 280.0}


def box(x,y,z,dx,dy,dz):
    return cq.Workplane("XY").box(dx,dy,dz).translate((x,y,z))


def cylinder_z(x,y,z,r,length):
    return cq.Workplane("XY",origin=(x,y,z)).circle(r).extrude(length)


def cylinder_x(x,y,z,r,length):
    return cq.Workplane("YZ",origin=(x,y,z)).circle(r).extrude(length)


def make_parts():
    # Table is reference context. Its back edge is x=25, surface z=0.
    table=box(235,0,-12.5,420,380,25)
    # Generic metal C-clamp: upper jaw, spine, lower jaw. Purchased, not printed.
    clamp=(box(14,0,12,64,42,16)
           .union(box(-10,0,-19,16,42,78))
           .union(box(14,0,-50,64,42,16)))
    clamp=clamp.cut(cylinder_z(36,0,-60,4.2,22)).clean()
    upper_pad=box(35,0,2,22,36,4)
    screw=cylinder_z(36,0,-80,4,-29-(-80))
    pressure_pad=cylinder_z(36,0,-29,10,4)
    knob=cylinder_z(36,0,-84,17,9)
    # A representative ~63 cm flexible arm, bent up and over the dish.
    stem=cylinder_z(0,0,20,7,P["straight_stem_length"])
    radius=P["bend_radius"]
    z0=20+P["straight_stem_length"]
    mid=(radius-radius/math.sqrt(2),0,z0+radius/math.sqrt(2))
    end=(radius,0,z0+radius)
    arc=cq.Edge.makeThreePointArc(cq.Vector(0,0,z0),cq.Vector(*mid),cq.Vector(*end))
    path=cq.Wire.assembleEdges([arc])
    elbow=cq.Workplane("XY",origin=(0,0,z0)).circle(7).sweep(path)
    horizontal=cylinder_x(radius,0,end[2],7,P["horizontal_length"])
    arm=stem.union(elbow).union(horizontal).clean()
    # Ball head/reference camera orientation: tripod base vertical, lens down.
    head=box(250,0,425,20,25,30)
    camera_clip=box(271,0,417,22,36,38)
    camera_body=box(296.5,0,413,29,94,24).edges("|Z").fillet(4)
    lens=cylinder_z(296.5,0,398,8,3)
    dish=(cq.Workplane("XY",origin=(296.5,0,0)).circle(P["plate_diameter"]/2)
          .extrude(3).faces(">Z").workplane().circle(P["plate_diameter"]/2-12).extrude(1))
    return {
      "clamp_reference":(clamp,"stand"), "upper_pad_reference":(upper_pad,"pad"),
      "clamp_screw_reference":(screw,"hardware"), "pressure_pad_reference":(pressure_pad,"hardware"),
      "clamp_knob_reference":(knob,"hardware"), "flexible_arm_reference":(arm,"stand"),
      "ball_head_reference":(head,"hardware"), "camera_clip_reference":(camera_clip,"camera"),
      "C920s_body_reference":(camera_body,"camera"), "camera_lens_reference":(lens,"lens"),
      "table_reference":(table,"table"), "dish_reference":(dish,"dish")}


def export():
    parts=make_parts()
    assembly=cq.Assembly(name="Scrap_fast_demo_mount_placement")
    colors={"stand":(0.15,0.35,0.28),"pad":(0.16,0.18,0.17),"hardware":(0.30,0.34,0.31),
            "camera":(0.17,0.20,0.22),"lens":(0.12,0.18,0.22),
            "table":(0.77,0.72,0.62),"dish":(0.91,0.94,0.91)}
    scene=[];check={}
    for name,(part,kind) in parts.items():
        shape=part.val()
        assert shape.isValid() and len(shape.Solids())==1,name
        assembly.add(part,name=name,color=cq.Color(*colors[kind]))
        verts,triangles=shape.tessellate(0.8,0.24)
        scene.append({"name":name,"kind":kind,"vertices":[[round(v.x,4),round(v.y,4),round(v.z,4)] for v in verts],
                      "triangles":[list(t) for t in triangles]})
        check[name]={"valid_solid":True,"volume_mm3":round(shape.Volume(),2)}
    assembly.save(str(HERE/"demo-mount-layout.step"))
    imported=cq.importers.importStep(str(HERE/"demo-mount-layout.step"))
    assert len(imported.solids().vals())==len(parts)
    expected=sum(part.val().Volume() for part,_ in parts.values())
    actual=sum(s.Volume() for s in imported.solids().vals())
    assert math.isclose(expected,actual,rel_tol=1e-7)
    (HERE/"preview-mesh.json").write_text(json.dumps(scene,separators=(",",":")))
    (HERE/"validation.json").write_text(json.dumps({"parameters_mm":P,"parts":check,
        "step_roundtrip":True,"solid_count":len(parts),
        "purpose":"Placement reference for purchased hardware; no STL/fabrication specification",
        "unverified":["actual stand dimensions and tilt range","clamp fit on demo table","stability","camera framing"]},indent=2)+"\n")
    print(json.dumps({"valid_solids":len(parts),"step_roundtrip":True,"lens_height_mm":P["camera_lens_height"]}))


if __name__=="__main__":export()
