/**
 * Parse the RT_GROUP_ICON directory embedded in a Windows PE file.
 *
 * Usage: node scripts/dump-group-icon.mjs [exe]
 *
 * RT_ICON holds the individual images, but the shell picks which one to draw by
 * reading RT_GROUP_ICON. If that directory is wrong — entries swapped, a
 * dimension written incorrectly, or a frame listed twice — Explorer gives up and
 * falls back to the framework's default icon, even though every image is present
 * and correct. This prints the directory as the shell sees it so it can be
 * compared against the source .ico.
 *
 * GRPICONDIRENTRY layout (14 bytes, little-endian):
 *   width(1) height(1) colours(1) reserved(1) planes(2) bitCount(2) bytes(4) id(2)
 */
import { readFileSync } from 'node:fs';

const target = process.argv[2] ?? 'release/win-unpacked/Eukolia.exe';
const buf = readFileSync(target);

const peOff = buf.readUInt32LE(0x3c);
const numSections = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const is64 = buf.readUInt16LE(peOff + 24) === 0x20b;
const ddOff = peOff + 24 + (is64 ? 112 : 96);
const rsrcRva = buf.readUInt32LE(ddOff + 2 * 8);

let rsrcOff = 0;
for (let i = 0; i < numSections; i++) {
  const s = peOff + 24 + optSize + i * 40;
  const va = buf.readUInt32LE(s + 12);
  const vsize = buf.readUInt32LE(s + 8);
  const raw = buf.readUInt32LE(s + 20);
  if (rsrcRva >= va && rsrcRva < va + Math.max(vsize, 1)) {
    rsrcOff = raw + (rsrcRva - va);
    break;
  }
}
function readEntries(dirFileOff) {
  const named = buf.readUInt16LE(dirFileOff + 12);
  const ided = buf.readUInt16LE(dirFileOff + 14);
  const out = [];
  for (let i = 0; i < named + ided; i++) {
    const e = dirFileOff + 16 + i * 8;
    out.push({ id: buf.readUInt32LE(e), child: buf.readUInt32LE(e + 4) });
  }
  return out;
}
const subdir = (off) => rsrcOff + (off & 0x7fffffff);
function rvaToOffset(rva) {
  for (let i = 0; i < numSections; i++) {
    const s = peOff + 24 + optSize + i * 40;
    const va = buf.readUInt32LE(s + 12);
    const vsize = buf.readUInt32LE(s + 8);
    const raw = buf.readUInt32LE(s + 20);
    if (rva >= va && rva < va + Math.max(vsize, 1)) return raw + (rva - va);
  }
  return 0;
}

const groupNode = readEntries(rsrcOff).find((t) => (t.id & 0x7fffffff) === 14 && t.child & 0x80000000);
if (!groupNode) throw new Error('no RT_GROUP_ICON — the shell has no icon directory and will use the default');

for (const nameEntry of readEntries(subdir(groupNode.child))) {
  if ((nameEntry.child & 0x80000000) === 0) continue;
  for (const langEntry of readEntries(subdir(nameEntry.child))) {
    if ((langEntry.child & 0x80000000) !== 0) continue;
    const dataEntry = subdir(langEntry.child);
    const dataRva = buf.readUInt32LE(dataEntry);
    const dataSize = buf.readUInt32LE(dataEntry + 4);
    const off = rvaToOffset(dataRva);
    const g = buf.subarray(off, off + dataSize);

    // GRPICONDIR: reserved(2) type(2) count(2)
    const reserved = g.readUInt16LE(0);
    const type = g.readUInt16LE(2);
    const count = g.readUInt16LE(4);
    const expectedSize = 6 + 14 * count;
    console.log(`RT_GROUP_ICON id=${nameEntry.id & 0x7fffffff}  resource size=${dataSize} B`);
    console.log(`  reserved=${reserved} (expect 0)  type=${type} (expect 1=icon)  count=${count}`);
    console.log(`  directory is ${dataSize === expectedSize ? 'well-formed' : `MALFORMED: ${dataSize} != ${expectedSize} (6 + 14*count)`}`);

    const declared = [];
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 14;
      const w = g[o] === 0 ? 256 : g[o];
      const h = g[o + 1] === 0 ? 256 : g[o + 1];
      const planes = g.readUInt16LE(o + 4);
      const bits = g.readUInt16LE(o + 6);
      const bytes = g.readUInt32LE(o + 8);
      const id = g.readUInt16LE(o + 12);
      declared.push({ w, h, planes, bits, bytes, id });
      console.log(`    [${i}] ${String(w).padStart(3)}x${String(h).padEnd(3)} ${bits}bpp planes=${planes} bytes=${String(bytes).padStart(7)} -> RT_ICON id=${id}`);
    }

    // Cross-check the declared payload sizes against the real RT_ICON resources.
    const iconNode = readEntries(rsrcOff).find((t) => (t.id & 0x7fffffff) === 3 && t.child & 0x80000000);
    const actual = new Map();
    for (const ne of readEntries(subdir(iconNode.child))) {
      if ((ne.child & 0x80000000) === 0) continue;
      for (const le of readEntries(subdir(ne.child))) {
        if ((le.child & 0x80000000) !== 0) continue;
        const de = subdir(le.child);
        actual.set(ne.id & 0x7fffffff, buf.readUInt32LE(de + 4));
      }
    }
    let problems = 0;
    for (const d of declared) {
      const real = actual.get(d.id);
      if (real === undefined) { console.log(`    !! id=${d.id} is not a real RT_ICON resource`); problems++; }
      else if (real !== d.bytes) { console.log(`    !! id=${d.id} declares ${d.bytes} B but the resource is ${real} B`); problems++; }
    }
    const ids = declared.map((d) => d.id);
    if (new Set(ids).size !== ids.length) { console.log('    !! duplicate RT_ICON id in the directory'); problems++; }

    // The shell expects descending dimensions.
    const dims = declared.map((d) => d.w);
    const sorted = [...dims].sort((a, b) => b - a);
    if (dims.join(',') !== sorted.join(',')) {
      console.log(`    !! dimensions not in descending order: [${dims.join(', ')}]`); problems++;
    }

    console.log(problems === 0
      ? '\n  RESULT: RT_GROUP_ICON is consistent with the RT_ICON resources.'
      : `\n  RESULT: ${problems} problem(s) in RT_GROUP_ICON — the shell may fall back to the default icon.`);
  }
}
