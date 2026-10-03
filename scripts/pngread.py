"""Read a PNG without any imaging dependency.

Pillow is not installed in this environment and the comparison here is small, so
the few filters a Chromium or Electron encoder actually emits are undone by hand.
`zlib` and `struct` are in the standard library.
"""

import struct
import zlib


def read(path):
    """Return (width, height, rows) with rows as bytearray RGBA tuples."""
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path}: not a PNG")

    pos = 8
    header = None
    palette = None
    chunks = []
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"PLTE":
            palette = [tuple(body[i : i + 3]) for i in range(0, len(body), 3)]
        elif kind == b"IDAT":
            chunks.append(body)
        elif kind == b"IEND":
            break

    width, height, depth, colour, _, _, interlace = header
    if depth != 8 or interlace != 0:
        raise ValueError(f"{path}: unsupported depth={depth} interlace={interlace}")

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colour]
    raw = zlib.decompress(b"".join(chunks))

    stride = width * channels
    rows = []
    previous = bytearray(stride)
    at = 0
    for _ in range(height):
        filter_kind = raw[at]
        at += 1
        line = bytearray(raw[at : at + stride])
        at += stride
        if filter_kind == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif filter_kind == 2:
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 0xFF
        elif filter_kind == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif filter_kind == 4:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                up = previous[i]
                upleft = previous[i - channels] if i >= channels else 0
                estimate = left + up - upleft
                pa, pb, pc = abs(estimate - left), abs(estimate - up), abs(estimate - upleft)
                nearest = left if (pa <= pb and pa <= pc) else (up if pb <= pc else upleft)
                line[i] = (line[i] + nearest) & 0xFF
        elif filter_kind != 0:
            raise ValueError(f"{path}: unknown filter {filter_kind}")
        rows.append(bytes(line))
        previous = line

    def pixels(row):
        out = []
        for i in range(0, len(row), channels):
            if colour == 6:
                out.append((row[i], row[i + 1], row[i + 2], row[i + 3]))
            elif colour == 2:
                out.append((row[i], row[i + 1], row[i + 2], 255))
            elif colour == 0:
                value = row[i]
                out.append((value, value, value, 255))
            elif colour == 4:
                value = row[i]
                out.append((value, value, value, row[i + 1]))
            else:
                index = row[i]
                if index < len(palette):
                    r, g, b = palette[index]
                else:
                    r = g = b = 0
                out.append((r, g, b, 255))
        return out

    return width, height, [pixels(row) for row in rows]


def ink_columns(rows, background=None, threshold=40):
    """Per-column ink height, using distance from the background colour.

    The background is taken from the top-left pixel unless one is given, which is
    what makes this work on both the dark editor and the transparent canvas.
    """
    if background is None:
        background = rows[0][0]
    height = len(rows)
    width = len(rows[0]) if height else 0
    columns = []
    for x in range(width):
        count = 0
        for y in range(height):
            pixel = rows[y][x]
            if abs(pixel[0] - background[0]) + abs(pixel[1] - background[1]) + abs(
                pixel[2] - background[2]
            ) > threshold:
                count += 1
        columns.append(count)
    return columns


def ink_boxes(rows, background=None, threshold=40, gap=2):
    """Group inked columns into boxes, so a word can be compared piece by piece."""
    columns = ink_columns(rows, background, threshold)
    boxes = []
    start = None
    blank = 0
    for x, count in enumerate(columns):
        if count:
            if start is None:
                start = x
            blank = 0
        elif start is not None:
            blank += 1
            if blank > gap:
                boxes.append((start, x - blank))
                start = None
    if start is not None:
        boxes.append((start, len(columns) - 1))

    out = []
    for left, right in boxes:
        top = len(rows)
        bottom = -1
        for x in range(left, right + 1):
            for y in range(len(rows)):
                pixel = rows[y][x]
                base = background if background is not None else rows[0][0]
                if abs(pixel[0] - base[0]) + abs(pixel[1] - base[1]) + abs(pixel[2] - base[2]) > threshold:
                    top = min(top, y)
                    bottom = max(bottom, y)
        if bottom >= 0:
            out.append((left, top, right, bottom))
    return out
