"""Trace the outline of a shape drawn on a transparent background.

Given a PNG whose ink is dark and whose background is the checkerboard, report for
each row the leftmost and rightmost inked pixel. That turns a drawing of a curve into
numbers, which is the only way to compare two curves rather than describe them.

    python scripts/pngtrace.py <png> [threshold] [min_run]
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from pngread import read

path = sys.argv[1]
threshold = int(sys.argv[2]) if len(sys.argv) > 2 else 120
minimum = int(sys.argv[3]) if len(sys.argv) > 3 else 2

width, height, rows = read(path)

print(f'{path}  {width}x{height}   (ink = any channel sum/3 below {threshold})')
print(f'{"row":>5} {"left":>6} {"right":>6}  {"width":>6}')
for y in range(height):
    inked = [x for x in range(width) if sum(rows[y][x][:3]) / 3 < threshold]
    if len(inked) < minimum:
        continue
    print(f'{y:>5} {inked[0]:>6} {inked[-1]:>6}  {inked[-1] - inked[0] + 1:>6}')
