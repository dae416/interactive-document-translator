"""The two apps' logos, one round sparrow in both: in its nest (Sparrow's Nest) and at a water mill
with a few grains (Sparrow's Mill). Flat shapes on a rounded square, like the old book icon.
Writes <name>.svg, <name>-512.png, <name>-192.png and <name>-touch.png (180, square: iOS rounds it).
Usage: python logos.py [out dir]"""
import math
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, Ellipse, FancyBboxPatch, Polygon, Rectangle, Wedge

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
BODY, CAP, WING, BELLY, BEAK, EYE, BLUSH = "#b97a45", "#7d4b28", "#8c5530", "#fbeedb", "#5b4434", "#2a1f1a", "#f59f9f"


def sparrow(ax, cx, cy, s, feet=False):
    """A round sparrow facing right, centre (cx, cy), about s wide."""
    if feet:
        for dx in (-0.1, 0.08):
            ax.plot([cx + dx * s, cx + dx * s - 0.03 * s], [cy - 0.36 * s, cy - 0.5 * s], color=BEAK, lw=s / 40, solid_capstyle="round", zorder=4)
    ax.add_patch(Polygon([(cx - 0.36 * s, cy + 0.02 * s), (cx - 0.66 * s, cy + 0.2 * s), (cx - 0.6 * s, cy - 0.06 * s)], closed=True, fc=CAP, ec="none", zorder=5))
    body = Ellipse((cx, cy), s, 0.86 * s, fc=BODY, ec="none", zorder=6)
    ax.add_patch(body)
    cap = Circle((cx + 0.05 * s, cy + 0.62 * s), 0.52 * s, fc=CAP, ec="none", zorder=7)
    cap.set_clip_path(body)
    ax.add_patch(cap)
    belly = Ellipse((cx + 0.14 * s, cy - 0.16 * s), 0.66 * s, 0.5 * s, fc=BELLY, ec="none", zorder=7)
    belly.set_clip_path(body)
    ax.add_patch(belly)
    ax.add_patch(Ellipse((cx - 0.17 * s, cy - 0.02 * s), 0.5 * s, 0.3 * s, angle=-28, fc=WING, ec="none", zorder=8))
    ax.add_patch(Ellipse((cx - 0.2 * s, cy + 0.0 * s), 0.26 * s, 0.07 * s, angle=-28, fc=BELLY, ec="none", alpha=0.55, zorder=9))
    ax.add_patch(Polygon([(cx + 0.47 * s, cy + 0.15 * s), (cx + 0.64 * s, cy + 0.08 * s), (cx + 0.46 * s, cy + 0.01 * s)], closed=True, fc=BEAK, ec="none", zorder=9))
    ax.add_patch(Circle((cx + 0.27 * s, cy + 0.16 * s), 0.065 * s, fc=EYE, ec="none", zorder=9))
    ax.add_patch(Circle((cx + 0.29 * s, cy + 0.185 * s), 0.022 * s, fc="white", ec="none", zorder=10))
    ax.add_patch(Ellipse((cx + 0.3 * s, cy - 0.02 * s), 0.13 * s, 0.08 * s, fc=BLUSH, ec="none", alpha=0.85, zorder=9))


def canvas(bg, square=False):
    fig = plt.figure(figsize=(5.12, 5.12), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, 512)
    ax.set_ylim(0, 512)
    ax.set_aspect("equal")
    ax.axis("off")
    if square:
        ax.add_patch(Rectangle((0, 0), 512, 512, fc=bg, ec="none", zorder=0))
    else:
        ax.add_patch(FancyBboxPatch((0, 0), 512, 512, boxstyle="round,pad=0,rounding_size=112", fc=bg, ec="none", zorder=0))
    return fig, ax


def nest(square=False):
    fig, ax = canvas("#3355e6", square)
    sparrow(ax, 262, 290, 256)
    # the nest: a bowl of twigs in front of the bird, its rim a band
    cy = 212
    ax.add_patch(Wedge((256, cy), 152, 180, 360, fc="#8a5527", ec="none", zorder=11))
    ax.add_patch(Ellipse((256, cy), 314, 54, fc="#a96a33", ec="none", zorder=12))
    for r, a0, a1 in [(128, 202, 338), (100, 208, 332), (72, 216, 324)]:
        t = [math.radians(a) for a in range(a0, a1 + 1, 4)]
        ax.plot([256 + r * math.cos(x) for x in t], [cy + r * 0.66 * math.sin(x) for x in t], color="#c58a4c", lw=7, solid_capstyle="round", zorder=12)
    for dx, ang in [(-105, 20), (-35, -15), (50, 18), (118, -22)]:
        c, s = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        ax.plot([256 + dx - 20 * c, 256 + dx + 20 * c], [cy - 20 * s, cy + 20 * s], color="#7a4720", lw=7, solid_capstyle="round", zorder=13)
    return fig


def mill(square=False):
    fig, ax = canvas("#f2a531", square)
    cx, cy, r = 316, 262, 136
    white = "#fff8ec"
    # the water wheel: rim, spokes, hub and paddles
    ax.add_patch(Circle((cx, cy), r, fc="none", ec=white, lw=16, zorder=2))
    ax.add_patch(Circle((cx, cy), r * 0.62, fc="none", ec=white, lw=9, zorder=2))
    for k in range(8):
        a = math.radians(k * 45 + 22.5)
        ax.plot([cx, cx + r * math.cos(a)], [cy, cy + r * math.sin(a)], color=white, lw=9, solid_capstyle="round", zorder=2)
    # paddles: boards standing out from the rim, as a water wheel has (not a gear's teeth)
    for k in range(12):
        a = k * 30
        p = (cx + (r + 14) * math.cos(math.radians(a)), cy + (r + 14) * math.sin(math.radians(a)))
        ax.add_patch(Rectangle((p[0] - 8, p[1] - 20), 16, 40, angle=a - 90, rotation_point="center", fc=white, ec="none", zorder=3))
    ax.add_patch(Circle((cx, cy), 26, fc=white, ec="none", zorder=3))
    # water running under the wheel, ground under the bird
    for k, y in enumerate((112, 86)):
        xs = [x for x in range(262, 460, 4)]
        ax.plot(xs, [y + 7 * math.sin((x - 262) / 18 + k) for x in xs], color="#4dabf7", lw=11, solid_capstyle="round", zorder=4)
    ax.add_patch(FancyBboxPatch((56, 88), 196, 20, boxstyle="round,pad=0,rounding_size=10", fc="#c97f12", ec="none", zorder=4))
    sparrow(ax, 168, 214, 214, feet=True)
    for x, y, a in [(232, 118, 25), (210, 124, -15), (246, 132, 60)]:
        ax.add_patch(Ellipse((x, y), 22, 12, angle=a, fc=white, ec="#c97f12", lw=2, zorder=11))
    return fig


for name, draw in [("nest", nest), ("mill", mill)]:
    fig = draw()
    fig.savefig(os.path.join(OUT, f"{name}.svg"), transparent=True, metadata={"Date": None})
    fig.savefig(os.path.join(OUT, f"{name}-512.png"), dpi=100, transparent=True)
    fig.savefig(os.path.join(OUT, f"{name}-192.png"), dpi=37.5, transparent=True)
    plt.close(fig)
    fig = draw(square=True)
    fig.savefig(os.path.join(OUT, f"{name}-touch.png"), dpi=180 / 5.12)
    plt.close(fig)
    print(name, "done")
