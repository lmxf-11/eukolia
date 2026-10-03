/**
 * Magnify a region of the running application's own window.
 *
 * The harness renders a page in a window it controls, which is the right tool for a
 * shape that can be isolated — and the wrong one for a corner whose geometry comes
 * from the component's inline styles, the stylesheet and the live theme together.
 * This takes the running window's own screenshot and enlarges a region of it, so
 * what is inspected is the application rather than a reconstruction of it.
 *
 * Region coordinates are device pixels, which is what `pngscan.py` reports.
 *
 * Usage: node scripts/probe-zoom.mjs <x> <y> <w> <h> [scale] [out.png]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

const x = Number(process.argv[2] ?? 0);
const y = Number(process.argv[3] ?? 0);
const width = Number(process.argv[4] ?? 200);
const height = Number(process.argv[5] ?? 100);
const scale = Number(process.argv[6] ?? 6);
const out = path.resolve(projectRoot, process.argv[7] ?? '.scratch/zoom.png');

const source = path.join(projectRoot, '.scratch', 'tabjoin-live.png');
if (!fs.existsSync(source)) {
  console.error('no live screenshot; run: node scripts/probe-tabjoin.mjs');
  process.exit(2);
}

/*
 * The crop is taken from the PNG the probe already wrote, rather than from a second
 * capture, so the magnified region and the rows `pngscan.py` reports are the same
 * image.
 */
const { execFileSync } = await import('node:child_process');
const script = path.join(projectRoot, 'scripts', 'crop_zoom.py');
fs.writeFileSync(
  script,
  [
    '"""Crop a region of a PNG and enlarge it, writing the result."""',
    'import sys',
    'import zlib',
    'import struct',
    '',
    'src, dst, x, y, w, h, scale = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7])',
    'sys.path.insert(0, "scripts")',
    'from pngread import read',
    '',
    'width, height, rows = read(src)',
    'x = max(0, min(x, width - 1))',
    'y = max(0, min(y, height - 1))',
    'w = max(1, min(w, width - x))',
    'h = max(1, min(h, height - y))',
    '',
    'out = bytearray()',
    'for row in range(h):',
    '    source = rows[y + row]',
    '    line = bytearray()',
    '    for column in range(w):',
    '        pixel = source[x + column]',
    '        line.extend(bytes(pixel[:3]) * scale)',
    '    for _ in range(scale):',
    '        out.append(0)',
    '        out.extend(line)',
    '',
    'def chunk(tag, data):',
    '    body = tag + data',
    '    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)',
    '',
    'png = b"\\x89PNG\\r\\n\\x1a\\n"',
    'png += chunk(b"IHDR", struct.pack(">IIBBBBB", w * scale, h * scale, 8, 2, 0, 0, 0))',
    'png += chunk(b"IDAT", zlib.compress(bytes(out), 9))',
    'png += chunk(b"IEND", b"")',
    'open(dst, "wb").write(png)',
    'print(f"{dst}  {w * scale}x{h * scale}  (from {w}x{h} at {x},{y}, x{scale})")',
    ''
  ].join('\n'),
  'utf8'
);

const result = execFileSync('python', [script, source, out, String(x), String(y), String(width), String(height), String(scale)], {
  cwd: projectRoot,
  encoding: 'utf8'
});
process.stdout.write(result);
