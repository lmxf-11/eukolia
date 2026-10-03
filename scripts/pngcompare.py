"""Put two regions of two PNGs side by side, enlarged, with a separator.

Comparing shapes by reading colour runs works until the difference is one of
smoothness rather than of geometry, and then it has to be looked at. This crops the
same-size region from each image and stacks them, so the two are under the same light.

    python scripts/pngcompare.py <a.png> <ax> <ay> <w> <h> <b.png> <bx> <by> <scale> <out.png>
"""
import sys
import zlib
import struct
import os

sys.path.insert(0, os.path.dirname(__file__))
from pngread import read

a_path, ax, ay, w, h, b_path, bx, by, scale, out = (
    sys.argv[1],
    int(sys.argv[2]),
    int(sys.argv[3]),
    int(sys.argv[4]),
    int(sys.argv[5]),
    sys.argv[6],
    int(sys.argv[7]),
    int(sys.argv[8]),
    int(sys.argv[9]),
    sys.argv[10],
)


def crop(path, x, y, width, height):
    _, _, rows = read(path)
    return [[rows[y + row][x + column][:3] for column in range(width)] for row in range(height)]


a = crop(a_path, ax, ay, w, h)
b = crop(b_path, bx, by, w, h)

# A one-pixel magenta column between them, so where one ends is unmistakable.
separator = [(255, 0, 255)] * h
combined = [a[row] + separator + b[row] for row in range(h)]

out_rows = bytearray()
for row in combined:
    line = bytearray()
    for pixel in row:
        line.extend(bytes(pixel) * scale)
    for _ in range(scale):
        out_rows.append(0)
        out_rows.extend(line)

total_width = (w * 2 + 1) * scale
total_height = h * scale


def chunk(tag, data):
    body = tag + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)


png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', total_width, total_height, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(bytes(out_rows), 9))
png += chunk(b'IEND', b'')
open(out, 'wb').write(png)
print(f'{out}  {total_width}x{total_height}  (left: {a_path}, right: {b_path}, x{scale})')
