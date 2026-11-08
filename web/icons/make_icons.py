"""Generate the app icons: a thermal "lens" in the iron palette on the app's dark background.

    .venv\\Scripts\\python web\\icons\\make_icons.py      (needs Pillow)
"""

import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
BG = (18, 18, 18)
# Iron palette stops (position 0..1, RGB), from js/palettes.js
IRON = [(0, (0, 0, 0)), (52 / 256, (69, 0, 150)), (104 / 256, (202, 19, 133)), (156 / 256, (241, 106, 2)),
        (220 / 256, (255, 255, 0)), (1, (255, 255, 255))]


def iron(t):
    t = min(1.0, max(0.0, t))
    for (p0, c0), (p1, c1) in zip(IRON, IRON[1:]):
        if t <= p1:
            f = (t - p0) / (p1 - p0)
            return tuple(round(a + f * (b - a)) for a, b in zip(c0, c1))
    return IRON[-1][1]


def draw_icon(size, maskable):
    """maskable: full-bleed background with content inside the central 80% safe zone."""
    ss = 4  # supersample for smooth edges
    S = size * ss
    img = Image.new("RGB", (S, S), BG)
    if not maskable:
        img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(img).rounded_rectangle((0, 0, S - 1, S - 1), radius=S * 0.22, fill=BG + (255,))
    cx = cy = S / 2
    R = S * (0.30 if maskable else 0.36)
    px = img.load()
    # Hot spot slightly up-left of centre, temperature falling off radially.
    hx, hy = cx - R * 0.18, cy - R * 0.22
    for y in range(int(cy - R) - 1, int(cy + R) + 2):
        for x in range(int(cx - R) - 1, int(cx + R) + 2):
            if (x - cx) ** 2 + (y - cy) ** 2 <= R * R:
                d = math.hypot(x - hx, y - hy) / (R * 1.45)
                c = iron(1.0 - d ** 0.85)
                px[x, y] = c + ((255,) if img.mode == "RGBA" else ())
    d = ImageDraw.Draw(img)
    ring = max(2, int(S * 0.025))
    d.ellipse((cx - R, cy - R, cx + R, cy + R), outline=(255, 122, 61), width=ring)  # app accent
    # Spot-meter crosshair
    arm, gap, w = R * 0.42, R * 0.14, max(2, int(S * 0.018))
    for (x0, y0, x1, y1) in [(cx - arm, cy, cx - gap, cy), (cx + gap, cy, cx + arm, cy),
                             (cx, cy - arm, cx, cy - gap), (cx, cy + gap, cx, cy + arm)]:
        d.line((x0, y0, x1, y1), fill=(255, 255, 255), width=w)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    for name, size, maskable in [("icon-192.png", 192, False), ("icon-512.png", 512, False),
                                 ("maskable-512.png", 512, True), ("favicon-32.png", 32, False)]:
        draw_icon(size, maskable).save(os.path.join(HERE, name), optimize=True)
        print("wrote", name)
