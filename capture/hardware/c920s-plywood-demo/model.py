"""Five-part plywood camera bridge, using wooden keys and plastic ties.

All dimensions are millimetres. No added metal hardware. Confirm sheet stock,
measured thickness, and shop access before using the cut files.
"""
from pathlib import Path
import json
import math

import cadquery as cq
import ezdxf

HERE=Path(__file__).resolve().parent
P={"sheet_thickness":6.0,"slot_clearance":0.25,"bridge_height":430.0,
   "side_spacing":400.0,"bridge_length":440.0,"bridge_depth":100.0,
   "foot_depth":240.0,"tenon_width":60.0,"tenon_height":24.0}


def box(x,y,z,dx,dy,dz):
    return cq.Workplane("XY").box(dx,dy,dz).translate((x,y,z))


def profile(points):
    return cq.Workplane("XY").polyline(points).close().extrude(P["sheet_thickness"])


def outlines():
    t,c,h=P["sheet_thickness"],P["slot_clearance"],P["bridge_height"]
    foot=P["foot_depth"]/2;tenon=P["tenon_width"]/2
    side=[(-foot,0),(foot,0),(85,140),(50,h),(tenon,h),
          (tenon,h+P["tenon_height"]),(-tenon,h+P["tenon_height"]),
          (-tenon,h),(-50,h),(-85,140)]
    # Coordinates are finished outlines, with no laser kerf compensation applied.
    triangle=[(-65,70),(65,70),(0,340)]
    key_slot=rect_loop(0,h+t+0.15+(t+c)/2,26.25,t+c)
    depth=P["bridge_depth"]/2;length=P["bridge_length"]/2
    # Open notch clears the lens and the existing folding camera clip.
    deck=[(-depth,-length),(depth,-length),(depth,-21),(-20,-21),
          (-20,21),(depth,21),(depth,length),(-depth,length)]
    slots=[rect_loop(0,y,P["tenon_width"]+c,t+c)
           for y in (-P["side_spacing"]/2,P["side_spacing"]/2)]
    slots += [rect_loop(x,y,4,7) for x in (-24,24) for y in (-33,33)]
    key=[(-17,-23),(17,-23),(17,-14),(12,-14),(12,23),
         (-12,23),(-12,-14),(-17,-14)]
    return {"side":(side,[triangle,key_slot]),"bridge":(deck,slots),"key":(key,[])}


def rect_loop(x,y,w,h):
    return [(x-w/2,y-h/2),(x+w/2,y-h/2),(x+w/2,y+h/2),(x-w/2,y+h/2)]


def from_loops(outer,holes):
    part=profile(outer)
    for hole in holes:part=part.cut(profile(hole))
    return part.clean()


def make_parts():
    t=P["sheet_thickness"];h=P["bridge_height"];spacing=P["side_spacing"]
    flat={name:from_loops(*loops) for name,loops in outlines().items()}
    parts={}
    for name,y in (("left_side",-spacing/2),("right_side",spacing/2)):
        parts[name]=(flat["side"].rotate((0,0,0),(1,0,0),90).translate((0,y+t/2,0)),"plywood")
        # T-key shoulder stops against the near face of the upright.
        parts[name+"_key"]=(flat["key"].translate((0,y+14-t/2,h+t+0.15)),"key")
    parts["bridge"]=(flat["bridge"].translate((0,0,h)),"plywood")
    # Approximate C920s body rotated so the optical axis is -Z. Existing clip stays attached.
    top=h+t
    parts["camera_body_reference"]=(box(0,0,top+12,29,94,24).edges("|Z").fillet(4),"camera")
    parts["camera_clip_reference"]=(box(28.5,0,top+13,28,36,38),"camera")
    parts["lens_reference"]=(cq.Workplane("XY",origin=(0,0,top-3)).circle(8).extrude(3),"lens")
    # Plastic bands show the two tie paths; not manufacturing specifications for ties.
    for y in (-33,33):
        band=(cq.Workplane("XZ").polyline([(-24.6,h-1),(24.6,h-1),(24.6,top),
              (15.2,top+25),(-15.2,top+25),(-24.6,top)]).close().extrude(3))
        inner=(cq.Workplane("XZ").polyline([(-24,h-.4),(24,h-.4),(24,top),
               (14.6,top+24.4),(-14.6,top+24.4),(-24,top)]).close().extrude(3))
        parts[f"plastic_tie_{int(y)}"]=(band.cut(inner).translate((0,y+1.5,0)),"nylon")
    parts["table_reference"]=(box(0,0,-12,560,560,24),"table")
    parts["dish_reference"]=(cq.Workplane("XY").circle(140).extrude(3)
                                .faces(">Z").workplane().circle(128).extrude(1),"dish")
    return flat,parts


def cut_files():
    loops=outlines()
    # 850 x 600 layout: two uprights, the bridge, and two wooden keys.
    placements=[("SIDE A","side",130,20,0),("SIDE B","side",385,20,0),
                ("BRIDGE","bridge",630,260,0),
                ("KEY A","key",745,385,0),("KEY B","key",790,385,0)]
    packed=[]
    for label,kind,x,y,angle in placements:
        solid=from_loops(*loops[kind]).rotate((0,0,0),(0,0,1),angle).translate((x,y,0))
        for previous_name,previous in packed:
            assert solid.intersect(previous).val().Volume()<1e-5,(label,previous_name)
        packed.append((label,solid))
    def transform(pts,ox,oy,angle):
        co,si=math.cos(math.radians(angle)),math.sin(math.radians(angle))
        return [(round(ox+co*x-si*y,4),round(oy+si*x+co*y,4)) for x,y in pts]
    doc=ezdxf.new("R2010");doc.units=4
    doc.layers.new("CUT",dxfattribs={"color":1})
    doc.layers.new("LABELS_NOT_FOR_CUTTING",dxfattribs={"color":8})
    ms=doc.modelspace();paths=[];labels=[]
    for label,kind,x,y,angle in placements:
        outer,holes=loops[kind]
        for pts in (outer,*holes):
            placed=transform(pts,x,y,angle)
            assert all(0<=px<=850 and 0<=py<=600 for px,py in placed)
            ms.add_lwpolyline(placed,close=True,dxfattribs={"layer":"CUT"})
            paths.append('<path d="M '+ ' L '.join(f'{px} {600-py}' for px,py in placed)+' Z"/>')
        ms.add_text(label,dxfattribs={"layer":"LABELS_NOT_FOR_CUTTING","height":5,"insert":(x-25,y-12)})
        labels.append(f'<text x="{x-25}" y="{600-y+12}">{label}</text>')
    doc.saveas(HERE/"plywood-cut-layout.dxf")
    (HERE/"plywood-cut-layout.svg").write_text(
      '<svg xmlns="http://www.w3.org/2000/svg" width="850mm" height="600mm" viewBox="0 0 850 600">'
      '<g id="CUT" fill="none" stroke="red" stroke-width="0.01">'+''.join(paths)+'</g>'
      '<g id="LABELS_NOT_FOR_CUTTING" fill="#666" font-family="Arial" font-size="5">'+''.join(labels)+'</g></svg>')
    # Small fit coupon: choose slot fit on the actual stock before cutting the frame.
    widths=[P["sheet_thickness"]+delta for delta in (-.2,0,.2,.4)]
    coupon=box(45,18,t:=P["sheet_thickness"]/2,90,36,P["sheet_thickness"])
    for x,width in zip((15,35,55,75),widths):
        coupon=coupon.cut(box(x,31,t,width,14,P["sheet_thickness"]+2))
    cq.exporters.export(coupon.faces(">Z").wires().toPending(),str(HERE/"slot-fit-coupon.dxf"))


def export():
    flat,parts=make_parts()
    assy=cq.Assembly(name="C920s_five_piece_plywood_demo_stand")
    colors={"plywood":(.77,.63,.41),"key":(.61,.45,.24),"camera":(.20,.23,.24),
            "lens":(.12,.19,.22),"nylon":(.16,.24,.16),"table":(.82,.80,.73),"dish":(.93,.95,.91)}
    report={};scene=[]
    for name,(part,kind) in parts.items():
        shape=part.val();assert shape.isValid() and len(shape.Solids())==1,name
        assy.add(part,name=name,color=cq.Color(*colors[kind]))
        verts,tris=shape.tessellate(.5,.20)
        scene.append({"name":name,"kind":kind,"vertices":[[round(v.x,4),round(v.y,4),round(v.z,4)] for v in verts],
                     "triangles":[list(tri) for tri in tris]})
        report[name]={"valid_solid":True,"volume_mm3":round(shape.Volume(),2)}
    wood=[name for name,(_,kind) in parts.items() if kind in ("plywood","key")]
    collisions=[]
    for i,a in enumerate(wood):
        for b in wood[i+1:]:
            overlap=parts[a][0].intersect(parts[b][0]).val().Volume()
            if overlap>1e-4:collisions.append({"parts":[a,b],"overlap_mm3":overlap})
    assert not collisions,collisions
    assy.save(str(HERE/"plywood-demo-stand.step"))
    imported=cq.importers.importStep(str(HERE/"plywood-demo-stand.step"))
    solids=imported.solids().vals();assert len(solids)==len(parts)
    assert math.isclose(sum(s.Volume() for s in solids),sum(p.val().Volume() for p,_ in parts.values()),rel_tol=1e-7)
    for name,part in flat.items():cq.exporters.export(part,str(HERE/f"{name}.step"))
    cut_files()
    # Re-read the DXF rather than trusting only its in-memory creation.
    drawing=ezdxf.readfile(HERE/"plywood-cut-layout.dxf")
    cut_loops=list(drawing.modelspace().query('LWPOLYLINE[layer=="CUT"]'))
    assert len(cut_loops)==15 and all(e.closed for e in cut_loops)
    assert drawing.units==4
    (HERE/"preview-mesh.json").write_text(json.dumps(scene,separators=(",",":")))
    (HERE/"validation.json").write_text(json.dumps({"parameters_mm":P,"parts":report,
      "stand_piece_count":5,"added_metal_hardware":False,"wood_intersections":collisions,
      "step_roundtrip":True,"cut_paths_closed":True,"cut_loop_count":len(cut_loops),
      "cut_units":"millimetres","cut_layout_nonoverlapping":True,"cut_layout_mm":[850,600],
      "unverified":["Duderstadt material stock and event access","actual plywood thickness and kerf",
                    "camera shape and clip clearance","physical stiffness and stability","live framing"]},indent=2)+"\n")
    print(json.dumps({"stand_pieces":5,"valid_solids":len(parts),"wood_intersections":len(collisions),"step_roundtrip":True}))


if __name__=="__main__":export()
