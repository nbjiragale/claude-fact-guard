#!/usr/bin/env python3
"""Generate simple Claude Fact Guard icons.

Produces 16x16, 48x48, and 128x128 PNGs in icons/. The mark is a stylized
shield containing a checkmark — the visual language of the extension's
core promise (silent verification).
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

BG_TOP = (201, 140, 90)      # warm sand
BG_BOTTOM = (165, 102, 60)   # roasted earth
SHIELD = (255, 246, 235)     # parchment
CHECK = (60, 138, 96)        # forest green

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "icons"


def gradient_bg(size: int) -> Image.Image:
    """Vertical gradient between BG_TOP and BG_BOTTOM with rounded corners."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    base = Image.new("RGB", (size, size))
    pixels = base.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(BG_TOP[0] * (1 - t) + BG_BOTTOM[0] * t)
        g = int(BG_TOP[1] * (1 - t) + BG_BOTTOM[1] * t)
        b = int(BG_TOP[2] * (1 - t) + BG_BOTTOM[2] * t)
        for x in range(size):
            pixels[x, y] = (r, g, b)

    mask = Image.new("L", (size, size), 0)
    mdraw = ImageDraw.Draw(mask)
    radius = max(3, size // 5)
    mdraw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    img.paste(base, (0, 0), mask)
    return img


def shield_path(size: int) -> list[tuple[float, float]]:
    """Return polygon points for a shield centered in a square of side `size`."""
    margin = size * 0.18
    w = size - 2 * margin
    cx = size / 2
    top = margin
    bot = size - margin * 0.9
    left = cx - w / 2
    right = cx + w / 2
    mid_y = top + (bot - top) * 0.55
    return [
        (cx, top),
        (right, top + w * 0.08),
        (right, mid_y),
        (cx, bot),
        (left, mid_y),
        (left, top + w * 0.08),
    ]


def draw_check(draw: ImageDraw.ImageDraw, size: int) -> None:
    cx = size / 2
    cy = size / 2 + size * 0.02
    s = size * 0.22
    width = max(2, int(size * 0.09))
    points = [
        (cx - s, cy + s * 0.05),
        (cx - s * 0.2, cy + s * 0.7),
        (cx + s * 1.05, cy - s * 0.6),
    ]
    draw.line(points, fill=CHECK, width=width, joint="curve")


def render(size: int) -> Image.Image:
    img = gradient_bg(size)
    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.polygon(shield_path(size), fill=SHIELD)
    draw_check(draw, size)
    return Image.alpha_composite(img, overlay)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in (16, 48, 128):
        out = OUT_DIR / f"icon-{size}.png"
        render(size).save(out, format="PNG", optimize=True)
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
