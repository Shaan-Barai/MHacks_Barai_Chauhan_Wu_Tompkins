"""Modular printed camera bridge, nine stand pieces and two plastic ties.

Native dimensions and STL coordinates are millimetres. All joints are
provisional push-together fits, with a coupon for testing the actual printer.
"""
from pathlib import Path
import json
import math
import struct

import cadquery as cq

HERE=Path(__file__).resolve().parent
P={"bed_limit":200.0,"fit_clearance":0.3,"post_outer":22.0,"post_bore":16.0,
   "post_peg":18.0,"peg_length":25.0,"post_body_length":165.0,
   "foot_length":180.0,"side_spacing":400.0,"foot_socket_top":42.0,
   "beam_bottom":414.0,"beam_top":438.0,"cradle_deck_top":444.0}


def box(x,y,z,dx,dy,dz):
    return cq.Workplane("XY").box(dx,dy,dz).translate((x,y,z))


def grounded(part):
    b=part.val().BoundingBox()
    return part.translate((-b.xmin,-b.ymin,-b.zmin))


def foot():
    # Two low rails and a central crosspiece form a stable, open footprint.
    part=box(0,-22.5,3,180,12,6).union(box(0,22.5,3,180,12,6))
    part=part.union(box(0,0,3,38,57,6))
    part=part.union(box(0,0,24,26,26,36))
    socket=P["post_peg"]+P["fit_clearance"]
    return part.cut(box(0,0,29.5,socket,socket,25)).clean()


def post():
    outer=P["post_outer"];length=P["post_body_length"]
    part=box(0,0,length/2,outer,outer,length)
    part=part.cut(box(0,0,length/2,P["post_bore"],P["post_bore"],length+2))
    part=part.union(box(0,0,-12.5,P["post_peg"],P["post_peg"],25))
    part=part.cut(box(0,0,-12.5,12,12,27))
    socket=P["post_peg"]+P["fit_clearance"]
    # 25 mm socket at the upper end; the central bore makes it easy to clean.
    part=part.cut(box(0,0,length-12.5,socket,socket,25.02))
    return part.clean()


def left_bridge():
    # The local upright connection starts at z=0. It is assembled at z=372.
    part=box(0,-200,-12.5,18,18,25)
    part=part.union(box(0,-200,33,22,22,66))
    part=part.union(box(0,-130.5,54,26,161,24)) # y=-211..-50, z=42..66
    # Closed ends and a hollow beam keep the reference volume small.
    part=part.cut(box(0,-124,54,20,134,18))
    part=part.cut(box(0,-200,17,14,14,60))
    # Tongue enters the centre cradle from the side.
    part=part.union(box(0,-37.5,54,18,25,16))
    return part.clean()


def cradle():
    # Reference z=0 is the underside of the receiver blocks.
    part=box(0,0,27,70,100,6)
    for y in (-35,35):
        part=part.union(box(0,y,12,26,30,24))
        # Slightly more than 25 mm of open-ended engagement.
        part=part.cut(box(0,y+(-2.75 if y<0 else 2.75),12,
                          18+P["fit_clearance"],25.5,16+P["fit_clearance"]))
    # An open clearance notch lets the camera's original clip remain attached.
    part=part.cut(box(15.5,0,27,41,42,8)) # x=-5..36, open on +X edge
    # Enlarge optical clearance on the negative-X side as well.
    part=part.cut(box(-12.5,0,27,15,42,8))
    for x in (-24,24):
        for y in (-33,33):part=part.cut(box(x,y,27,4,7,8))
    return part.clean()


def coupon():
    # Three open sockets and one removable peg test 0.2/0.3/0.4 mm total clearance.
    part=box(0,0,4,80,28,8)
    for x,clear in ((-26,.2),(0,.3),(26,.4)):
        part=part.cut(box(x,0,4,18+clear,18+clear,10))
    peg=box(0,0,4,18,18,8).union(box(0,0,10,24,24,4))
    return part.clean(),peg.clean()


def make_parts():
    native={"foot":foot(),"upright":post(),"bridge_left":left_bridge(),
            "bridge_right":left_bridge().mirror("XZ"),"camera_cradle":cradle()}
    scene={}
    for side,y in (("left",-200),("right",200)):
        scene[f"{side}_foot"]=(native["foot"].translate((0,y,0)),"printed")
        for index,z in enumerate((42,207)):
            scene[f"{side}_upright_{index+1}"]=(native["upright"].translate((0,y,z)),"printed")
        scene[f"{side}_bridge"]=(native[f"bridge_{side}"].translate((0,0,372)),"printed")
    scene["camera_cradle"]=(native["camera_cradle"].translate((0,0,414)),"cradle")
    top=P["cradle_deck_top"]
    scene["C920s_reference"]=(box(0,0,top+12,29,94,24).edges("|Z").fillet(4),"camera")
    scene["camera_clip_reference"]=(box(28.5,0,top+13,28,36,38),"camera")
    scene["lens_reference"]=(cq.Workplane("XY",origin=(0,0,top-3)).circle(8).extrude(3),"lens")
    # The camera remains restrained with two plastic ties; no metal screw needed.
    for y in (-33,33):
        band=(cq.Workplane("XZ").polyline([(-24.6,437),(24.6,437),(24.6,top),
              (15.2,top+25),(-15.2,top+25),(-24.6,top)]).close().extrude(3))
        inside=(cq.Workplane("XZ").polyline([(-24,437.6),(24,437.6),(24,top),
                (14.6,top+24.4),(-14.6,top+24.4),(-24,top)]).close().extrude(3))
        scene[f"plastic_tie_{y}"]=(band.cut(inside).translate((0,y+1.5,0)),"nylon")
    scene["table_reference"]=(box(0,0,-12,560,560,24),"table")
    scene["dish_reference"]=(cq.Workplane("XY").circle(140).extrude(3)
                                 .faces(">Z").workplane().circle(128).extrude(1),"dish")
    return native,scene


def inspect_stl(path):
    data=path.read_bytes();count=struct.unpack_from("<I",data,80)[0]
    assert len(data)==84+50*count
    edges={};directed={};volume=0.;vertices=[]
    for i in range(count):
        values=struct.unpack_from("<12fH",data,84+50*i)
        tri=[tuple(round(v,4) for v in values[j:j+3]) for j in (3,6,9)]
        vertices.extend(tri)
        a,b,c=tri
        cross=(b[1]*c[2]-b[2]*c[1],b[2]*c[0]-b[0]*c[2],b[0]*c[1]-b[1]*c[0])
        volume+=sum(a[k]*cross[k] for k in range(3))/6
        for j in range(3):
            u,v=tri[j],tri[(j+1)%3];key=tuple(sorted((u,v)))
            edges[key]=edges.get(key,0)+1;directed[(u,v)]=directed.get((u,v),0)+1
    assert all(n==2 for n in edges.values())
    assert all(directed.get((v,u),0)==n for (u,v),n in directed.items())
    assert volume>0
    bounds=[(min(v[k] for v in vertices),max(v[k] for v in vertices)) for k in range(3)]
    size=[round(b-a,3) for a,b in bounds]
    assert all(s<=P["bed_limit"] for s in size),size
    assert all(abs(a)<.001 for a,b in bounds),bounds
    return {"watertight":True,"consistent_winding":True,"triangles":count,
            "print_bounds_mm":size,"mesh_volume_mm3":round(volume,2)}


def export():
    native,scene=make_parts()
    quantity={"foot":2,"upright":4,"bridge_left":1,"bridge_right":1,"camera_cradle":1}
    # STL coordinates are grounded in their proposed print orientations.
    oriented={"foot":native["foot"],"upright":native["upright"],
      "bridge_left":native["bridge_left"].rotate((0,0,0),(0,1,0),-90),
      "bridge_right":native["bridge_right"].rotate((0,0,0),(0,1,0),-90),
      "camera_cradle":native["camera_cradle"].rotate((0,0,0),(0,1,0),-90)}
    socket,peg=coupon();oriented.update({"fit_coupon_socket":socket,"fit_coupon_peg":peg})
    reports={}
    for name,part in oriented.items():
        shape=part.val();assert shape.isValid() and len(shape.Solids())==1,name
        printable=grounded(part)
        path=HERE/f"{name}.stl"
        cq.exporters.export(printable,str(path),tolerance=.15,angularTolerance=.12)
        reports[name]=inspect_stl(path)
        assert math.isclose(reports[name]["mesh_volume_mm3"],shape.Volume(),rel_tol=.002),name
        reports[name]["quantity"]=quantity.get(name,1)
    assy=cq.Assembly(name="C920s_modular_printed_demo_stand")
    colors={"printed":(.26,.51,.43),"cradle":(.18,.37,.31),"camera":(.20,.23,.24),
            "lens":(.12,.19,.22),"nylon":(.16,.24,.16),"table":(.82,.80,.73),"dish":(.93,.95,.91)}
    meshes=[]
    for name,(part,kind) in scene.items():
        assert part.val().isValid() and len(part.val().Solids())==1,name
        assy.add(part,name=name,color=cq.Color(*colors[kind]))
        verts,tris=part.val().tessellate(.5,.20)
        meshes.append({"name":name,"kind":kind,"vertices":[[round(v.x,4),round(v.y,4),round(v.z,4)] for v in verts],
                       "triangles":[list(tri) for tri in tris]})
    frame=[name for name,(_,kind) in scene.items() if kind in ("printed","cradle")]
    collisions=[]
    for i,a in enumerate(frame):
        for b in frame[i+1:]:
            overlap=scene[a][0].intersect(scene[b][0]).val().Volume()
            if overlap>1e-4:collisions.append({"parts":[a,b],"overlap_mm3":round(overlap,4)})
    assert not collisions,collisions
    assy.save(str(HERE/"printed-demo-stand.step"))
    imported=cq.importers.importStep(str(HERE/"printed-demo-stand.step")).solids().vals()
    assert len(imported)==len(scene)
    assert math.isclose(sum(s.Volume() for s in imported),sum(p.val().Volume() for p,_ in scene.values()),rel_tol=1e-7)
    (HERE/"preview-mesh.json").write_text(json.dumps(meshes,separators=(",",":")))
    report={"parameters_mm":P,"stand_piece_count":sum(quantity.values()),"added_metal_hardware":False,
      "stl_parts":reports,"frame_intersections":collisions,"step_roundtrip":True,
      "unverified":["Duderstadt printer/filament access","print time and supports",
                    "joint fit and stiffness","physical camera fit and restraint","live framing"]}
    (HERE/"validation.json").write_text(json.dumps(report,indent=2)+'\n')
    (HERE/"print-manifest.json").write_text(json.dumps({"units":"mm","parts":quantity,
       "fit_coupon":"Print both coupon files first; choose/test actual fit before full printing",
       "camera_restraint":"Two plastic ties; source locally",
       "nominal_printer_envelope_mm":[200,200,200]},indent=2)+'\n')
    print(json.dumps({"stand_pieces":sum(quantity.values()),"watertight_files":len(reports),
                      "print_bounds_fit":True,"frame_intersections":collisions,"step_roundtrip":True}))


if __name__=="__main__":export()
