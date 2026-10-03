"""Report the pixels of one column of a PNG, top to bottom.

Used to answer a question a screenshot cannot be asked by eye: is there a
horizontal line, or a band of a different surface, in the few pixels where the
tab strip meets the editor.

    python scripts/pngcolumn.py <png> <x> [y0] [y1]
"""
import sys
sys.path.insert(0, __import__('os').path.dirname(__file__))
from pngread import read

path, x = sys.argv[1], int(sys.argv[2])
y0 = int(sys.argv[3]) if len(sys.argv) > 3 else 0
y1 = int(sys.argv[4]) if len(sys.argv) > 4 else 60

width, height, rows = read(path)
print(f'{path}  {width}x{height}  column x={x}')
previous = None
for y in range(max(0, y0), min(height, y1)):
    r, g, b = rows[y][x][:3]
    value = f'#{r:02x}{g:02x}{b:02x}'
    marker = '   <-- boundary' if previous is not None and value != previous else ''
    print(f'  y={y:3d}  {value}{marker}')
    previous = value
