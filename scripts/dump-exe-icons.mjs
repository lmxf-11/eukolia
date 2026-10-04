/**
 * Dump the RT_ICON image bytes embedded in a Windows PE file.
 *
 * Usage: node scripts/dump-exe-icons.mjs [exe] [outDir]
 *
 * `verify-exe-icon.mjs` only counts icon images, which cannot tell a correct icon
 * from a stale or default one. This extracts the actual bytes so they can be
 * hashed against the source .ico frames.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const target = process.argv[2] ?? 'release/win-unpacked/Eukolia.exe';
const outDir = process.argv[3] ?? '.scratch/exe-icons';
const buf = readFileSync(target);

if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file');
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
if (!rsrcOff) throw new Error('no resource directory');

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

const RT_ICON = 3;
const typeNode = readEntries(rsrcOff).find((t) => (t.id & 0x7fffffff) === RT_ICON && t.child & 0x80000000);
if (!typeNode) throw new Error('no RT_ICON resources — the exe carries no embedded icon at all');

const sha = (b) => createHash('sha256').update(b).digest('hex');
mkdirSync(outDir, { recursive: true });

console.log(`${target}\n`);
const embedded = [];
for (const nameEntry of readEntries(subdir(typeNode.child))) {
  if ((nameEntry.child & 0x80000000) === 0) continue;
  const iconId = nameEntry.id & 0x7fffffff;
  for (const langEntry of readEntries(subdir(nameEntry.child))) {
    if ((langEntry.child & 0x80000000) !== 0) continue;
    // Leaf: IMAGE_RESOURCE_DATA_ENTRY = { RVA, Size, Codepage, Reserved }
    const dataEntry = subdir(langEntry.child);
    const dataRva = buf.readUInt32LE(dataEntry);
    const dataSize = buf.readUInt32LE(dataEntry + 4);

    // Map that RVA to a file offset the same way as the resource section.
    let off = 0;
    for (let i = 0; i < numSections; i++) {
      const s = peOff + 24 + optSize + i * 40;
      const va = buf.readUInt32LE(s + 12);
      const vsize = buf.readUInt32LE(s + 8);
      const raw = buf.readUInt32LE(s + 20);
      if (dataRva >= va && dataRva < va + Math.max(vsize, 1)) {
        off = raw + (dataRva - va);
        break;
      }
    }
    const bytes = buf.subarray(off, off + dataSize);
    const png = bytes[0] === 0x89 && bytes[1] === 0x50;
    const h = sha(bytes);
    embedded.push({ iconId, size: dataSize, png, hash: h });
    writeFileSync(join(outDir, `rt_icon_${iconId}${png ? '.png' : '.dib'}`), bytes);
  }
}

embedded.sort((a, b) => a.iconId - b.iconId);
for (const e of embedded) {
  console.log(`  RT_ICON id=${String(e.iconId).padStart(3)}  ${String(e.size).padStart(7)} B  ${e.png ? 'PNG' : 'DIB'}  sha=${e.hash.slice(0, 32)}`);
}

// --- compare against the frames inside the source .ico ----------------------
const srcPath = 'assets/icon/icon.ico';
const src = readFileSync(srcPath);
const n = src.readUInt16LE(4);
const frames = [];
for (let i = 0; i < n; i++) {
  const o = 6 + i * 16;
  const w = src[o] === 0 ? 256 : src[o];
  const len = src.readUInt32LE(o + 8);
  const off = src.readUInt32LE(o + 12);
  frames.push({ size: w, bytes: src.subarray(off, off + len), hash: sha(src.subarray(off, off + len)) });
}

console.log(`\nsource ${srcPath}: ${n} frames`);
const srcHashes = new Set(frames.map((f) => f.hash));
const embeddedHashes = new Set(embedded.map((e) => e.hash));
const allMatch = frames.every((f) => embeddedHashes.has(f.hash));

console.log(`  source frames present in exe : ${frames.filter((f) => embeddedHashes.has(f.hash)).length}/${n}`);
console.log(`  exe images not from source   : ${embedded.filter((e) => !srcHashes.has(e.hash)).length}/${embedded.length}`);
console.log(allMatch && embedded.length === n
  ? '\nRESULT: every embedded icon byte-matches the source icon.'
  : '\nRESULT: embedded icon bytes DO NOT match the source icon.');
if (!allMatch) {
  console.log('\nper-frame:');
  for (const f of frames) console.log(`  ${String(f.size).padStart(3)}px source ${f.hash.slice(0,32)} ${embeddedHashes.has(f.hash) ? 'PRESENT' : 'MISSING'}`);
  for (const e of embedded) console.log(`  id=${String(e.iconId).padStart(3)} exe    ${e.hash.slice(0,32)} ${srcHashes.has(e.hash) ? 'matches source' : 'UNKNOWN'}`);
}
