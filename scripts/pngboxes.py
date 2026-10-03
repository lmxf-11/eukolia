"""Report the bounding box of each distinct colour region in a PNG.

Guessing at crop coordinates costs more than measuring them. This prints, for every
colour that covers more than a handful of pixels, the rectangle it occupies — which
is enough to locate a bar, a divider and a panel in one pass, and to see whether a
region one expects to be there is missing.

    python scripts/pngboxes.py <png> [min_pixels]
"""
import sys
import os
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from pngread import read

path = sys.argv[1]
minimum = int(sys.argv[2]) if len(sys.argv) > 2 else 200

width, height, rows = read(path)

boxes = {}
counts = defaultdict(int)
for y in range(height):
    for x in range(width):
        r, g, b = rows[y][x][:3]
        key = f'#{r:02x}{g:02x}{b:02x}'
        counts[key] += 1
        box = boxes.get(key)
        if box is None:
            boxes[key] = [x, y, x, y]
        else:
            if x < box[0]:
                box[0] = x
            if y < box[1]:
                box[1] = y
            if x > box[2]:
                box[2] = x
            if y > box[3]:
                box[3] = y

print(f'{path}  {width}x{height}')
print(f'{"colour":10} {"pixels":>8}  box (x0,y0)-(x1,y1)   size')
for key, count in sorted(counts.items(), key=lambda item: -item[1]):
    if count < minimum:
        continue
    x0, y0, x1, y1 = boxes[key]
    print(f'{key:10} {count:>8}  ({x0:>4},{y0:>4})-({x1:>4},{y1:>4})  {x1 - x0 + 1}x{y1 - y0 + 1}')
