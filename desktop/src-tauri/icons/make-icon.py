#!/usr/bin/env python3
"""Draws icon-1024.png, the one source image of the app icon.

Only needed when the icon itself is to be changed; packaging does not run it
(scripts/package-macos.sh makes the .icns from the committed icon-1024.png).
Needs Pillow:  python3 make-icon.py

The mark is the one of web/src/ui/shell/Logo.tsx (24-unit grid, turned by 12 degrees: a black
hole inside its bright ring, the near side of the accretion disc crossing in front), on a tile
in the dark theme's colours of design/qoop-theme.css, laid out on
Apple's macOS icon grid (824 pt tile in a 1024 pt canvas, transparent margin).
After changing it, also refresh the 256 px copy Tauri embeds:
    sips -z 256 256 icon-1024.png --out icon.png
and the Windows icon, which is kept in git because tauri-build needs icons/icon.ico to build
for Windows at all (it goes into the program; scripts/package-windows.sh also gives it to the
installer):
    python3 make-icon.py --ico
That only converts the committed icon-1024.png (it draws nothing), and gives the same bytes
every time: 16, 24, 32, 48 and 64 px as plain bitmaps, 256 px as PNG.
"""

import io
import math
import struct
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

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
RING = (0xFF, 0xD9, 0x8F)  # the ring of light around the hole
DISC = (0xF2, 0xA0, 0x3D)  # the accretion disc
HOLE = (0, 0, 0)
TILT = math.radians(-12)


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

    # The mark: Logo.tsx's 24-unit grid, scaled into the tile and turned about its centre.
    u = TILE * SS * 0.74 / 24
    ox = off + (TILE * SS - 24 * u) / 2
    oy = ox

    def pt(x, y):
        dx, dy = x - 12, y - 12
        rx = dx * math.cos(TILT) - dy * math.sin(TILT)
        ry = dx * math.sin(TILT) + dy * math.cos(TILT)
        return (ox + (12 + rx) * u, oy + (12 + ry) * u)

    def disc(draw, cx, cy, r, fill):
        x, y = pt(cx, cy)
        draw.ellipse((x - r * u, y - r * u, x + r * u, y + r * u), fill=fill)

    def near_side(draw, width, fill):
        """The lower half of the disc's ellipse (10.8 by 2.6), round ends, as overlapping discs."""
        steps = 900
        for i in range(steps + 1):
            a = math.pi * i / steps
            disc(draw, 12 - 10.8 * math.cos(a), 12 + 2.6 * math.sin(a), width / 2, fill)

    # The hole and its ring on a layer of their own, cut away around the disc, so the tile shows there.
    hole = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hole)
    disc(hd, 12, 12, 6.6 + 1.1, RING + (255,))
    disc(hd, 12, 12, 6.6 - 1.1, HOLE + (255,))
    cut = Image.new("L", (n, n), 255)
    near_side(ImageDraw.Draw(cut), 3.8, 0)
    hole.putalpha(ImageChops.multiply(hole.getchannel("A"), cut))
    tile.alpha_composite(hole)
    near_side(ImageDraw.Draw(tile), 1.7, DISC + (255,))

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


def ico():
    """Writes icon.ico from icon-1024.png."""
    source = Image.open(Path(__file__).with_name("icon-1024.png")).convert("RGBA")
    images = []
    for size in (16, 24, 32, 48, 64, 256):
        image = source.resize((size, size), Image.LANCZOS)
        if size == 256:
            data = io.BytesIO()
            image.save(data, format="PNG", optimize=True)
            images.append((size, data.getvalue()))
            continue
        # A 32-bit bitmap, bottom row first, followed by an (unused, all-opaque) 1-bit mask
        # whose rows are padded to 32 bits. The header counts both in its height.
        header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
        rows = image.transpose(Image.FLIP_TOP_BOTTOM).tobytes("raw", "BGRA")
        mask = bytes(((size + 31) // 32) * 4 * size)
        images.append((size, header + rows + mask))
    out = struct.pack("<HHH", 0, 1, len(images))
    offset = len(out) + 16 * len(images)
    for size, data in images:
        out += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    target = Path(__file__).with_name("icon.ico")
    target.write_bytes(out + b"".join(data for _, data in images))
    print(target)


if __name__ == "__main__":
    if sys.argv[1:] == ["--ico"]:
        ico()
    else:
        main()
