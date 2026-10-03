"""Report every row of a PNG that differs from the row above it, across a range of columns.

A seam between two surfaces is a row that differs from its neighbours, and what
matters is not just *whether* such a row exists but *where it stops*: a divider
that runs under the selected tab is a different defect from one that stops at it.
So this samples several columns at once and reports, per column, the boundaries it
finds.

    python scripts/pngscan.py <png> <y0> <y1> <x1> [x2] [x3] ...
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from pngread import read

path = sys.argv[1]
y0 = int(sys.argv[2])
y1 = int(sys.argv[3])
columns = [int(value) for value in sys.argv[4:]]

width, height, rows = read(path)
print(f'{path}  {width}x{height}  rows {y0}-{y1}')

for x in columns:
    if x >= width:
        print(f'  x={x}: past the right edge')
        continue
    changes = []
    previous = None
    for y in range(y0, min(y1, height)):
        r, g, b = rows[y][x][:3]
        value = f'#{r:02x}{g:02x}{b:02x}'
        if value != previous:
            changes.append(f'{y}:{value}')
        previous = value
    print(f'  x={x:<5} {"  ".join(changes)}')
