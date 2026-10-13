#!/usr/bin/env python3
"""Draws icon-1024.png, the one source image of the app icon.

Only needed when the icon itself is to be changed; packaging does not run it
(scripts/package-macos.sh makes the .icns from the committed icon-1024.png).
Needs Pillow:  python3 make-icon.py

The mark is the one of web/src/ui/shell/Logo.tsx (18-unit grid: a ring, the accent dot,
the tail), in the dark theme's colours of design/qoop-theme.css, on a tile laid out on
Apple's macOS icon grid (824 pt tile in a 1024 pt canvas, transparent margin).
After changing it, also refresh the 256 px copy Tauri embeds:
    sips -z 256 256 icon-1024.png --out icon.png
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 4  # supersampling
TILE = 824
RADIUS = 186


def oklch(l, c, h):
    """OKLCH -> sRGB 8-bit tuple."""
    a = c * math.cos(math.radians(h))
    b = c * math.sin(math.radians(h))
    l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s_ = (l - 0.0894841775 * a - 1.2914855480 * b) ** 3
    rgb = (
        +4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
        -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
        -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
    )

    def gamma(x):
        x = min(1.0, max(0.0, x))
        return 12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055

    return tuple(round(255 * gamma(x)) for x in rgb)


SURFACE_TOP = oklch(0.265, 0.010, 255)  # --q-hover (dark)
SURFACE_BOTTOM = oklch(0.165, 0.007, 255)  # --q-canvas (dark)
INK = oklch(0.94, 0.006, 255)  # --q-ink (dark)
ACCENT = oklch(0.80, 0.10, 195)  # --q-accent (dark)


def main():
    n = SIZE * SS
    off = (SIZE - TILE) // 2 * SS
    box = (off, off, off + TILE * SS, off + TILE * SS)

    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, RADIUS * SS, fill=255)

    # The tile: a quiet top-to-bottom gradient.
    gradient = Image.new("RGB", (1, 256))
    for y in range(256):
        t = y / 255
        gradient.putpixel(
            (0, y),
            tuple(round(a + (b - a) * t) for a, b in zip(SURFACE_TOP, SURFACE_BOTTOM)),
        )
    tile = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    tile.paste(gradient.resize((TILE * SS, TILE * SS)), (off, off))
    tile.putalpha(mask)

    # The mark: Logo.tsx's 18-unit grid, scaled into the tile.
    u = TILE * SS * 0.70 / 18
    ox = off + (TILE * SS - 18 * u) / 2
    oy = ox
    d = ImageDraw.Draw(tile)

    def pt(x, y):
        return (ox + x * u, oy + y * u)

    def disc(cx, cy, r, fill):
        x, y = pt(cx, cy)
        d.ellipse((x - r * u, y - r * u, x + r * u, y + r * u), fill=fill)

    stroke = 1.4
    x, y = pt(9, 9)
    ro = (7.2 + stroke / 2) * u
    d.ellipse((x - ro, y - ro, x + ro, y + ro), outline=INK, width=round(stroke * u))
    d.line((pt(12.6, 12.6), pt(16, 16)), fill=INK, width=round(stroke * u))
    disc(12.6, 12.6, stroke / 2, INK)
    disc(16, 16, stroke / 2, INK)
    disc(11.6, 6.4, 1.9, ACCENT)

    tile = tile.resize((SIZE, SIZE), Image.LANCZOS)

    # A soft shadow under the tile, as macOS icons carry.
    small_mask = mask.resize((SIZE, SIZE), Image.LANCZOS)
    shadow_alpha = Image.new("L", (SIZE, SIZE), 0)
    shadow_alpha.paste(small_mask.point(lambda v: v * 0.38), (0, 12))
    shadow_alpha = shadow_alpha.filter(ImageFilter.GaussianBlur(14))
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.putalpha(shadow_alpha)
    out.alpha_composite(tile)

    target = Path(__file__).with_name("icon-1024.png")
    out.save(target, optimize=True)
    print(target)


if __name__ == "__main__":
    main()
