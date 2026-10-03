"""Verify the document face.

Two questions, both answered from the character maps rather than from the
browser, which substitutes faces silently and reports nothing:

  1. The vendored `Latin Modern Roman` — the face the stack actually resolves to
     now that it ships with Eukolia — must cover every character of Vietnamese.
  2. Every other named family in `--eu-serif-font` that happens to be installed
     must be able to paint the same sample on its own, so a fallback is never the
     thing that mixes two typefaces inside one word.
"""

import os
import re

from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")

# The vendored face, which is the one that wins.
VENDORED = os.path.join(ROOT, "public", "latin-modern", "lmroman10-regular.otf")

# The report's own text, plus every Vietnamese class.
SAMPLE = (
    "T\u00f4p\u00f4 compact-m\u1edf "
    "\u0110\u1eb7ng Th\u1ecb H\u1ed3ng nghi\u00eang "
    "\u01b0\u01a1 \u1ee9 \u1ee3 \u1eab \u1ec7 "
    "\u0103\u0111\u00e2\u00ea\u00f4\u00e0\u00e9"
)

# The whole of Latin Extended Additional, which is where Vietnamese lives.
LATIN_EXTENDED_ADDITIONAL = range(0x1EA0, 0x1EFA)

# Combining marks a decomposed Vietnamese sequence needs.
COMBINING = [0x0300, 0x0301, 0x0303, 0x0309, 0x0323]

# Family name in CSS -> the file Windows ships for it.
FILES = {
    "Latin Modern Roman": "lmroman10-regular.otf",
    "Computer Modern": "cmunrm.ttf",
    "Cambria": "cambria.ttc",
    "Times New Roman": "times.ttf",
    "Palatino": "pala.ttf",
    "Palatino Linotype": "pala.ttf",
    "Georgia": "georgia.ttf",
    "Book Antiqua": "BOOKOS.TTF",
    "Segoe UI": "segoeui.ttf",
}


def stack_from_css() -> list[str]:
    css = open(os.path.join(ROOT, "src", "renderer", "index.css"), encoding="utf-8").read()
    raw = re.search(r"--eu-serif-font:([^;]+);", css).group(1)
    return [part.strip().strip("'").strip('"') for part in raw.split(",")]


def check_vendored() -> list[str]:
    """The face the stack resolves to must cover Vietnamese completely."""
    if not os.path.exists(VENDORED):
        return [f"vendored face is missing: {VENDORED}"]
    cmap = TTFont(VENDORED, lazy=True).getBestCmap()
    problems = []
    missing = sorted({ch for ch in SAMPLE if ord(ch) not in cmap})
    if missing:
        problems.append(f"vendored face is missing the sample: {' '.join(missing)}")
        print(f"  {'Latin Modern Roman':20} MISSING {' '.join(missing)}")
    else:
        print(f"  {'Latin Modern Roman':20} covers the sample ({len(cmap)} characters)")

    absent = [code for code in LATIN_EXTENDED_ADDITIONAL if code not in cmap]
    if absent:
        problems.append(
            f"vendored face is missing {len(absent)} of Latin Extended Additional"
        )
        print(f"  {'':20} Latin Extended Additional gaps: {len(absent)}/90")
    else:
        print(f"  {'':20} all 90 of Latin Extended Additional U+1EA0-U+1EF9")

    gaps = [code for code in COMBINING if code not in cmap]
    if gaps:
        problems.append(f"vendored face lacks combining marks: {gaps}")
        print(f"  {'':20} combining marks missing: {[hex(c) for c in gaps]}")
    else:
        print(f"  {'':20} every combining Vietnamese mark")
    return problems


def main() -> None:
    families = stack_from_css()
    print("--eu-serif-font:", " | ".join(families))
    print("\nvendored face (the one that wins):")
    problems = check_vendored()

    print("\nother named families:")
    for family in families:
        if family == "Latin Modern Roman":
            continue
        filename = FILES.get(family)
        if filename is None:
            print(f"  {family:20} generic or unknown — not checked here")
            continue
        path = os.path.join(FONTS, filename)
        if not os.path.exists(path):
            print(f"  {family:20} not installed — skipped by the browser, costs nothing")
            continue
        cmap = TTFont(path, fontNumber=0, lazy=True).getBestCmap()
        missing = sorted({ch for ch in SAMPLE if ord(ch) not in cmap})
        if missing:
            problems.append((family, missing))
            print(f"  {family:20} MISSING {' '.join(missing)}")
        else:
            print(f"  {family:20} covers the sample")

    if problems:
        print("\nFAIL: a face in the stack cannot paint the sample:")
        for problem in problems:
            print(f"  {problem}")
        raise SystemExit(1)
    print("\nOK: the document face paints Vietnamese on its own, at every fallback.")


if __name__ == "__main__":
    main()
