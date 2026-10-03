"""Profile a corner: for each column, the row where the tab's fill begins.

The shape of a corner is a function, not a colour: for every column across it, the
row at which the tab's surface starts. Printing that for two screenshots makes the two
curves directly comparable, which reading colour runs does not.

    python scripts/pngcorner.py <png> <x0> <y_top> <y_bottom> <columns> <fill_hex>
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from pngread import read

path = sys.argv[1]
x0 = int(sys.argv[2])
y_top = int(sys.argv[3])
y_bottom = int(sys.argv[4])
columns = int(sys.argv[5])
fill = sys.argv[6].lstrip('#').lower()

target = (int(fill[0:2], 16), int(fill[2:4], 16), int(fill[4:6], 16))

width, height, rows = read(path)
print(f'{path}  fill #{fill}   columns {x0}..{x0 + columns - 1}')
print(f'{"col":>5}  {"first row at fill":>18}  {"offset from bottom":>18}')
for x in range(x0, min(x0 + columns, width)):
    found = None
    for y in range(y_top, min(y_bottom, height)):
        r, g, b = rows[y][x][:3]
        if abs(r - target[0]) <= 2 and abs(g - target[1]) <= 2 and abs(b - target[2]) <= 2:
            found = y
            break
    if found is None:
        print(f'{x:>5}  {"-":>18}')
    else:
        print(f'{x:>5}  {found:>18}  {y_bottom - found:>18}')
