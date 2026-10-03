"""Rasterize glyphs straight from the font file, and compare ink coverage.

The question this answers is whether a face's own accented glyph is drawn as
lightly as what the screen shows. Curves are flattened to line segments, which is
ample at this size: the comparison is about ink weight, not outline fidelity.
"""

import os
import sys

from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTCollection, TTFont

FONT_DIRS = [
    os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"),
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts"),
]

SCALE = 96  # pixels per em


class Flatten(BasePen):
    def __init__(self, glyph_set):
        super().__init__(glyph_set)
        self.points = []
        self.contours = []
        self.current = []

    def _moveTo(self, pt):
        if self.current:
            self.contours.append(self.current)
        self.current = [pt]

    def _lineTo(self, pt):
        self.current.append(pt)

    def _curveToOne(self, p1, p2, p3):
        start = self.current[-1]
        steps = 16
        for index in range(1, steps + 1):
            t = index / steps
            u = 1 - t
            x = u * u * u * start[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0]
            y = u * u * u * start[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
            self.current.append((x, y))

    def _qCurveToOne(self, p1, p2):
        start = self.current[-1]
        steps = 12
        for index in range(1, steps + 1):
            t = index / steps
            u = 1 - t
            x = u * u * start[0] + 2 * u * t * p1[0] + t * t * p2[0]
            y = u * u * start[1] + 2 * u * t * p1[1] + t * t * p2[1]
            self.current.append((x, y))

    def _closePath(self):
        if self.current:
            self.contours.append(self.current)
            self.current = []

    def _endPath(self):
        self._closePath()

    def done(self):
        self._closePath()
        return self.contours


def load(family):
    """Find a font file for a family name by asking the font's own name table."""
    for directory in FONT_DIRS:
        if not os.path.isdir(directory):
            continue
        for name in sorted(os.listdir(directory)):
            if not name.lower().endswith((".ttf", ".otf", ".ttc")):
                continue
            path = os.path.join(directory, name)
            try:
                fonts = (
                    TTCollection(path, lazy=True).fonts
                    if name.lower().endswith(".ttc")
                    else [TTFont(path, lazy=True)]
                )
            except Exception:
                continue
            for font in fonts:
                try:
                    names = {
                        font["name"].getDebugName(1),
                        font["name"].getDebugName(4),
                        font["name"].getDebugName(16),
                    }
                except Exception:
                    continue
                if family in {n for n in names if n}:
                    return path, font
    return None, None


def rasterize(font, char, scale=SCALE):
    upm = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    glyph_name = cmap.get(ord(char))
    if glyph_name is None:
        return None
    pen = Flatten(font.getGlyphSet())
    font.getGlyphSet()[glyph_name].draw(pen)
    contours = pen.done()
    if not contours:
        return None

    factor = scale / upm
    contours = [[(x * factor, -y * factor) for x, y in contour] for contour in contours]
    xs = [x for contour in contours for x, _ in contour]
    ys = [y for contour in contours for _, y in contour]
    left, right = int(min(xs)) - 1, int(max(xs)) + 2
    top, bottom = int(min(ys)) - 1, int(max(ys)) + 2
    width, height = right - left, bottom - top

    grid = []
    for y in range(top, bottom):
        row = []
        for x in range(left, right):
            inside = False
            for contour in contours:
                count = len(contour)
                for index in range(count):
                    x1, y1 = contour[index]
                    x2, y2 = contour[(index + 1) % count]
                    if (y1 > y) != (y2 > y):
                        crossing = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                        if crossing > x:
                            inside = not inside
            row.append(inside)
        grid.append(row)

    ink = sum(1 for row in grid for cell in row if cell)
    return {
        "glyph": glyph_name,
        "width": width,
        "height": height,
        "ink": ink,
        "coverage": ink / (width * height) if width and height else 0.0,
        "grid": grid,
    }


def ascii_art(result, ink="#", empty="."):
    return ["".join(ink if cell else empty for cell in row) for row in result["grid"]]


def main() -> None:
    families = sys.argv[1].split(",")
    chars = sys.argv[2] if len(sys.argv) > 2 else "ôoởơ"
    for family in families:
        path, font = load(family)
        if font is None:
            print(f"=== {family}: not found")
            continue
        print(f"=== {family}  ({os.path.basename(path)})  upm={font['head'].unitsPerEm}")
        for char in chars:
            result = rasterize(font, char)
            if result is None:
                print(f"  {char!r}: no glyph")
                continue
            print(
                f"  {char!r:5} U+{ord(char):04X} glyph={result['glyph']:16} "
                f"box={result['width']}x{result['height']} ink={result['ink']:5} "
                f"coverage={result['coverage'] * 100:5.1f}%"
            )
        print()


if __name__ == "__main__":
    main()
