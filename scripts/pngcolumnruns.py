"""Print the rows where each distinct colour begins and ends, down one column.

Used to find where a section of a page sits vertically, when a crop has to be taken
by coordinate and guessing has already cost a round.

    python scripts/pngcolumnruns.py <png> <x> [max]
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from pngread import read

path = sys.argv[1]
x = int(sys.argv[2])
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 40

width, height, rows = read(path)
print(f'{path}  {width}x{height}  column x={x}')

previous = None
runs = []
for y in range(height):
    r, g, b = rows[y][x][:3]
    value = f'#{r:02x}{g:02x}{b:02x}'
    if value != previous:
        runs.append([value, y, y])
    else:
        runs[-1][2] = y
    previous = value

for value, first, last in runs[:limit]:
    span = f'{first}..{last}' if last > first else f'{first}'
    print(f'   {value}   rows {span}')
