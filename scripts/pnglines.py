"""Report the horizontal line a column of a PNG draws, as a run of pixels.

Asking "is there a seam between these two surfaces" is asking whether a row of
pixels differs from the rows around it, and at one pixel tall that is not a
question the eye answers reliably. This prints, for one column, every row whose
colour differs from the row above it — so a divider shows up as one entry and a
continuous surface shows up as none.

    python scripts/pnglines.py <png> <x> [y0] [y1]
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from pngread import read

path = sys.argv[1]
x = int(sys.argv[2])
y0 = int(sys.argv[3]) if len(sys.argv) > 3 else 0
y1 = int(sys.argv[4]) if len(sys.argv) > 4 else 200

width, height, rows = read(path)
print(f'{path}  {width}x{height}  column x={x}')

previous = None
runs = []
for y in range(max(0, y0), min(height, y1)):
    r, g, b = rows[y][x][:3]
    value = f'#{r:02x}{g:02x}{b:02x}'
    if value != previous:
        runs.append([value, y, y])
    else:
        runs[-1][2] = y
    previous = value

for value, first, last in runs:
    span = f'{first}-{last}' if last > first else f'{first}'
    print(f'  {value}  rows {span}')
