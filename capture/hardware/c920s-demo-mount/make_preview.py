"""Render the purchased-hardware placement CAD to a labelled image."""
from pathlib import Path
import json
import math
from PIL import Image,ImageDraw,ImageFont
import numpy as np

HERE=Path(__file__).resolve().parent
scene=json.loads((HERE/'preview-mesh.json').read_text())
image=Image.new('RGB',(1500,1080),'#f6f7f3')
draw=ImageDraw.Draw(image)
font=lambda size:ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',size)
right=(0.8192,-0.5736,0)
up=(0.2868,0.4096,0.8660)
depth=(-0.4967,-0.7094,0.5)
dot=lambda a,b:sum(x*y for x,y in zip(a,b))
def project(v):return (400+dot(v,right)*1.2,800-dot(v,up)*1.2)
colors={'stand':(57,96,73),'pad':(55,62,54),'hardware':(83,91,78),
        'camera':(54,62,68),'lens':(37,60,71),'table':(186,173,146),'dish':(232,237,226)}
pixels=np.array(image)
zbuffer=np.full((1080,1500),-np.inf)
for part in scene:
 for tri in part['triangles']:
    a,b,c=[part['vertices'][i] for i in tri]
    ab=[b[i]-a[i] for i in range(3)];ac=[c[i]-a[i] for i in range(3)]
    n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]]
    length=math.sqrt(dot(n,n))
    if not length:continue
    n=[v/length for v in n]
    if dot(n,depth)<-0.001:continue
    shade=.68+.32*max(0,dot(n,(.2,-.5,.84)))
    color=tuple(round(v*shade) for v in colors[part['kind']])
    pts=[project(v) for v in (a,b,c)]
    x0=max(0,int(math.floor(min(v[0] for v in pts))));x1=min(1499,int(math.ceil(max(v[0] for v in pts))))
    y0=max(0,int(math.floor(min(v[1] for v in pts))));y1=min(1079,int(math.ceil(max(v[1] for v in pts))))
    if x1<x0 or y1<y0:continue
    aa,bb,cc=pts
    denom=(bb[1]-cc[1])*(aa[0]-cc[0])+(cc[0]-bb[0])*(aa[1]-cc[1])
    if abs(denom)<1e-9:continue
    yy,xx=np.mgrid[y0:y1+1,x0:x1+1]
    w0=((bb[1]-cc[1])*(xx+.5-cc[0])+(cc[0]-bb[0])*(yy+.5-cc[1]))/denom
    w1=((cc[1]-aa[1])*(xx+.5-cc[0])+(aa[0]-cc[0])*(yy+.5-cc[1]))/denom
    w2=1-w0-w1
    z=w0*dot(a,depth)+w1*dot(b,depth)+w2*dot(c,depth)
    region=zbuffer[y0:y1+1,x0:x1+1]
    hit=(w0>=-1e-7)&(w1>=-1e-7)&(w2>=-1e-7)&(z>region)
    region[hit]=z[hit]
    pixels[y0:y1+1,x0:x1+1][hit]=color
image=Image.fromarray(pixels)
draw=ImageDraw.Draw(image)
draw.text((65,55),'SCRAP / FAST DEMO CAMERA MOUNT',font=font(36),fill='#29432f')
draw.text((66,113),'Clamp to an edge · Attach the C920s · Aim down',font=font(24),fill='#617060')
draw.line((65,161,1435,161),fill='#d8dfd2',width=2)
def label(at,anchor,title,detail):
 p=project(anchor)
 draw.line((at[0],at[1]+18,p[0],p[1]),fill='#8ea288',width=2)
 draw.ellipse((p[0]-4,p[1]-4,p[0]+4,p[1]+4),fill='#36583c')
 draw.text(at,title,font=font(25),fill='#294b32')
 draw.text((at[0],at[1]+38),detail,font=font(20),fill='#64755d')
label((66,265),(43,0,362),'Flexible webcam arm','Ready-made metal stand')
label((1040,265),(297,5,417),'Logitech C920s','Existing tripod socket')
label((67,744),(36,0,-73),'Tighten one clamp knob','No holes in the table')
# A thin vertical reference from the optical centre to the plate centre.
a=project((296.5,0,392));b=project((296.5,0,7))
draw.line((*a,*b),fill='#718a66',width=2)
draw.polygon([(b[0],b[1]),(b[0]-7,b[1]-14),(b[0]+7,b[1]-14)],fill='#718a66')
label((1080,595),(296.5,0,215),'Lens above the dish','About 40 cm in this layout')
draw.line((65,950,1435,950),fill='#d8dfd2',width=2)
draw.text((67,980),'PLACEMENT CAD · Generic purchased hardware; no custom printed parts required.',font=font(22),fill='#60705d')
draw.text((67,1020),'Assumed table edge. Check the actual clamp fit and live camera view at the demo.',font=font(19),fill='#7a8673')
image.save(HERE/'preview.png')
