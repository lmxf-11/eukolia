"""Report the colour runs along one row of a PNG.

A seam is a run of one colour in a row that should not have it, and the useful
question is not "is it there" but "where does it start and stop" — a run that
begins at the tab strip's right edge is chrome, one that begins at the window's
left edge is the app, and the two have different causes.

    python scripts/pngrow.py <png> <y> [max_runs]
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from pngread import read

path = sys.argv[1]
y = int(sys.argv[2])
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 30

width, height, rows = read(path)
if y >= height:
    print(f'row {y} is past the bottom ({height})')
    sys.exit(0)

runs = []
previous = None
for x in range(width):
    r, g, b = rows[y][x][:3]
    value = f'#{r:02x}{g:02x}{b:02x}'
    if value != previous:
        runs.append([value, x, x])
    else:
        runs[-1][2] = x
    previous = value

print(f'{path}  {width}x{height}  row {y}: {len(runs)} colour runs')
for value, first, last in runs[:limit]:
    span = f'{first}..{last}' if last > first else f'{first}'
    print(f'   {value}   x {span}')
