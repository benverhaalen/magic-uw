"""Render Wiz start/end poses (idle, wave, tap, fly) from the repo SVG onto 1920x1080 #00FF00.
Writes <pose>.html; screenshot each with headless Chrome at 1920x1080 (see README)."""
import re, pathlib, math
src = (pathlib.Path(__file__).resolve().parents[3] / "marketing/logo-design-elements/svg/mark-color.svg").read_text()
body = re.sub(r"<metadata>.*?</metadata>", "", src, flags=re.S)
body = re.sub(r"^<svg[^>]*>", "", body).replace("</svg>", "")
INK, STAFF, STAR = "#29231f", "#5c0b10", "#f7c440"
def star(cx, cy, r):
    pts=[]
    for i in range(10):
        a = -math.pi/2 + i*math.pi/5; rr = r if i%2==0 else r*0.45
        pts.append(f"{cx+rr*math.cos(a):.1f},{cy+rr*math.sin(a):.1f}")
    return f'<polygon points="{" ".join(pts)}" fill="{STAR}" stroke="{INK}" stroke-width="3" stroke-linejoin="round"/>'
def staff(x1,y1,x2,y2):  # x2,y2 = star end
    return (f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{INK}" stroke-width="11" stroke-linecap="round"/>'
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{STAFF}" stroke-width="5" stroke-linecap="round"/>'
            + star(x2, y2, 13))
def pose(left_rot, right_rot, staff_svg, tilt=0):
    b = body.replace('transform="rotate(-40)"', f'transform="rotate({left_rot})"', 1)
    b = b.replace('transform="rotate(40)"', f'transform="rotate({right_rot})"', 1)
    # staff goes just before the left arm group so the mitten sits on top of it
    b = b.replace('<g id="arm-left"', staff_svg + '<g id="arm-left"', 1)
    return f'<g transform="rotate({tilt} 100 120)">{b}</g>'
# left hand position for a given left-arm rotation (shoulder 80,159; hand offset -35,0)
def lhand(rot):
    t = math.radians(rot); return (80 - 35*math.cos(t), 159 - 35*math.sin(t))
hx, hy = lhand(-40)
idle  = pose(-40, 40, staff(hx, hy+45, hx, hy-110))
wave  = pose(-40, -50, staff(hx, hy+45, hx, hy-110))
tx, ty = lhand(-5); ang = math.radians(35)
tap   = pose(-5, 40, staff(tx+45*math.cos(ang), ty-45*math.sin(ang), tx-125*math.cos(ang), ty+125*math.sin(ang)))
fly   = pose(-40, 40, staff(hx+30, hy+40, hx-60, hy-95), tilt=-18)
VB = "-100 -30 400 300"   # identical viewBox for every pose => identical scale
H = 1080*0.5/238*300      # wizard (238 units) = 50% of frame height
for name, g in dict(idle=idle, wave=wave, tap=tap, fly=fly).items():
    pathlib.Path(f"{name}.html").write_text(
      f'<html><body style="margin:0;background:#00FF00;width:1920px;height:1080px;overflow:hidden;display:flex;align-items:center;justify-content:center">'
      f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{VB}" height="{H:.0f}" width="{H*400/300:.0f}">{g}</svg></body></html>')
pathlib.Path("green.html").write_text('<html><body style="margin:0;background:#00FF00"></body></html>')
