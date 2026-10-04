/**
 * Inspect the icon resources embedded in a Windows PE file.
 *
 * Usage: node scripts/verify-exe-icon.mjs [path/to/app.exe]
 *
 * `npm run pack` (electron-builder --dir) applies the app icon with rcedit, which
 * rewrites the PE resource section. Nothing in the build output states whether
 * that succeeded, so this walks the PE resource directory and reports the icon
 * group / icon image counts — a single RT_ICON means only one size would be
 * available and Windows would be downscaling it everywhere.
 */
import { readFileSync } from 'node:fs';

const target = process.argv[2] ?? 'release/win-unpacked/Eukolia.exe';
const buf = readFileSync(target);

// --- locate the PE header and the resource data directory --------------------
if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file (missing MZ)');
const peOff = buf.readUInt32LE(0x3c);
if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('not a PE file (missing PE\\0\\0)');

const numSections = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const magic = buf.readUInt16LE(peOff + 24);
const is64 = magic === 0x20b;
const ddOff = peOff + 24 + (is64 ? 112 : 96);

// Data directory index 2 is the resource table.
const rsrcRva = buf.readUInt32LE(ddOff + 2 * 8);
const rsrcSize = buf.readUInt32LE(ddOff + 2 * 8 + 4);
if (rsrcRva === 0) throw new Error('no resource directory — no icon was embedded');
console.log(`${target}: ${is64 ? 'PE32+' : 'PE32'}, ${numSections} sections`);
console.log(`resource directory: rva=0x${rsrcRva.toString(16)} size=${rsrcSize}`);

// Map the resource RVA to a file offset via the section table.
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
if (!rsrcOff) throw new Error('could not map the resource RVA to a file offset');

// --- walk the resource directory tree ---------------------------------------
// Each node has a 16-byte header followed by (named + id) 8-byte entries.
// Bit 31 of an entry's name/id marks a subdirectory rather than leaf data.
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
function subdir(fileOff) {
  return rsrcOff + (fileOff & 0x7fffffff);
}

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

/** Count the leaf (language) entries beneath a type node. */
function countLeaves(typeNodeOff) {
  let leaves = 0;
  for (const nameEntry of readEntries(typeNodeOff)) {
    if ((nameEntry.child & 0x80000000) === 0) continue;
    const langDir = subdir(nameEntry.child);
    for (const langEntry of readEntries(langDir)) {
      if ((langEntry.child & 0x80000000) !== 0) continue;
      leaves++;
    }
  }
  return leaves;
}

const found = new Map();
for (const typeEntry of readEntries(rsrcOff)) {
  if ((typeEntry.child & 0x80000000) === 0) continue;
  found.set(typeEntry.id & 0x7fffffff, subdir(typeEntry.child));
}

const iconImages = found.has(RT_ICON) ? countLeaves(found.get(RT_ICON)) : 0;
const iconGroups = found.has(RT_GROUP_ICON) ? countLeaves(found.get(RT_GROUP_ICON)) : 0;

console.log(`RT_ICON images     : ${iconImages}`);
console.log(`RT_GROUP_ICON groups: ${iconGroups}`);
console.log(
  iconImages === 0
    ? 'RESULT: no icon embedded — the exe still carries the Electron default'
    : `RESULT: icon embedded with ${iconImages} image(s)`
);

// A single image is the failure this check exists to catch.
if (iconImages <= 1) {
  console.log('WARNING: only one icon size is embedded; Windows will downscale it for every other slot.');
}
