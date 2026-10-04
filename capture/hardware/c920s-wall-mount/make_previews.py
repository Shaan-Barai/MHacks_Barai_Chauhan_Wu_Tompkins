"""Render the exported CAD tessellation and dimensioned concept drawings."""
from pathlib import Path
import json
import math
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
P = json.loads((HERE / "validation.json").read_text())["parameters_mm"]
SCENE = json.loads((HERE / "preview-mesh.json").read_text())


def dimension_svg():
    # All views use the dimensions of the exported model; scale 2 drawing units/mm.
    end, t = P["arm_reach"] + P["thickness"], P["thickness"]
    side = [(0,-60),(8,-60),(8,-54),(194,20),(200,20),(200,-32),
            (208,-32),(208,28),(8,28),(8,60),(0,60)]
    # Side silhouette follows the union of the wall, triangular rib, arm and tab.
    points = " ".join(f"{90+2*x},{330-2*z}" for x,z in side)
    wall_holes = "".join(f'<circle cx="{740+2*y}" cy="{330-2*z}" r="5.5"/>'
                          for y in (-30,30) for z in (-45,45))
    s = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1140" height="650" viewBox="0 0 1140 650">
<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8" fill="#50665f"/></marker></defs>
<style>text{{font-family:Arial,sans-serif;fill:#243d34}}.title{{font-size:25px;font-weight:600}}.label{{font-size:16px}}.small{{font-size:13px}}.part{{fill:#e0eee8;stroke:#285d49;stroke-width:2}}.hole{{fill:white;stroke:#285d49;stroke-width:1.5}}.dim{{stroke:#50665f;stroke-width:1;fill:none;marker-start:url(#arrow);marker-end:url(#arrow)}}.ext{{stroke:#8ea49b;stroke-width:1}}.hidden{{stroke:#8ea49b;stroke-width:1;stroke-dasharray:4 4;fill:none}}</style>
<rect width="1140" height="650" fill="#fff"/>
<text x="50" y="52" class="title">SCRAP · SIMPLE C920s WALL MOUNT</text>
<text x="50" y="82" class="label">One-piece fixed bracket · All dimensions in mm · Concept, physical fit unverified</text>
<text x="90" y="150" class="label">SIDE</text>
<polygon points="{points}" class="part"/>
<path d="M{90+2*200} {330-2*(-12+3.4)}H{90+2*208} M{90+2*200} {330-2*(-12-3.4)}H{90+2*208}" class="hidden"/>
<line x1="106" y1="187" x2="506" y2="187" class="dim"/><path d="M106 203V176 M506 266V176" class="ext"/>
<text x="264" y="177" class="label">200 arm</text>
<line x1="55" y1="210" x2="55" y2="450" class="dim"/><path d="M82 210H43 M82 450H43" class="ext"/>
<text x="30" y="348" class="label" transform="rotate(-90 30 348)">120</text>
<line x1="90" y1="485" x2="506" y2="485" class="dim"/><path d="M90 458V496 M506 402V496" class="ext"/>
<text x="256" y="510" class="label">208 overall</text>
<path d="M250 385L311 329" class="ext"/><text x="152" y="410" class="small">12-wide triangular brace</text>
<text x="90" y="549" class="small">Wall plate, arm and end tab: 8 thick</text>
<text x="650" y="150" class="label">WALL PLATE</text>
<rect x="650" y="210" width="180" height="240" rx="8" class="part"/>
<g class="hole">{wall_holes}</g>
<rect x="700" y="274" width="80" height="16" class="hidden"/>
<path d="M728 290V438 M752 290V438" class="hidden"/>
<line x1="650" y1="187" x2="830" y2="187" class="dim"/><path d="M650 203V176 M830 203V176" class="ext"/>
<text x="730" y="177" class="label">90</text>
<line x1="680" y1="485" x2="800" y2="485" class="dim"/><path d="M680 426V496 M800 426V496" class="ext"/>
<text x="705" y="510" class="label">60 centres</text>
<line x1="855" y1="240" x2="855" y2="420" class="dim"/><path d="M805 240H866 M805 420H866" class="ext"/>
<text x="877" y="374" class="label" transform="rotate(-90 877 374)">90 centres</text>
<text x="650" y="549" class="small">4 × Ø5.5 through · washer-head screws</text>
<text x="948" y="150" class="label">CAMERA END</text>
<rect x="950" y="270" width="80" height="120" rx="4" class="part"/>
<circle cx="990" cy="350" r="6.8" class="hole"/>
<line x1="950" y1="247" x2="1030" y2="247" class="dim"/><path d="M950 263V236 M1030 263V236" class="ext"/>
<text x="980" y="237" class="label">40</text>
<line x1="1055" y1="270" x2="1055" y2="390" class="dim"/><path d="M1037 270H1067 M1037 390H1067" class="ext"/>
<text x="1080" y="340" class="label">60</text>
<path d="M990 350L970 430" class="ext"/><text x="948" y="458" class="small">Ø6.8 through</text>
<text x="948" y="482" class="small">1/4-20 camera screw</text>
<text x="948" y="507" class="small">Hole 20 above bottom</text>
<text x="50" y="609" class="small">Camera attaches to vertical end tab with its existing clip rotated 90°; lens faces down.</text>
</svg>'''
    (HERE / "dimensions.svg").write_text(s)
    template = '''<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="160mm" viewBox="0 0 120 160">
<rect width="120" height="160" fill="white"/>
<g fill="none" stroke="black" stroke-width="0.25"><rect x="15" y="15" width="90" height="120" rx="4"/>
<circle cx="30" cy="30" r="2.75"/><circle cx="90" cy="30" r="2.75"/>
<circle cx="30" cy="120" r="2.75"/><circle cx="90" cy="120" r="2.75"/>
<path d="M26 30H34 M30 26V34 M86 30H94 M90 26V34 M26 120H34 M30 116V124 M86 120H94 M90 116V124"/>
<path d="M35 146H85 M35 143V149 M85 143V149"/></g>
<g font-family="Arial,sans-serif" font-size="3" fill="black"><text x="25" y="9">C920s wall mount · PRINT AT 100%</text><text x="38" y="142">Check this line measures 50 mm</text><text x="25" y="155">4 holes · 60 × 90 centres · units mm</text></g></svg>'''
    (HERE / "drill-template.svg").write_text(template)


def preview_png():
    # Orthographic render of the real CAD tessellation, with simple Lambert shading.
    w, h = 1600, 1080
    image = Image.new("RGB", (w, h), "#f5f7f4")
    draw = ImageDraw.Draw(image)
    font_path = "/System/Library/Fonts/Supplemental/Arial.ttf"
    def font(size): return ImageFont.truetype(font_path, size)
    right = (0.7071, 0.7071, 0)
    up = (-0.2762, 0.2762, 0.9206)
    depth = (0.6509, -0.6509, 0.3906)
    scale, ox, oy = 3.2, 365, 490
    def dot(a,b): return sum(x*y for x,y in zip(a,b))
    def project(v): return (ox + dot(v,right)*scale, oy-dot(v,up)*scale)
    wall = [[-1,-65,-78],[-1,65,-78],[-1,65,78],[-1,-65,78]]
    draw.polygon([project(v) for v in wall], fill="#e4e9e3")
    draw.line([project(v) for v in wall]+[project(wall[0])], fill="#d5ded4", width=2)
    light = (0.22,-0.5,0.84)
    colors = {"bracket":(66,126,104),"camera":(63,72,77),"lens":(49,76,98)}
    faces=[]
    for part in SCENE:
        verts = part["vertices"]
        for tri in part["triangles"]:
            a,b,c=[verts[j] for j in tri]
            ab=[b[i]-a[i] for i in range(3)]; ac=[c[i]-a[i] for i in range(3)]
            n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]]
            length=math.sqrt(dot(n,n))
            if length==0: continue
            n=[v/length for v in n]
            if dot(n,depth)<-0.001: continue
            shade=0.62+0.38*max(0,dot(n,light))
            color=tuple(round(v*shade) for v in colors[part["kind"]])
            faces.append((sum(dot(v,depth) for v in (a,b,c))/3,[project(v) for v in (a,b,c)],color))
    for _, pts, color in sorted(faces,key=lambda item:item[0]):
        draw.polygon(pts,fill=color)
    draw.text((72,58),"SCRAP / CAMERA WALL MOUNT",font=font(38),fill="#203c30")
    draw.text((74,115),"Logitech C920s  ·  One solid bracket  ·  Fixed 200 mm arm",font=font(24),fill="#5b6e63")
    draw.line((72,166,1528,166),fill="#d2ddd2",width=2)
    # Callouts sit outside the model, with leaders tied to actual model coordinates.
    def label(at,anchor,title,detail):
        p=project(anchor)
        draw.line((at[0],at[1]+15,p[0],p[1]),fill="#91a499",width=2)
        draw.ellipse((p[0]-4,p[1]-4,p[0]+4,p[1]+4),fill="#396850")
        draw.text(at,title,font=font(23),fill="#294e3b")
        draw.text((at[0],at[1]+34),detail,font=font(19),fill="#5b6e63")
    label((76,245),(8,-30,45),"Four wall screws","90 × 120 mm mounting plate")
    label((1200,370),(248,20,0),"C920s camera","Clip + tripod socket")
    label((77,777),(75,-6,-25),"One triangular brace","Stiffens the fixed arm")
    label((1170,680),(201,-8,-12),"One camera screw","Lens faces down")
    # Down arrow beneath the lens shows optical direction without inventing FOV.
    a=project((244.5,0,-22)); b=project((244.5,0,-62))
    draw.line((*a,*b),fill="#50715e",width=3)
    draw.polygon([(b[0],b[1]),(b[0]-8,b[1]-15),(b[0]+8,b[1]-15)],fill="#50715e")
    draw.text((b[0]-62,b[1]+12),"Dish area",font=font(19),fill="#50715e")
    draw.line((72,944,1528,944),fill="#d2ddd2",width=2)
    draw.text((75,976),"CONCEPT · Camera clip envelope and load capacity require a physical check.",font=font(21),fill="#647568")
    draw.text((75,1013),"The bracket is CAD geometry; the camera is a simplified reference.",font=font(18),fill="#78857c")
    image.save(HERE / "preview.png")


if __name__=="__main__":
    dimension_svg()
    preview_png()
