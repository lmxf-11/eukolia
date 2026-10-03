"""Obsidian's tab corner and Eukolia's, side by side, enlarged.

Both crops are taken at the same device-pixel scale from screenshots of the two
applications at the same display ratio (1.25), and both are anchored on the active
tab's bottom-left corner, so what differs is the shape and not the sampling.

    python scripts/corner_compare.py
"""
import zlib
import struct
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

from pngread import read  # noqa: E402

SCALE = 14
WIDTH = 26
HEIGHT = 18
GAP = 1


def crop(path, x, y):
    _, _, rows = read(path)
    return [[rows[y + row][x + column][:3] for column in range(WIDTH)] for row in range(HEIGHT)]


# Obsidian: active tab's bottom-left corner. Its edge is at device x=885, bottom y=50.
obsidian = crop('.scratch/obsidian-window.png', 885 - 20, 50 - 12)
# Eukolia: active tab's edge at device x=506, bottom y=48.
eukolia = crop('.scratch/tabjoin-live.png', 506 - 20, 48 - 12)

separator = [(255, 0, 255)] * HEIGHT
combined = [obsidian[row] + separator + eukolia[row] for row in range(HEIGHT)]

body = bytearray()
for row in combined:
    line = bytearray()
    for pixel in row:
        line.extend(bytes(pixel) * SCALE)
    for _ in range(SCALE):
        body.append(0)
        body.extend(line)


def chunk(tag, data):
    payload = tag + data
    return struct.pack('>I', len(data)) + payload + struct.pack('>I', zlib.crc32(payload) & 0xFFFFFFFF)


png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', (WIDTH * 2 + GAP) * SCALE, HEIGHT * SCALE, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(bytes(body), 9))
png += chunk(b'IEND', b'')
with open('.scratch/corner-compare.png', 'wb') as handle:
    handle.write(png)

print(f".scratch/corner-compare.png  {(WIDTH * 2 + GAP) * SCALE}x{HEIGHT * SCALE}  (left: Obsidian, right: Eukolia, x{SCALE})")
