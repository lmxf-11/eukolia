"""Crop a region of a PNG and enlarge it, writing the result."""
import sys
import zlib
import struct

src, dst, x, y, w, h, scale = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7])
sys.path.insert(0, "scripts")
from pngread import read

width, height, rows = read(src)
x = max(0, min(x, width - 1))
y = max(0, min(y, height - 1))
w = max(1, min(w, width - x))
h = max(1, min(h, height - y))

out = bytearray()
for row in range(h):
    source = rows[y + row]
    line = bytearray()
    for column in range(w):
        pixel = source[x + column]
        line.extend(bytes(pixel[:3]) * scale)
    for _ in range(scale):
        out.append(0)
        out.extend(line)

def chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", w * scale, h * scale, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(bytes(out), 9))
png += chunk(b"IEND", b"")
open(dst, "wb").write(png)
print(f"{dst}  {w * scale}x{h * scale}  (from {w}x{h} at {x},{y}, x{scale})")
