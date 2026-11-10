"""The app's icon: two overlapping pages, an "A" on one and a "文" on the other, flat shapes on a
rounded square. The default app's is blue; another app of this code gets the same in its own colour
(README "Several apps from one copy"), here `work`, in orange. The letters are strokes, not a font.
Writes <name>.svg, <name>-512.png, <name>-192.png and <name>-touch.png (180, square: iOS rounds it).
Usage: python logos.py [out dir]"""
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Polygon, Rectangle

plt.rcParams["svg.hashsalt"] = "logos"  # the same ids in the SVG every time

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
PT = 0.72  # points per unit: the canvas is 512 units on 5.12 inches, drawn at 100 dpi

# background, back page, its folded corner, front page, its folded corner, letters
COLOURS = {
    "app": ("#3355e6", "#d6e0ff", "#a9bbf7", "#ffffff", "#c9d5fb", "#1f3aa8"),
    "work": ("#e8590c", "#ffe3cc", "#f9b98a", "#ffffff", "#ffd0ad", "#a3360a"),
}


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


def page(ax, x0, y0, w, h, fc, fold_fc, z, grow=0.0, r=12, fold=52):
    """A page with its top right corner folded down; its corners rounded by r. `grow` widens its
    outline (for the gap cut around the front page)."""
    x1, y1 = x0 + w, y0 + h
    outline = [(x0, y0), (x1, y0), (x1, y1 - fold), (x1 - fold, y1), (x0, y1)]
    ax.add_patch(Polygon(outline, closed=True, fc=fc, ec=fc, lw=2 * (r + grow) * PT, joinstyle="round", zorder=z))
    if fold_fc:
        corner = [(x1 - fold, y1), (x1 - fold, y1 - fold), (x1, y1 - fold)]
        ax.add_patch(Polygon(corner, closed=True, fc=fold_fc, ec=fold_fc, lw=r * PT, joinstyle="round", zorder=z + 1))


def stroke(ax, pts, colour, z, w=24):
    xs, ys = zip(*pts)
    ax.plot(xs, ys, color=colour, lw=w * PT, solid_capstyle="round", solid_joinstyle="round", zorder=z)


def icon(name, square=False):
    bg, back, back_fold, front, front_fold, ink = COLOURS[name]
    fig, ax = canvas(bg, square)
    # the back page, up and to the left, with an "A"
    page(ax, 84, 172, 204, 256, back, back_fold, 2)
    cx, cy = 136, 296
    stroke(ax, [(cx - 44, cy - 58), (cx, cy + 58), (cx + 44, cy - 58)], ink, 3)
    stroke(ax, [(cx - 25, cy - 14), (cx + 25, cy - 14)], ink, 3)
    # the front page, down and to the right, cut out of the back one, with a "文"
    page(ax, 224, 84, 204, 256, bg, None, 4, grow=14)
    page(ax, 224, 84, 204, 256, front, front_fold, 5)
    cx, cy = 322, 198
    stroke(ax, [(cx - 3, cy + 74), (cx + 7, cy + 58)], ink, 7)  # the dot
    stroke(ax, [(cx - 62, cy + 36), (cx + 62, cy + 36)], ink, 7)  # the line under it
    stroke(ax, [(cx + 36, cy + 26), (cx + 8, cy - 18), (cx - 58, cy - 66)], ink, 7)  # falling left
    stroke(ax, [(cx - 36, cy + 26), (cx - 8, cy - 18), (cx + 58, cy - 66)], ink, 7)  # falling right
    return fig


PNG = {"Software": None}  # no text chunks in the PNGs

for name in COLOURS:
    fig = icon(name)
    fig.savefig(os.path.join(OUT, f"{name}.svg"), transparent=True, metadata={"Date": None})
    fig.savefig(os.path.join(OUT, f"{name}-512.png"), dpi=100, transparent=True, metadata=PNG)
    fig.savefig(os.path.join(OUT, f"{name}-192.png"), dpi=37.5, transparent=True, metadata=PNG)
    plt.close(fig)
    fig = icon(name, square=True)
    fig.savefig(os.path.join(OUT, f"{name}-touch.png"), dpi=180 / 5.12, metadata=PNG)
    plt.close(fig)
    print(name, "done")
