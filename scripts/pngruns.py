"""Find the runs of a single colour along one row, with their widths.

Reading a whole row of 1800 pixels one run at a time buries the thing being looked for.
This filters the runs down to those of a colour of interest, which is how a tab's edges
and the gap between two tabs become visible at a glance.

    python scripts/pngruns.py <png> <y> <hex> [min_width]
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from pngread import read

path = sys.argv[1]
y = int(sys.argv[2])
fill = sys.argv[3].lstrip('#').lower()
minimum = int(sys.argv[4]) if len(sys.argv) > 4 else 2

target = (int(fill[0:2], 16), int(fill[2:4], 16), int(fill[4:6], 16))

width, height, rows = read(path)
if y >= height:
    print(f'row {y} is past the bottom ({height})')
    sys.exit(0)

runs = []
previous = None
for x in range(width):
    r, g, b = rows[y][x][:3]
    match = abs(r - target[0]) <= 1 and abs(g - target[1]) <= 1 and abs(b - target[2]) <= 1
    if match and previous == 'match':
        runs[-1][1] = x
    elif match:
        runs.append([x, x])
    previous = 'match' if match else 'other'

print(f'{path}  row {y}  runs of #{fill} wider than {minimum}px:')
for first, last in runs:
    if last - first + 1 >= minimum:
        print(f'   x {first:>5} .. {last:>5}   width {last - first + 1}')
if not runs:
    print('   none')
